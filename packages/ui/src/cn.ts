import clsx, { type ClassValue } from 'clsx';

/**
 * Tiny className merge helper. Keeps Button/Input/etc. usage ergonomic
 * (`cn('a', condition && 'b', extras)`) without pulling in tailwind-merge —
 * we don't have a duplicate-class problem given the variant maps below.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
