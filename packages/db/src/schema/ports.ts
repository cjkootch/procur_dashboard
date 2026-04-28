import {
  pgTable,
  text,
  numeric,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Reference table of ports + crude terminals — the geofence dictionary
 * port-call inference matches against. A vessel position is "at" a
 * port when it's within the radius defined by `geofence_radius_nm`
 * AND the vessel is moving slowly enough to be moored or anchored.
 *
 * Curated reference data (analyst-seeded). Add ports by appending
 * to seed-ports.ts and re-running.
 *
 * Categories:
 *   - 'crude-loading'    — exports a known crude grade (Es Sider,
 *                          Brega, etc.). known_grades populated.
 *   - 'refinery'         — refinery intake. linked_entity_slug
 *                          points to known_entities row.
 *   - 'transshipment'    — STS / lightering hub. Neither.
 *   - 'mixed'            — port handles both loading and discharge.
 *
 * Public-domain. No companyId.
 */
export const ports = pgTable(
  'ports',
  {
    /** Stable url-safe id, e.g. 'es-sider', 'sannazzaro-refinery'. */
    slug: text('slug').primaryKey(),
    name: text('name').notNull(),
    /** ISO-2 country code. */
    country: text('country').notNull(),
    /** WGS84. Approximate port center; geofence_radius_nm draws the
        match radius around this point. */
    lat: numeric('lat').notNull(),
    lng: numeric('lng').notNull(),
    /** Match radius in nautical miles. Tight terminals = 1.5; wide
        anchorage areas = 5. Default 3. */
    geofenceRadiusNm: numeric('geofence_radius_nm').notNull().default('3'),
    /** 'crude-loading' | 'refinery' | 'transshipment' | 'mixed'. */
    portType: text('port_type').notNull(),
    /** crude_grades.slug array — for loading ports, the grades that
        load here. NULL/empty for refinery + transshipment. */
    knownGrades: text('known_grades').array(),
    /** known_entities.slug for refinery ports. NULL otherwise. */
    linkedEntitySlug: text('linked_entity_slug'),
    notes: text('notes'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    countryIdx: index('ports_country_idx').on(table.country),
    typeIdx: index('ports_type_idx').on(table.portType),
    linkedEntityIdx: index('ports_linked_entity_idx').on(table.linkedEntitySlug),
  }),
);

export type Port = typeof ports.$inferSelect;
export type NewPort = typeof ports.$inferInsert;
