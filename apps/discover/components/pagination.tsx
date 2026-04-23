import Link from 'next/link';

type Props = {
  page: number;
  perPage: number;
  total: number;
  buildHref: (page: number) => string;
};

export function Pagination({ page, perPage, total, buildHref }: Props) {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (lastPage === 1) return null;

  const prev = page > 1 ? page - 1 : null;
  const next = page < lastPage ? page + 1 : null;
  const start = (page - 1) * perPage + 1;
  const end = Math.min(page * perPage, total);

  return (
    <nav className="mt-8 flex items-center justify-between text-sm">
      <p className="text-[color:var(--color-muted-foreground)]">
        Showing {start}-{end} of {total.toLocaleString()}
      </p>
      <div className="flex items-center gap-2">
        <PageLink href={prev ? buildHref(prev) : null} label="Previous" />
        <span className="px-2 text-[color:var(--color-muted-foreground)]">
          Page {page} of {lastPage}
        </span>
        <PageLink href={next ? buildHref(next) : null} label="Next" />
      </div>
    </nav>
  );
}

function PageLink({ href, label }: { href: string | null; label: string }) {
  if (!href) {
    return (
      <span className="cursor-not-allowed rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 text-[color:var(--color-muted-foreground)]">
        {label}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1.5 hover:border-[color:var(--color-foreground)]"
    >
      {label}
    </Link>
  );
}
