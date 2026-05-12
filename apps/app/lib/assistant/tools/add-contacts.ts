import 'server-only';
import { z } from 'zod';
import {
  defineTool,
  insertContactRow,
  type CreateContactPayload,
} from '@procur/ai';

/**
 * Auto-add a batch of new contacts to the CRM WITHOUT operator
 * approval. Sibling of `add_known_entities` for the people side of
 * the search → add workflow.
 *
 * Why no approval gate:
 *   - Contacts are CRUD rows; reversible by delete or archive
 *   - Downstream outreach (propose_email_send, propose_sms_send,
 *     propose_outbound_call, submit_lead_form) still has Tier-2/Tier-3
 *     approval gates — auto-adding to the CRM does NOT bypass those
 *   - The per-contact propose flow with N approval clicks for a
 *     "found 6 decision-makers" workflow was the friction the operator
 *     called out
 *
 * Categorization discipline (per operator: "categorization is very
 * important to reduce noise and improve accuracy"):
 *   - `function` is a strict enum routing the contact into a
 *     filterable bucket (decision_maker / procurement / commercial /
 *     technical / executive / finance / legal / logistics / other).
 *     Auto-tagged onto the contact as `function:<value>`.
 *   - `title` is the verbatim job title from the source (free-form
 *     since titles are inherently varied).
 *   - Each contact MUST link to at least one org via knownEntitySlug
 *     (rolodex entity — preferred) OR orgId (existing CRM org ULID).
 *     Pure orphan contacts not allowed.
 *   - Auto-tagged with `chat-auto-curated` for filter / mass-delete.
 *
 * Dedup discipline: skip insert when an active contact with the same
 * fullName already exists at the same primary org. Returns the
 * existing contactId so the model can surface "already in CRM at
 * /contacts/{id}". The contacts table has no name-unique constraint
 * at the DB level — dedup is app-side, by design (same person
 * legitimately appears at sister companies).
 *
 * Return shape: { added, skippedDuplicates, errors }.
 *
 * Use `propose_create_contact` (singular, approval-gated) only when
 * the operator explicitly asks for a review step.
 */

const FUNCTION_VALUES = [
  'decision_maker',
  'procurement',
  'commercial',
  'technical',
  'executive',
  'finance',
  'legal',
  'logistics',
  'operations',
  'other',
] as const;

const contactSchema = z.object({
  fullName: z
    .string()
    .min(2)
    .max(200)
    .describe('Verbatim legal/professional name as given in the source.'),
  function: z
    .enum(FUNCTION_VALUES)
    .describe(
      "Function bucket — STRICT enum. 'decision_maker' for director-" +
        "level+ who can sign. 'procurement' for procurement-specific " +
        "ops. 'commercial' for sales/trading. 'technical' for " +
        "engineering/ops. 'executive' for C-suite. 'finance', 'legal', " +
        "'logistics', 'operations' as labeled. 'other' only when no " +
        'listed function fits — explain in the chat reply, not as a ' +
        'tag.',
    ),
  title: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Verbatim job title from the source (free-form). Example: ' +
        '"Director of Procurement", "Chief Supply Chain Officer", ' +
        '"VP of Commercial Operations". Preserve original capitalization.',
    ),
  emails: z
    .array(z.string().email())
    .max(10)
    .optional()
    .describe(
      'Verified emails only. NEVER pattern-guess (procurement@<domain>, ' +
        'compras@<domain>) — those are catch-alls and almost always wrong. ' +
        'If the source did not publish an email, leave empty.',
    ),
  phones: z
    .array(z.string().max(40))
    .max(10)
    .optional()
    .describe('Phone numbers as published in the source.'),
  orgs: z
    .array(
      z
        .object({
          orgId: z
            .string()
            .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
            .optional()
            .describe(
              'Existing CRM org ULID (26 chars). Pull verbatim from a ' +
                'prior tool result; NEVER pass a slug here.',
            ),
          knownEntitySlug: z
            .string()
            .optional()
            .describe(
              "Rolodex entity slug — preferred over orgId when the " +
                "contact's company is in known_entities. The executor " +
                'creates the shadow CRM org if one does not yet exist.',
            ),
          role: z
            .string()
            .max(200)
            .optional()
            .describe(
              'Role at THIS org (multi-org contacts can have different ' +
                'roles per company). Defaults to title.',
            ),
          isPrimary: z
            .boolean()
            .optional()
            .describe(
              'Mark exactly one link primary. First link becomes primary ' +
                'when none flagged.',
            ),
        })
        .refine((v) => Boolean(v.orgId) || Boolean(v.knownEntitySlug), {
          message: 'each org link needs orgId or knownEntitySlug',
        }),
    )
    .min(1)
    .max(5)
    .describe(
      "Required. Every contact links to at least one org. Prefer " +
        'knownEntitySlug when the company is in the rolodex.',
    ),
});

const inputSchema = z.object({
  contacts: z
    .array(contactSchema)
    .min(1)
    .max(25)
    .describe(
      'Batch of contacts to auto-add. Max 25 per call. Each contact ' +
        'requires fullName + function + at least one org link.',
    ),
});

export const addContactsTool = defineTool({
  name: 'add_contacts',
  description:
    'AUTO-ADD a batch of new contacts (people at companies) directly ' +
    'to the CRM — no approval card, no click. Use for the search→add ' +
    'workflow: when Apollo people-search / GAIN extraction / web ' +
    'discovery surfaces decision-makers at counterparty companies and ' +
    'the operator wants them tracked. Each contact needs fullName + ' +
    'function (strict enum) + at least one org link (prefer ' +
    'knownEntitySlug when the company is in the rolodex).\n\n' +
    'PREFER THIS over propose_create_contact for routine adds. Reserve ' +
    'propose_create_contact for cases where the operator explicitly ' +
    'says they want a review step before persisting.\n\n' +
    'Dedup: an active contact with the same fullName at the same ' +
    'primary org is treated as duplicate and skipped — the existing ' +
    "contactId is returned so the model can surface 'already in CRM'.\n\n" +
    'Outreach to auto-added contacts still uses the existing approval ' +
    'gates (propose_email_send, propose_sms_send, propose_outbound_call, ' +
    "submit_lead_form) — auto-adding here doesn't bypass those.\n\n" +
    'Returns { added, skippedDuplicates, errors }. Surface this back ' +
    'to the operator tightly: "Added 5 contacts; 1 already in CRM."',
  kind: 'read',
  schema: inputSchema,
  handler: async (_ctx, args) => {
    const added: Array<{
      contactId: string;
      fullName: string;
      function: string;
    }> = [];
    const skippedDuplicates: Array<{
      contactId: string;
      fullName: string;
    }> = [];
    const errors: Array<{ fullName: string; error: string }> = [];

    for (const contact of args.contacts) {
      const tags = ['chat-auto-curated', `function:${contact.function}`];
      const payload: CreateContactPayload = {
        fullName: contact.fullName,
        orgs: contact.orgs,
        rationale: 'auto-added from chat search workflow',
        ...(contact.title ? { title: contact.title } : {}),
        ...(contact.emails ? { emails: contact.emails } : {}),
        ...(contact.phones ? { phones: contact.phones } : {}),
      };

      const result = await insertContactRow(payload, {
        dedupBy: 'fullNameAndPrimaryOrg',
        tags,
      });
      if (!result.ok) {
        errors.push({ fullName: contact.fullName, error: result.error });
        continue;
      }
      if (result.dedupedAgainstExisting) {
        skippedDuplicates.push({
          contactId: result.dedupedAgainstExisting.contactId,
          fullName: contact.fullName,
        });
      } else {
        added.push({
          contactId: result.contactId,
          fullName: contact.fullName,
          function: contact.function,
        });
      }
    }

    return {
      added,
      skippedDuplicates,
      errors,
      summary: {
        addedCount: added.length,
        skippedCount: skippedDuplicates.length,
        errorCount: errors.length,
      },
    };
  },
});
