export type FetchOptions = RequestInit & {
  maxRetries?: number;
  retryableStatuses?: number[];
  baseDelayMs?: number;
  userAgent?: string;
  timeoutMs?: number;
};

const DEFAULT_USER_AGENT = 'Procur/1.0 (+https://procur.app/scraper; hello@procur.app)';

function isRetryableStatus(status: number, allowlist: number[]): boolean {
  return allowlist.includes(status);
}

export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const {
    maxRetries = 3,
    retryableStatuses = [408, 429, 500, 502, 503, 504],
    baseDelayMs = 1000,
    userAgent = DEFAULT_USER_AGENT,
    timeoutMs = 30000,
    headers,
    ...rest
  } = opts;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      const delay = baseDelayMs * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...rest,
        headers: {
          'user-agent': userAgent,
          ...headers,
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutHandle);

      if (response.ok) return response;
      if (!isRetryableStatus(response.status, retryableStatuses)) return response;
      lastError = new Error(`HTTP ${response.status} from ${url}`);
    } catch (err) {
      clearTimeout(timeoutHandle);
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`fetchWithRetry failed for ${url}`);
}
