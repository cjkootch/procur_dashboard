import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

const BASE =
  'block w-full rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-3 py-2 text-sm text-[color:var(--color-foreground)] placeholder:text-[color:var(--color-muted-foreground)] ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-foreground)]/30 focus-visible:border-[color:var(--color-foreground)] ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, rows, ...rest }, ref) => (
    <textarea ref={ref} rows={rows ?? 3} className={cn(BASE, className)} {...rest} />
  ),
);
Textarea.displayName = 'Textarea';
