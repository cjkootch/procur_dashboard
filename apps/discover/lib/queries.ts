/**
 * Re-exports the public-catalog query helpers from @procur/catalog so
 * existing imports (Discover pages, components) continue to work
 * without churning every call site after the extraction.
 *
 * If you find yourself adding new helpers here that don't belong on
 * any other surface, consider keeping them Discover-local instead.
 * For shared helpers, add them in @procur/catalog and re-export here.
 */
export * from '@procur/catalog';
