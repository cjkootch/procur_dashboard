import type { TenderScraper } from '@procur/scrapers-core';
import { BarbadosGisScraper } from './jurisdictions/barbados-gis/scraper';
import { ChileMpScraper } from './jurisdictions/chile-mp/scraper';
import { ChileMpSessionScraper } from './jurisdictions/chile-mp-session/scraper';
import { ColombiaSecopScraper } from './jurisdictions/colombia-secop/scraper';
import { DrDgcpScraper } from './jurisdictions/dr-dgcp/scraper';
import { GuyanaLcrScraper } from './jurisdictions/guyana-lcr/scraper';
import { GuyanaNptabScraper } from './jurisdictions/guyana-nptab/scraper';
import { JamaicaGojepScraper } from './jurisdictions/jamaica-gojep/scraper';
import { JamaicaGojepCurrentScraper } from './jurisdictions/jamaica-gojep-current/scraper';
import { TrinidadEgpScraper } from './jurisdictions/trinidad-egp/scraper';

export type ScraperFactory = () => TenderScraper;

export const scrapers: Record<string, ScraperFactory> = {
  jamaica: () => new JamaicaGojepScraper(),
  'jamaica-current': () => new JamaicaGojepCurrentScraper(),
  guyana: () => new GuyanaNptabScraper(),
  'guyana-lcr': () => new GuyanaLcrScraper(),
  'trinidad-and-tobago': () => new TrinidadEgpScraper(),
  'dominican-republic': () => new DrDgcpScraper(),
  barbados: () => new BarbadosGisScraper(),
  chile: () => new ChileMpScraper(),
  'chile-session': () => new ChileMpSessionScraper(),
  colombia: () => new ColombiaSecopScraper(),
};

export function getScraper(slug: string): TenderScraper {
  const factory = scrapers[slug];
  if (!factory) {
    const available = Object.keys(scrapers).join(', ');
    throw new Error(`unknown scraper '${slug}'. Available: ${available}`);
  }
  return factory();
}
