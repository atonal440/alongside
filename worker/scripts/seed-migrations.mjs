#!/usr/bin/env node
/**
 * Marks all existing migrations as applied in the d1_migrations tracking table.
 * Run this once after setting up a DB from schema.sql to bring wrangler's
 * migration tracking in sync with reality.
 *
 * Usage:
 *   node scripts/seed-migrations.mjs --local
 *   node scripts/seed-migrations.mjs --remote
 */
import { execFileSync } from 'node:child_process';

const mode = process.argv[2] ?? '--local';
if (!['--remote', '--local', '--preview'].includes(mode)) {
  console.error(`Usage: node scripts/seed-migrations.mjs [--local|--remote|--preview]`);
  process.exit(1);
}

// These are all migrations that were applied directly via schema.sql before
// wrangler migration tracking was in place. Keep this list in sync with the
// files in worker/migrations/ any time a migration is added.
const applied = [
  '001_initial_schema.sql',
  '002_streamline_schema.sql',
  '003_focused_until.sql',
  '004_remove_snoozed_status.sql',
  '005_remove_active_status.sql',
  '006_defer.sql',
];

const inserts = applied
  .map(name => `INSERT OR IGNORE INTO d1_migrations (name, applied_at) VALUES ('${name}', datetime('now'));`)
  .join('\n');

const sql = `
CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
${inserts}
`;

execFileSync('npx', ['wrangler', 'd1', 'execute', 'alongside-db', mode, '--command', sql], {
  stdio: 'inherit',
});

console.log(`Seeded d1_migrations (${mode}) with ${applied.length} entries.`);
