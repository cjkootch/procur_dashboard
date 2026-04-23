import type { MetadataRoute } from 'next';

const BASE = process.env.NEXT_PUBLIC_DISCOVER_URL ?? 'https://discover.procur.app';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/admin/'],
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
    host: BASE,
  };
}
