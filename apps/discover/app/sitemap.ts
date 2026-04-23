import type { MetadataRoute } from 'next';
import { sql } from 'drizzle-orm';
import { db, opportunities } from '@procur/db';
import { listJurisdictions } from '../lib/queries';

const BASE = process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const [jurisdictions, oppRows] = await Promise.all([
    listJurisdictions(),
    db
      .select({ slug: opportunities.slug, updatedAt: opportunities.updatedAt })
      .from(opportunities)
      .where(sql`${opportunities.status} = 'active' AND ${opportunities.slug} IS NOT NULL`)
      .limit(40_000),
  ]);

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, lastModified: now, changeFrequency: 'hourly', priority: 1 },
    {
      url: `${BASE}/opportunities`,
      lastModified: now,
      changeFrequency: 'hourly',
      priority: 0.9,
    },
    {
      url: `${BASE}/jurisdictions`,
      lastModified: now,
      changeFrequency: 'daily',
      priority: 0.7,
    },
  ];

  const jurisdictionRoutes: MetadataRoute.Sitemap = jurisdictions.map((j) => ({
    url: `${BASE}/jurisdictions/${j.slug}`,
    lastModified: now,
    changeFrequency: 'daily' as const,
    priority: 0.6,
  }));

  const opportunityRoutes: MetadataRoute.Sitemap = oppRows
    .filter((o): o is { slug: string; updatedAt: Date } => !!o.slug)
    .map((o) => ({
      url: `${BASE}/opportunities/${o.slug}`,
      lastModified: o.updatedAt ?? now,
      changeFrequency: 'weekly' as const,
      priority: 0.5,
    }));

  return [...staticRoutes, ...jurisdictionRoutes, ...opportunityRoutes];
}
