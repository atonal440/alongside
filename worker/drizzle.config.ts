import { defineConfig } from 'drizzle-kit';

// Drizzle's `out` is intentionally separate from wrangler's `migrations/`.
// Hand-written `migrations/00N_*.sql` files are the source of truth applied
// via `wrangler d1 migrations apply`; Drizzle is used only as a diff helper
// — `db:generate` produces an ALTER-statement preview in `./drizzle/`, which
// you copy into a new hand-numbered migration. Keeping the directories
// separate prevents wrangler from picking up Drizzle's baseline SQL twice.
export default defineConfig({
  schema: '../shared/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  driver: 'd1-http',
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    databaseId: process.env.CLOUDFLARE_DATABASE_ID!,
    token: process.env.CLOUDFLARE_D1_TOKEN!,
  },
});
