# worker/drizzle/

Drizzle is used here as a **diff helper**, not as the deploy mechanism.

The actual deploy migrations are the hand-written SQL files in `worker/migrations/00N_*.sql` — those are what `wrangler d1 migrations apply` runs. This `drizzle/` directory only exists so `npm run db:generate` can compare your edits to `shared/schema.ts` against the last known schema state and emit the `ALTER TABLE` statements you need.

## Workflow

When you change `shared/schema.ts`:

1. From `worker/`, run **`npm run db:generate`**.
2. Drizzle writes a new file `drizzle/0NNN_<random>.sql` containing the SQL diff and updates `drizzle/meta/_journal.json` + `drizzle/meta/0NNN_snapshot.json`.
3. **Open the generated SQL** and copy the relevant statements (usually one or more `ALTER TABLE`s) into a new hand-written file in `worker/migrations/` — name it sequentially (`007_*.sql`, `008_*.sql`, ...). Add a header comment explaining *why*. Hand-write any data backfill that Drizzle can't infer.
4. Add the new `00N_*.sql` filename to the `applied` list in `worker/scripts/seed-migrations.mjs` so fresh `db:init` installs mark it applied (since `schema.sql` already includes the new shape for fresh DBs).
5. Update `worker/schema.sql` so fresh installs match.
6. Apply locally: `npx wrangler d1 migrations apply alongside-db --local`.
7. Commit *all* of: the schema change, the new `migrations/00N_*.sql`, the updated `schema.sql`, the updated `seed-migrations.mjs`, **and** the new `drizzle/00NN_*.sql` + `drizzle/meta/*` files. The Drizzle artifacts are how next time's diff knows what already shipped.

## What if `db:generate` produces a baseline (`CREATE TABLE`s) instead of a diff?

That means the journal lost track of state. Cause: someone deleted `drizzle/meta/` or the snapshot version is out of sync. To recover, regenerate the baseline so it matches current `shared/schema.ts`:

```sh
rm -rf drizzle/
npm run db:generate
mv drizzle/0000_*.sql drizzle/0000_baseline.sql
# Edit drizzle/meta/_journal.json: rename the tag to "0000_baseline".
```

Commit that, and subsequent `db:generate` runs will produce proper diffs again.

## Why the separate directory?

`drizzle.config.ts` writes to `./drizzle` and not `./migrations` because wrangler scans `migrations/` and applies every `*.sql` it finds in alphabetical order. If Drizzle wrote into the same dir, its baseline `0000_*.sql` would collide with the hand-written sequence, and you'd get a duplicate `CREATE TABLE` failure on deploy.
