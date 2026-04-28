# Drizzle migrations

This directory holds the SQL migration history for `@procur/db`. The
**source of truth for what's applied in production** is the
`__drizzle_migrations` table on the database itself, populated by the
custom runner in `../src/migrate.ts`. The journal + snapshot files
under `meta/` are drizzle-kit's local bookkeeping and are out of sync
in ways documented below.

## Authoring a new migration

Two paths:

1. **Hand-author SQL** (the path we've used since `0020_external_suppliers`).
   Create a new file `<NNNN>_<short-name>.sql` numbered after the highest
   existing one, write the SQL, then add a matching entry to
   `meta/_journal.json` so the sequence stays consistent. Run
   `pnpm --filter @procur/db db:migrate` to apply against the connected
   `DATABASE_URL`. Idempotent — won't re-apply migrations already in
   `__drizzle_migrations`.

2. **`drizzle-kit generate`** (currently broken — see below). When fixed,
   modify the schema TS files in `../src/schema/`, run `pnpm db:generate`,
   review the emitted SQL, then `db:migrate`.

## Why `drizzle-kit generate` is currently broken

`drizzle-kit generate` works by diffing the schema TS against the most
recent snapshot in `meta/<idx>_snapshot.json`. The snapshots stop at
`0017_snapshot.json` — migrations 0020–0029 were hand-authored without
running through drizzle-kit, so no snapshots were produced.

`_journal.json` now lists all 30 entries (0–29), but the snapshot files
0018–0029 don't exist. If you run `drizzle-kit generate`, it'll either
crash looking for a missing snapshot or emit a diff against the stale
0017 baseline that re-creates everything since then.

To restore `drizzle-kit generate`:

```sh
# 1. Connect to a DB that has all 30 migrations applied (prod or a fresh
#    seeded copy).
# 2. Run drizzle-kit introspect to materialize the current schema as a
#    new baseline snapshot.
pnpm exec drizzle-kit introspect

# 3. Renumber the produced snapshot to 0029_snapshot.json so it aligns
#    with the latest journal entry.
# 4. Verify drizzle-kit generate emits a no-op when run against the
#    schema files (no drift). If it doesn't, the schema files and the
#    DB are out of sync — investigate before continuing.
```

This isn't urgent because hand-authoring works. Do it when adding
schema-defined-only changes (new columns, indexes, etc.) becomes more
common than infrastructure migrations.

## Why 0018 and 0019 are empty placeholders

A feature branch generated 0018 and 0019 locally, then got squashed
before merge. The next merged migration (`0020_external_suppliers`)
kept its original local numbering, leaving a gap. The two placeholder
files (each just `SELECT 1`) restore numeric continuity so future
tooling doesn't have to special-case the missing range.
