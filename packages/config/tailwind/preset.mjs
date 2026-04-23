// Design tokens shared across web and email surfaces.
// Apps declare the same values in their globals.css @theme block
// (Tailwind v4 can't reliably resolve cross-package CSS in pnpm workspaces).
// Keep this file in sync with apps/*/app/globals.css.

export const procurBrand = {
  primary: 'oklch(0.55 0.18 250)',
  primaryForeground: 'oklch(0.98 0 0)',
  accent: 'oklch(0.75 0.15 90)',
  background: 'oklch(1 0 0)',
  foreground: 'oklch(0.15 0 0)',
  muted: 'oklch(0.96 0 0)',
  mutedForeground: 'oklch(0.45 0 0)',
  border: 'oklch(0.92 0 0)',
};

export const procurRadii = {
  sm: '0.375rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
};
