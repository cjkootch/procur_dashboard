import { desc, eq } from 'drizzle-orm';
import { db, messages } from '@procur/db';
import { getClient, MODELS } from '../../client';
import { costUsdCentsForTurn } from '../../assistant/pricing';
import type { ActionDescriptorT } from '../action-descriptor';
import type { AgentContext, AgentOutput, IAgent } from '../types';

/**
 * Drafts a reply to an inbound email and proposes it as a pending
 * `email.send` approval. Per docs/vex-into-procur-merge-brief.md
 * Phase 3 — closed-loop equivalent of vex's EmailReplyDraftAgent +
 * the manual "convert suggestion to approval" step that vex needed
 * a worker for. Procur ships them as one action.
 *
 * Tier: agent runs at T1 (drafts only); the proposed action it emits
 * is T2, so AgentRunner routes it through ApprovalGate.
 *
 * Manual-fire only for now: the inbox "Draft reply" button invokes
 * AgentRunner.run(this) on a specific messageId. Auto-fire on inbound
 * needs Trigger.dev v3→v4 (gated upstream) — Phase 3.5 follow-up.
 */

const PROMPT_VERSION = 'v1.2026-05-06';

const SYSTEM_PROMPT = `You are Procur's email reply assistant.

(prompt_version=${PROMPT_VERSION})

# Job

An inbound email just landed from a contact. Draft a short, professional
reply on behalf of the operator. NEVER send. Your draft becomes a
pending \`email.send\` approval row; the operator reviews, edits, and
approves before anything leaves the outbox.

# Hard rules

- Tone: direct, businesslike, warm. No fluff, no sales speak.
- Length: ≤ 120 words, plain text only (no HTML, no markdown).
- Subject: reuse the original subject prefixed with "Re: " (unless it
  already starts with "Re:").
- Body: open with a one-line acknowledgement of what they said,
  then one or two concrete next steps (quote, intro call, volumes,
  delivery window — whatever the context calls for).
- Sign off as "Procur" — operators can edit the sender name before
  approving.
- If the inbound is noise (auto-reply, unsubscribe, out-of-office,
  bounce notification) reply with EXACTLY \`{"noise": true}\`.

# Output format

Return ONLY a JSON object — no preamble, no markdown fences. Either:

  {
    "subject": "Re: …",
    "body": "…"
  }

OR (when the inbound is noise):

  { "noise": true }
`;

interface DraftJson {
  subject?: string;
  body?: string;
  noise?: boolean;
}

const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_BODY_CHARS = 4000;

export interface EmailReplyDraftInput {
  /** messages.id of the inbound message to reply to. */
  messageId: string;
}

export class EmailReplyDraftAgent implements IAgent {
  readonly name = 'email_reply_draft';
  readonly tier = 'T1' as const;

  constructor(private readonly input: EmailReplyDraftInput) {}

  async run(ctx: AgentContext): Promise<AgentOutput> {
    // 1. Fetch the inbound message + its thread.
    const target = await db
      .select({
        id: messages.id,
        threadId: messages.threadId,
        subject: messages.subject,
        fromEmail: messages.fromEmail,
        messageId: messages.messageId,
        metadata: messages.metadata,
        direction: messages.direction,
      })
      .from(messages)
      .where(eq(messages.id, this.input.messageId))
      .limit(1);

    const inbound = target[0];
    if (!inbound) {
      return {
        proposedActions: [],
        internalWrites: 0,
        costUsd: 0,
        rationale: `message ${this.input.messageId} not found`,
      };
    }
    if (inbound.direction !== 'inbound') {
      return {
        proposedActions: [],
        internalWrites: 0,
        costUsd: 0,
        rationale: `message ${this.input.messageId} is outbound; nothing to draft`,
      };
    }

    // 2. The inbound webhook stamped contact_id onto messages.metadata
    //    when it matched the sender. Reuse it for the executor's
    //    touchpoint linkage.
    const inboundMeta = inbound.metadata as
      | { contact_id?: string }
      | undefined;
    const contactId = inboundMeta?.contact_id;

    // 3. Pull recent thread context for the prompt.
    const history = await db
      .select({
        direction: messages.direction,
        subject: messages.subject,
        fromEmail: messages.fromEmail,
        metadata: messages.metadata,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.threadId, inbound.threadId))
      .orderBy(desc(messages.createdAt))
      .limit(MAX_CONTEXT_MESSAGES);

    const inboundBody = extractBody(inbound.metadata);

    const userMessage = buildUserPrompt({
      subject: inbound.subject ?? '(no subject)',
      from: inbound.fromEmail ?? '(unknown)',
      bodyText: inboundBody,
      history: history.reverse().map((h) => ({
        direction: h.direction,
        subject: h.subject ?? '',
        from: h.fromEmail ?? '',
        body: extractBody(h.metadata).slice(0, MAX_CONTEXT_BODY_CHARS),
        at: h.createdAt.toISOString(),
      })),
    });

    // 4. Call Anthropic.
    const client = getClient();
    const response = await client.messages.create({
      model: MODELS.haiku,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    // 5. Cost-ledger record (powers the AgentRunner pre-run gate).
    const costCents = costUsdCentsForTurn(MODELS.haiku, {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    });
    const costUsd = costCents / 100;
    const totalTokens =
      response.usage.input_tokens +
      response.usage.output_tokens +
      (response.usage.cache_creation_input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0);
    await ctx.costLedger.record({
      idempotencyKey: `email_reply_draft:${ctx.agentRunId}:${response.id}`,
      agentRunId: ctx.agentRunId,
      operation: 'llm.completion',
      provider: 'anthropic',
      model: MODELS.haiku,
      units: totalTokens,
      unitKind: 'tokens',
      costUsdMicros: costCents * 10_000,
      occurredAt: ctx.now(),
    });

    // 6. Parse the model's JSON output.
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');
    const parsed = safeParseDraft(text);
    if (!parsed) {
      return {
        proposedActions: [],
        internalWrites: 0,
        costUsd,
        rationale: 'model returned non-JSON; no draft proposed',
      };
    }
    if (parsed.noise) {
      return {
        proposedActions: [],
        internalWrites: 0,
        costUsd,
        rationale: 'inbound classified as noise (auto-reply / OOO / bounce)',
      };
    }
    if (!parsed.subject || !parsed.body) {
      return {
        proposedActions: [],
        internalWrites: 0,
        costUsd,
        rationale: 'model returned incomplete draft (missing subject or body)',
      };
    }
    if (!inbound.fromEmail) {
      return {
        proposedActions: [],
        internalWrites: 0,
        costUsd,
        rationale: 'inbound message has no from_email; cannot address reply',
      };
    }

    const action: ActionDescriptorT = {
      kind: 'email.send',
      tier: 'T2',
      to: [inbound.fromEmail],
      subject: parsed.subject,
      body: parsed.body,
      ...(inbound.messageId ? { inReplyTo: inbound.messageId } : {}),
      ...(contactId ? { contactId } : {}),
    };

    return {
      proposedActions: [action],
      internalWrites: 0,
      costUsd,
      outputRefs: {
        message_id: inbound.messageId,
        thread_id: inbound.threadId,
        from: inbound.fromEmail,
      },
      rationale: `drafted reply to ${inbound.fromEmail}`,
    };
  }
}

function extractBody(
  metadata: Record<string, unknown> | null | undefined,
): string {
  if (!metadata || typeof metadata !== 'object') return '';
  const text = metadata['body_text'];
  if (typeof text === 'string') return text;
  return '';
}

function buildUserPrompt(args: {
  subject: string;
  from: string;
  bodyText: string;
  history: Array<{
    direction: string;
    subject: string;
    from: string;
    body: string;
    at: string;
  }>;
}): string {
  const lines: string[] = [];
  lines.push(`# Inbound email`);
  lines.push(`From: ${args.from}`);
  lines.push(`Subject: ${args.subject}`);
  lines.push('');
  lines.push(args.bodyText.slice(0, MAX_CONTEXT_BODY_CHARS));
  if (args.history.length > 1) {
    lines.push('');
    lines.push(`# Thread context (oldest first, most recent last)`);
    for (const h of args.history) {
      lines.push(`---`);
      lines.push(`[${h.at}] ${h.direction.toUpperCase()} from ${h.from}: ${h.subject}`);
      lines.push(h.body);
    }
  }
  return lines.join('\n');
}

function safeParseDraft(raw: string): DraftJson | null {
  // Strip markdown code fences if the model added them despite the
  // instruction; tolerate whitespace.
  const trimmed = raw.trim().replace(/^```(?:json)?/, '').replace(/```$/, '');
  try {
    const parsed = JSON.parse(trimmed) as DraftJson;
    return parsed;
  } catch {
    return null;
  }
}
