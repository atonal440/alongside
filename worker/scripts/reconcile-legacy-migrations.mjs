#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const [database = 'alongside-db', mode = '--remote'] = process.argv.slice(2);

if (!['--remote', '--local', '--preview'].includes(mode)) {
  console.error(`Invalid mode: ${mode}. Use --remote, --local, or --preview.`);
  process.exit(1);
}

const hasMigrationsTableSql = `
SELECT EXISTS(
  SELECT 1
  FROM sqlite_master
  WHERE type = 'table' AND name = 'd1_migrations'
) AS has_migrations_table;
`;

const hasMigrationsTableArgs = [
  'wrangler',
  'd1',
  'execute',
  database,
  mode,
  '--json',
  '--command',
  hasMigrationsTableSql
];

const hasMigrationsTableOutput = execFileSync('npx', hasMigrationsTableArgs, {
  encoding: 'utf8'
});

const parsedOutput = JSON.parse(hasMigrationsTableOutput);
const queryResult = parsedOutput?.[0]?.results?.[0];
const hasMigrationsTable = queryResult?.has_migrations_table === 1;

if (!hasMigrationsTable) {
  console.log(
    'Skipping legacy migration reconciliation: d1_migrations table is not present yet.'
  );
  process.exit(0);
}

const sql = `
INSERT OR IGNORE INTO d1_migrations (name, applied_at)
SELECT '002_streamline_schema.sql', CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM pragma_table_info('projects') WHERE name = 'notes');

INSERT OR IGNORE INTO d1_migrations (name, applied_at)
SELECT '003_focused_until.sql', CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'focused_until');
`;

const args = ['wrangler', 'd1', 'execute', database, mode, '--command', sql];
execFileSync('npx', args, { stdio: 'inherit' });
