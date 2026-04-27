import { Button, Input } from '@procur/ui';

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
      <Input
        type="search"
        name="q"
        defaultValue={defaultQuery}
        placeholder={placeholder}
        aria-label="Search tenders"
        className="flex-1 px-4 py-3 text-base"
      />
      <Button type="submit" size="lg" className="px-5">
        Search
      </Button>
    </form>
  );
}
