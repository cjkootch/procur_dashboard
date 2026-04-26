import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // Filled monochrome — the dominant CTA in the app today (e.g. "Track this
  // opportunity", "Save", "Connect"). Inverts foreground/background.
  primary:
    'bg-[color:var(--color-foreground)] text-[color:var(--color-background)] hover:opacity-90 disabled:opacity-50',
  // Bordered, transparent fill. For "View on Discover", "Cancel", etc.
  secondary:
    'border border-[color:var(--color-border)] bg-[color:var(--color-background)] text-[color:var(--color-foreground)] hover:bg-[color:var(--color-muted)]/40 disabled:opacity-50',
  // No border, no background — for inline actions inside cards.
  ghost:
    'text-[color:var(--color-foreground)] hover:bg-[color:var(--color-muted)]/60 disabled:opacity-50',
  // Reserved for delete confirmations.
  destructive:
    'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-9 px-3.5 text-sm',
  lg: 'h-10 px-4 text-sm',
};

const BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] font-medium transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-foreground)]/30 focus-visible:ring-offset-1 focus-visible:ring-offset-[color:var(--color-background)] ' +
  'disabled:cursor-not-allowed';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', leadingIcon, trailingIcon, className, children, type, ...rest }, ref) => {
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        className={cn(BASE, VARIANT_CLASSES[variant], SIZE_CLASSES[size], className)}
        {...rest}
      >
        {leadingIcon}
        {children}
        {trailingIcon}
      </button>
    );
  },
);
Button.displayName = 'Button';
