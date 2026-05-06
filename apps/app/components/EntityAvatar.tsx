/**
 * Circular initials avatar with deterministic color from the entity
 * name. LinkedIn-style placeholder for entities without a logo. The
 * color hash gives the same avatar a stable color across surfaces so
 * Petroil S.A. is always teal, Vitol always indigo, etc.
 */
export type EntityAvatarProps = {
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
};

const PALETTE = [
  { bg: 'bg-sky-100', fg: 'text-sky-700' },
  { bg: 'bg-emerald-100', fg: 'text-emerald-700' },
  { bg: 'bg-amber-100', fg: 'text-amber-800' },
  { bg: 'bg-rose-100', fg: 'text-rose-700' },
  { bg: 'bg-violet-100', fg: 'text-violet-700' },
  { bg: 'bg-teal-100', fg: 'text-teal-700' },
  { bg: 'bg-indigo-100', fg: 'text-indigo-700' },
  { bg: 'bg-orange-100', fg: 'text-orange-700' },
  { bg: 'bg-fuchsia-100', fg: 'text-fuchsia-700' },
  { bg: 'bg-cyan-100', fg: 'text-cyan-700' },
];

const SIZE: Record<NonNullable<EntityAvatarProps['size']>, string> = {
  xs: 'h-7 w-7 text-[10px]',
  sm: 'h-9 w-9 text-xs',
  md: 'h-12 w-12 text-sm',
  lg: 'h-16 w-16 text-base',
  xl: 'h-24 w-24 text-2xl',
};

function initials(name: string): string {
  const cleaned = name
    .replace(/\b(S\.A\.|S\.p\.A\.|S\.r\.l\.|Ltd\.?|Inc\.?|LLC|PLC|PJSC|JSC|Co\.?|Corp\.?|GmbH|AG|N\.V\.|B\.V\.|Pte\.?)\b/gi, '')
    .trim();
  const parts = cleaned.split(/[\s\-_/&·]+/).filter(Boolean);
  if (parts.length === 0) return name.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

function colorFor(name: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h << 5) - h + name.charCodeAt(i);
    h |= 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}

export function EntityAvatar({ name, size = 'md' }: EntityAvatarProps) {
  const c = colorFor(name);
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold tracking-tight ring-1 ring-[color:var(--color-border)] ${SIZE[size]} ${c.bg} ${c.fg}`}
    >
      {initials(name)}
    </span>
  );
}
