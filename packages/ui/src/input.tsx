import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from './cn';

const BASE =
  'block w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-1.5 text-sm text-[color:var(--color-foreground)] placeholder:text-[color:var(--color-muted-foreground)] ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-foreground)]/30 focus-visible:border-[color:var(--color-foreground)] ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...rest }, ref) => (
    <input ref={ref} className={cn(BASE, className)} {...rest} />
  ),
);
Input.displayName = 'Input';
