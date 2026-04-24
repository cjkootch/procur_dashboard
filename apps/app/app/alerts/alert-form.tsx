import type { AlertProfile } from '@procur/db';

type Props = {
  action: (formData: FormData) => void | Promise<void>;
  jurisdictions: Array<{ slug: string; name: string }>;
  categories: string[];
  existing?: AlertProfile;
  submitLabel?: string;
  hiddenFields?: Record<string, string>;
};

export function AlertForm({
  action,
  jurisdictions,
  categories,
  existing,
  submitLabel = 'Save',
  hiddenFields = {},
}: Props) {
  const selectedJurisdictions = new Set(existing?.jurisdictions ?? []);
  const selectedCategories = new Set(existing?.categories ?? []);

  return (
    <form
      action={action}
      className="grid gap-4 rounded-[var(--radius-lg)] border border-[color:var(--color-border)] p-5"
    >
      {Object.entries(hiddenFields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}

      <label>
        <span className="text-xs text-[color:var(--color-muted-foreground)]">Name</span>
        <input
          name="name"
          required
          defaultValue={existing?.name ?? ''}
          placeholder="e.g. Trinidad IT tenders over $500K"
          className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
        />
      </label>

      <div>
        <span className="text-xs text-[color:var(--color-muted-foreground)]">
          Jurisdictions ({jurisdictions.length})
        </span>
        <div className="mt-1 grid max-h-48 gap-1 overflow-auto rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-2 text-sm md:grid-cols-3">
          {jurisdictions.map((j) => (
            <label key={j.slug} className="flex items-center gap-2">
              <input
                type="checkbox"
                name="jurisdictions"
                value={j.slug}
                defaultChecked={selectedJurisdictions.has(j.slug)}
              />
              <span>{j.name}</span>
            </label>
          ))}
          {jurisdictions.length === 0 && (
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
              No jurisdictions seeded yet.
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
          Leave all unchecked to include every jurisdiction.
        </p>
      </div>

      {categories.length > 0 && (
        <div>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            Categories ({categories.length})
          </span>
          <div className="mt-1 grid max-h-36 gap-1 overflow-auto rounded-[var(--radius-sm)] border border-[color:var(--color-border)] p-2 text-sm md:grid-cols-3">
            {categories.map((c) => (
              <label key={c} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="categories"
                  value={c}
                  defaultChecked={selectedCategories.has(c)}
                />
                <span>{c}</span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
            Leave all unchecked to include every category.
          </p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <label>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            Keywords (comma-separated)
          </span>
          <input
            name="keywords"
            defaultValue={(existing?.keywords ?? []).join(', ')}
            placeholder="e.g. software, cloud, integration"
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
        </label>
        <label>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            Exclude keywords
          </span>
          <input
            name="excludeKeywords"
            defaultValue={(existing?.excludeKeywords ?? []).join(', ')}
            placeholder="e.g. subcontractor, construction"
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            Min value (USD)
          </span>
          <input
            name="minValue"
            type="number"
            step="1"
            defaultValue={existing?.minValue ?? ''}
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
        </label>
        <label>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">
            Max value (USD)
          </span>
          <input
            name="maxValue"
            type="number"
            step="1"
            defaultValue={existing?.maxValue ?? ''}
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label>
          <span className="text-xs text-[color:var(--color-muted-foreground)]">Frequency</span>
          <select
            name="frequency"
            defaultValue={existing?.frequency ?? 'daily'}
            className="mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm"
          >
            <option value="instant">Instant</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>
        <label className="flex items-center gap-2 pt-6 text-sm">
          <input
            name="emailEnabled"
            type="checkbox"
            defaultChecked={existing?.emailEnabled ?? true}
          />
          <span>Email digest enabled</span>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
