import type { EntityContactEnrichment } from '@procur/catalog';

const SENIORITY_LABEL: Record<string, string> = {
  owner: 'Owner',
  founder: 'Founder',
  c_suite: 'C-suite',
  partner: 'Partner',
  vp: 'VP',
  head: 'Head',
  director: 'Director',
  manager: 'Manager',
  senior: 'Senior',
  entry: 'Entry',
  intern: 'Intern',
};

/**
 * Apollo-sourced decision-makers panel. Renders contacts with
 * `source = 'apollo'` separately from vex enrichments (which keep
 * their own existing Contacts section).
 *
 * Two row states:
 *   - Pre-enrichment: obfuscated last name (Apollo's free search
 *     output), title + seniority shown, "Not enriched" indicator.
 *     The Enrich button lands in a follow-up PR.
 *   - Enriched: full name, email, phone, linkedin URL all present.
 */
export function ApolloDecisionMakers({
  contacts,
}: {
  contacts: EntityContactEnrichment[];
}) {
  const apolloContacts = contacts.filter((c) => c.source === 'apollo');

  if (apolloContacts.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="mb-2 flex items-baseline justify-between text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        <span>
          Decision-makers (Apollo){' '}
          <span className="ml-1 normal-case tracking-normal text-[color:var(--color-muted-foreground)]">
            ({apolloContacts.length})
          </span>
        </span>
      </h2>
      <div className="space-y-2">
        {apolloContacts.map((c) => (
          <ApolloPersonRow key={c.id} contact={c} />
        ))}
      </div>
      <p className="mt-2 text-[10px] italic text-[color:var(--color-muted-foreground)]">
        Pre-enrichment rows show the obfuscated form Apollo returns from the free
        search endpoint. Enriching resolves the full name + email + direct phone.
      </p>
    </section>
  );
}

function ApolloPersonRow({ contact }: { contact: EntityContactEnrichment }) {
  const enriched = contact.email != null;
  return (
    <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{contact.contactName}</p>
          <p className="mt-0.5 text-xs text-[color:var(--color-muted-foreground)]">
            {contact.title?.value ?? '—'}
            {contact.seniority && (
              <>
                {' · '}
                <span className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">
                  {SENIORITY_LABEL[contact.seniority] ?? contact.seniority}
                </span>
              </>
            )}
          </p>
        </div>
        {!enriched && (
          <span
            className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-300"
            title="Apollo has data but procur hasn't enriched the row yet"
          >
            Not enriched
          </span>
        )}
      </div>
      {enriched && (
        <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-[color:var(--color-muted-foreground)] md:grid-cols-2">
          {contact.email && (
            <Pair
              label="Email"
              value={contact.email.value}
              confidence={contact.email.confidence}
            />
          )}
          {contact.phone && (
            <Pair
              label="Direct phone"
              value={contact.phone.value}
              confidence={contact.phone.confidence}
            />
          )}
          {contact.linkedinUrl && (
            <Pair
              label="LinkedIn"
              value={contact.linkedinUrl.value}
              confidence={contact.linkedinUrl.confidence}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Pair({
  label,
  value,
  confidence,
}: {
  label: string;
  value: string;
  confidence: number;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide">{label}</p>
      <p className="truncate text-[color:var(--color-foreground)]">
        {value}{' '}
        <span
          title={`Confidence: ${(confidence * 100).toFixed(0)}%`}
          className="text-[10px] text-[color:var(--color-muted-foreground)]"
        >
          ({(confidence * 100).toFixed(0)}%)
        </span>
      </p>
    </div>
  );
}
