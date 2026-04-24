import type { TenderScraper } from '@procur/scrapers-core';
import { BarbadosGisScraper } from './jurisdictions/barbados-gis/scraper';
import { DrDgcpScraper } from './jurisdictions/dr-dgcp/scraper';
import { GuyanaNptabScraper } from './jurisdictions/guyana-nptab/scraper';
import { JamaicaGojepScraper } from './jurisdictions/jamaica-gojep/scraper';
import { TrinidadEgpScraper } from './jurisdictions/trinidad-egp/scraper';

export type ScraperFactory = () => TenderScraper;

export const scrapers: Record<string, ScraperFactory> = {
  jamaica: () => new JamaicaGojepScraper(),
  guyana: () => new GuyanaNptabScraper(),
  'trinidad-and-tobago': () => new TrinidadEgpScraper(),
  'dominican-republic': () => new DrDgcpScraper(),
  barbados: () => new BarbadosGisScraper(),
};

export function getScraper(slug: string): TenderScraper {
  const factory = scrapers[slug];
  if (!factory) {
    const available = Object.keys(scrapers).join(', ');
    throw new Error(`unknown scraper '${slug}'. Available: ${available}`);
  }
  return factory();
}
