import Link from 'next/link';
import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  /** Optional breadcrumb trail rendered above the title in muted text. */
  breadcrumb?: Array<{ label: string; href?: string }>;
  /** Visually prominent right-side action (typically a primary button). */
  primaryAction?: ReactNode;
  /** Secondary controls — kebab menus, ghost buttons, etc. — rendered
      to the left of primaryAction. */
  secondaryActions?: ReactNode;
  /** Anything that renders BELOW the header bar — page-level tabs,
      filter chips, summary stats. */
  children?: ReactNode;
}

/**
 * Shared per-page header. Replaces the inline title bar previously
 * baked into AppShell; the shared shape is now consistent with vex.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Breadcrumb / / /                             │
 *   │ Title                       [secondary] [primary]
 *   ├──────────────────────────────────────────────┤
 *   │ children (tabs, filters, summary)            │
 *   └──────────────────────────────────────────────┘
 */
export function PageHeader({
  title,
  breadcrumb,
  primaryAction,
  secondaryActions,
  children,
}: PageHeaderProps) {
  return (
    <div className="border-b border-[color:var(--color-border)] bg-[color:var(--color-background)]">
      <div className="flex min-h-14 items-center justify-between gap-3 px-4 py-2 md:px-6">
        <div className="min-w-0">
          {breadcrumb && breadcrumb.length > 0 && (
            <div className="mb-0.5 flex items-center gap-1 text-xs text-[color:var(--color-muted-foreground)]">
              {breadcrumb.map((crumb, i) => {
                const isLast = i === breadcrumb.length - 1;
                return (
                  <span key={`${crumb.label}-${i}`} className="flex items-center gap-1">
                    {crumb.href && !isLast ? (
                      <Link
                        href={crumb.href}
                        className="hover:text-[color:var(--color-foreground)]"
                      >
                        {crumb.label}
                      </Link>
                    ) : (
                      <span>{crumb.label}</span>
                    )}
                    {!isLast && <span aria-hidden="true">/</span>}
                  </span>
                );
              })}
            </div>
          )}
          <h1 className="truncate text-xl font-semibold text-[color:var(--color-foreground)]">
            {title}
          </h1>
        </div>
        {(primaryAction || secondaryActions) && (
          <div className="flex shrink-0 items-center gap-2">
            {secondaryActions}
            {primaryAction}
          </div>
        )}
      </div>
      {children && <div className="px-4 md:px-6">{children}</div>}
    </div>
  );
}
