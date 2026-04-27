import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * Surface primitive. Bordered, rounded, with breathing-room padding.
 * Replaces the dozens of repeated `rounded-[var(--radius-md)] border
 * border-[color:var(--color-border)] p-4` strings across the app.
 *
 * Pass `padding="sm"` for compact cards (right-rail, list rows) or
 * `padding="none"` to compose your own layout.
 */
export type CardProps = HTMLAttributes<HTMLDivElement> & {
  padding?: 'none' | 'sm' | 'md' | 'lg';
};

const PADDING: Record<NonNullable<CardProps['padding']>, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
};

const BASE =
  'rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)]';

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ padding = 'md', className, children, ...rest }, ref) => (
    <div ref={ref} className={cn(BASE, PADDING[padding], className)} {...rest}>
      {children}
    </div>
  ),
);
Card.displayName = 'Card';

export type CardHeaderProps = HTMLAttributes<HTMLDivElement>;
export const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ className, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn('mb-3 flex items-center justify-between gap-2', className)}
      {...rest}
    />
  ),
);
CardHeader.displayName = 'CardHeader';

export type CardTitleProps = HTMLAttributes<HTMLHeadingElement>;
export const CardTitle = forwardRef<HTMLHeadingElement, CardTitleProps>(
  ({ className, ...rest }, ref) => (
    <h3
      ref={ref}
      className={cn('text-sm font-semibold text-[color:var(--color-foreground)]', className)}
      {...rest}
    />
  ),
);
CardTitle.displayName = 'CardTitle';
