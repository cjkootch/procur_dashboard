/**
 * Client-side helpers for the Discover assistant handshake token.
 *
 * The token is minted by app.procur.app/api/discover-connect after Clerk
 * auth, then handed to Discover via URL hash fragment (#_dt=…). Stored
 * in localStorage so subsequent visits skip the handshake until the
 * 24-hour TTL expires.
 *
 * Hash fragment (rather than query) avoids server logs / CDN caching
 * the token — and we scrub the URL with replaceState the moment we've
 * read it.
 */

const STORAGE_KEY = 'procur_discover_token';
const HASH_PARAM = '_dt';

export function readHandshakeFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return params.get(HASH_PARAM);
}

export function scrubHandshakeFromUrl(): void {
  if (typeof window === 'undefined') return;
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return;
  const params = new URLSearchParams(hash);
  if (!params.has(HASH_PARAM)) return;
  params.delete(HASH_PARAM);
  const remaining = params.toString();
  const newUrl =
    window.location.pathname + window.location.search + (remaining ? `#${remaining}` : '');
  window.history.replaceState(null, '', newUrl);
}

export function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage may be disabled (private mode, etc) — graceful no-op.
  }
}

export function clearStoredToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * URL of the App's handshake endpoint. Click this to start a handshake
 * — the App route Clerk-authes the user, signs a token, and redirects
 * back to Discover with the token in the URL hash.
 */
export function buildConnectUrl(returnTo?: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.procur.app';
  const url = new URL('/api/discover-connect', appUrl);
  if (returnTo) url.searchParams.set('return', returnTo);
  return url.toString();
}
