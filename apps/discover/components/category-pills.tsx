import Link from 'next/link';

type Category = { slug: string; name: string; parentSlug: string | null };

export function CategoryPills({
  categories,
  activeSlug,
}: {
  categories: Category[];
  activeSlug?: string;
}) {
  const topLevel = categories.filter((c) => !c.parentSlug);
  return (
    <div className="flex flex-wrap gap-2">
      {topLevel.map((cat) => {
        const active = cat.slug === activeSlug;
        return (
          <Link
            key={cat.slug}
            href={`/opportunities?category=${cat.slug}`}
            className={`rounded-full border px-3 py-1.5 text-xs transition ${
              active
                ? 'border-[color:var(--color-foreground)] bg-[color:var(--color-foreground)] text-[color:var(--color-background)]'
                : 'border-[color:var(--color-border)] hover:border-[color:var(--color-foreground)]'
            }`}
          >
            {cat.name}
          </Link>
        );
      })}
    </div>
  );
}
