'use server';

import { redirect } from 'next/navigation';
import { parseRolodexQuery } from '@procur/ai';

/**
 * Smart-search server action — takes a free-text rolodex query, runs
 * a Haiku call that maps it onto structured filter dimensions, then
 * redirects to /suppliers/known-entities with the parsed filters as
 * URL params. Falls back to a plain name search (`q=`) if parsing
 * fails — the page is still useful even if the LLM is unavailable.
 *
 * Cost: ~$0.0001 per submit at current Haiku pricing — trivial.
 */
export async function smartSearchAction(formData: FormData): Promise<void> {
  const raw = formData.get('query');
  const query = typeof raw === 'string' ? raw.trim() : '';
  if (query.length === 0) {
    redirect('/suppliers/known-entities');
  }

  const params = new URLSearchParams();
  // Preserve the original prompt as a hidden param so the UI can show
  // "interpreted as …" + offer a one-click revert to plain text search.
  params.set('smart', query);

  try {
    const parsed = await parseRolodexQuery(query);
    if (parsed.category) params.set('category', parsed.category);
    if (parsed.country) params.set('country', parsed.country);
    if (parsed.state) params.set('state', parsed.state);
    if (parsed.role) params.set('role', parsed.role);
    if (parsed.tag) params.set('tag', parsed.tag);
    if (parsed.approval) params.set('approval', parsed.approval);
    if (parsed.q) params.set('q', parsed.q);
  } catch (err) {
    // LLM failure: fall back to name substring search. Log to stderr so
    // operators can spot persistent issues; the page still works.
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'rolodex-smart-search',
        msg: 'parse failed — falling back to plain q=',
        query,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    params.set('q', query);
  }

  redirect(`/suppliers/known-entities?${params.toString()}`);
}
