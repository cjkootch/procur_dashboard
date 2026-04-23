import { chromium, type Browser } from 'playwright';
import type { PageFetcher } from './scraper';

/**
 * Production PageFetcher backed by Playwright + headless Chromium.
 *
 * Requires `pnpm exec playwright install chromium` once per machine.
 * In Trigger.dev deploys this happens automatically via the Playwright
 * build extension (configured in services/scrapers/trigger.config.ts).
 */
export class PlaywrightFetcher implements PageFetcher {
  private browser: Browser | null = null;

  async fetchRendered(url: string): Promise<string> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
    const context = await this.browser.newContext({
      userAgent: 'Procur/1.0 (+https://procur.app/scraper)',
    });
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      return await page.content();
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
