import { createHash } from 'node:crypto';

const MAX_SLUG_SEGMENT = 60;

function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_SEGMENT)
    .replace(/-+$/g, '');
}

export function slugifyTitle(title: string): string {
  return normalize(title);
}

export function buildOpportunitySlug(
  jurisdictionSlug: string,
  title: string,
  sourceReferenceId: string,
): string {
  const titleSlug = normalize(title) || 'opportunity';
  const hash = createHash('sha1').update(sourceReferenceId).digest('hex').slice(0, 8);
  return `${jurisdictionSlug}-${titleSlug}-${hash}`;
}
