import { forwardRef, type LabelHTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * Tiny uppercase label — used as the section header for right-rail
 * cards, form-group titles, and metadata clusters. Replaces the
 * "text-[11px] uppercase tracking-wider" pattern that appears 20+
 * times across the codebase.
 */
export type LabelProps = LabelHTMLAttributes<HTMLLabelElement> & {
  as?: 'label' | 'span' | 'div';
};

const BASE =
  'block text-[11px] font-medium uppercase tracking-wider text-[color:var(--color-muted-foreground)]';

export const Label = forwardRef<HTMLLabelElement, LabelProps>(
  ({ as: _as = 'label', className, ...rest }, ref) => (
    <label ref={ref} className={cn(BASE, className)} {...rest} />
  ),
);
Label.displayName = 'Label';
