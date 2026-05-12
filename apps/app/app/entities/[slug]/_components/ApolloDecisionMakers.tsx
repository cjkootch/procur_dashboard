import Image from 'next/image';
import type { EntityContactEnrichment } from '@procur/catalog';
import { EnrichApolloPersonButton } from './EnrichApolloPersonButton';
import { FindApolloPeopleForm } from './FindApolloPeopleForm';

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
 *   - Pre-enrichment: obfuscated last name + Enrich button (paid call,
 *     gated by per-tenant per-day cap).
 *   - Enriched: full name, email, phone, linkedin URL.
 *
 * The "+ Find people" form runs a free Apollo search scoped to this
 * entity and persists matches as new pre-enrichment rows.
 */
export function ApolloDecisionMakers({
  contacts,
  entitySlug,
}: {
  contacts: EntityContactEnrichment[];
  entitySlug: string;
}) {
  const apolloContacts = contacts.filter((c) => c.source === 'apollo');

  return (
    <section className="mb-6">
      <h2 className="mb-2 flex items-baseline justify-between text-xs font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        <span className="flex items-center gap-1.5">
          Decision-makers
          <Image
            src="/apollo-logo.svg"
            alt="Apollo"
            width={12}
            height={12}
            aria-label="Powered by Apollo"
          />
          <span className="ml-1 normal-case tracking-normal text-[color:var(--color-muted-foreground)]">
            ({apolloContacts.length})
          </span>
        </span>
        <FindApolloPeopleForm entitySlug={entitySlug} />
      </h2>
      {apolloContacts.length === 0 ? (
        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          No Apollo-sourced contacts yet. Click <strong>+ Find people</strong> above to search.
        </p>
      ) : (
        <div className="space-y-2">
          {apolloContacts.map((c) => (
            <ApolloPersonRow key={c.id} contact={c} entitySlug={entitySlug} />
          ))}
        </div>
      )}
      <p className="mt-2 text-[10px] italic text-[color:var(--color-muted-foreground)]">
        Pre-enrichment rows show the obfuscated form Apollo returns from the free
        search endpoint. Enriching resolves the full name + email + direct phone
        and consumes credits (per-tenant daily cap applies).
      </p>
    </section>
  );
}

function ApolloPersonRow({
  contact,
  entitySlug,
}: {
  contact: EntityContactEnrichment;
  entitySlug: string;
}) {
  // Three states, not two: a row may have been enriched (Apollo
  // /people/match ran) and still not have an email — Apollo returns
  // profile + LinkedIn without one when the verified-email lookup
  // misses. Previously this code treated "enriched-but-no-email" the
  // same as "never enriched", so the Enrich button re-appeared and
  // an operator could burn paid credits re-asking Apollo the same
  // question. The badge below makes that state explicit instead.
  const hasEmail = contact.email != null;
  const wasEnriched = contact.apolloLastRefreshedAt != null;
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
        {!wasEnriched && contact.apolloPersonId && (
          <EnrichApolloPersonButton
            entitySlug={entitySlug}
            apolloPersonId={contact.apolloPersonId}
          />
        )}
        {wasEnriched && !hasEmail && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
            title="Apollo returned a profile for this contact but no verified email. Re-enriching is unlikely to help; add an email manually if you find one elsewhere."
          >
            No email
          </span>
        )}
      </div>
      {hasEmail && (
        <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-[color:var(--color-muted-foreground)] md:grid-cols-2">
          {contact.email && (
            <Pair
              label="Email"
              value={contact.email.value}
              href={`mailto:${contact.email.value}`}
              confidence={contact.email.confidence}
            />
          )}
          {contact.phone && (
            <Pair
              label="Direct phone"
              value={contact.phone.value}
              href={`tel:${contact.phone.value.replace(/[^+\d]/g, '')}`}
              confidence={contact.phone.confidence}
            />
          )}
          {contact.linkedinUrl && (
            <Pair
              label="LinkedIn"
              value={contact.linkedinUrl.value}
              href={contact.linkedinUrl.value}
              external
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
  href,
  external,
}: {
  label: string;
  value: string;
  confidence: number;
  href?: string;
  external?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide">{label}</p>
      <p className="truncate text-[color:var(--color-foreground)]">
        {href ? (
          <a
            href={href}
            target={external ? '_blank' : undefined}
            rel={external ? 'noopener noreferrer' : undefined}
            className="hover:underline"
          >
            {value}
          </a>
        ) : (
          value
        )}{' '}
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
