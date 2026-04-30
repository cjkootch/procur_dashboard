import Link from 'next/link';

/**
 * Custom 404 for `/entities/[slug]`. Most often hit when a chat
 * session proposed creating an entity (`propose_create_known_entity`)
 * but the user hadn't clicked Apply on the confirm card yet — the
 * link in the chat output looks live but the row doesn't exist.
 *
 * Default Next 404 just says "Page not found", which is technically
 * correct but unhelpful here. Surface the most common cause + what
 * to do about it.
 */
export default function EntityNotFound() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Entity not found</h1>
      <p className="mt-3 text-sm text-[color:var(--color-muted-foreground)]">
        We couldn&rsquo;t find a known entity or external supplier matching
        this slug. The most common cause:
      </p>
      <div className="mt-4 rounded-[var(--radius-md)] border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <strong>Was this proposed in a chat conversation?</strong> When the
        assistant calls{' '}
        <code className="font-mono text-xs">propose_create_known_entity</code>,
        it returns a confirm card — the entity isn&rsquo;t actually created
        until you click <strong>Apply</strong> on that card. Open the chat
        thread, find the proposal, and click Apply. The link in the chat
        output goes live as soon as the create lands.
      </div>
      <p className="mt-4 text-sm text-[color:var(--color-muted-foreground)]">
        Other causes:
      </p>
      <ul className="mt-2 list-disc pl-6 text-sm text-[color:var(--color-muted-foreground)]">
        <li>The slug was hand-edited or mis-typed in the URL.</li>
        <li>The entity was deleted.</li>
      </ul>
      <div className="mt-6 flex gap-3">
        <Link
          href="/suppliers/known-entities"
          className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-background)]"
        >
          Browse the rolodex →
        </Link>
        <Link
          href="/assistant"
          className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-3 py-1.5 text-sm"
        >
          Open chat
        </Link>
      </div>
    </div>
  );
}
