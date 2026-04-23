type Props = {
  defaultQuery?: string;
  action?: string;
  placeholder?: string;
};

export function SearchBar({
  defaultQuery,
  action = '/opportunities',
  placeholder = 'Search 10,000+ government tenders across emerging markets',
}: Props) {
  return (
    <form action={action} method="GET" className="flex w-full gap-2">
      <input
        type="search"
        name="q"
        defaultValue={defaultQuery}
        placeholder={placeholder}
        aria-label="Search tenders"
        className="flex-1 rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-4 py-3 text-base outline-none focus:border-[color:var(--color-foreground)]"
      />
      <button
        type="submit"
        className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-5 text-sm font-medium text-[color:var(--color-background)] hover:opacity-90"
      >
        Search
      </button>
    </form>
  );
}
