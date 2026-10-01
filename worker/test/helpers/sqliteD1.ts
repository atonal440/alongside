import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Real SQLite semantics, including triggers, FK cascades and batch rollback. */
export function sqliteD1(mode: 'fresh' | 'upgrade' = 'fresh') {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  if (mode === 'fresh') sql.exec(readFileSync(fileURLToPath(new URL('../../schema.sql', import.meta.url)), 'utf8'));
  else {
    const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
    for (const name of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) sql.exec(readFileSync(`${dir}/${name}`, 'utf8'));
  }
  const hooks: { beforeBatch?: () => void; failAfter?: number } = {};
  const batches: number[] = [];
  let reads = 0;
  function prepare(query: string) {
    let args: unknown[] = [];
    function execute(arrays = false) {
      const statement = sql.prepare(query);
      statement.setReturnArrays(arrays);
      const results = statement.all(...args as never[]);
      const changes = sql.prepare('SELECT changes() AS n').get()!.n;
      return { success: true, results, meta: { changes } };
    }
    return {
      query, bind(...values: unknown[]) { args = values; return this; },
      async first() { reads++; return sql.prepare(query).get(...args as never[]) ?? null; },
      async all() { reads++; return execute(); },
      async raw() { reads++; return execute(true).results; },
      async run() { return execute(); }, execute,
    };
  }
  const d1 = { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    if (hooks.beforeBatch) { const hook = hooks.beforeBatch; delete hooks.beforeBatch; hook(); }
    batches.push(statements.length);
    sql.exec('BEGIN');
    try {
      const results = statements.map((statement, index) => {
        if (hooks.failAfter === index) throw new Error('Injected late failure');
        return statement.execute();
      });
      sql.exec('COMMIT');
      return results;
    } catch (error) { sql.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  return { sql, d1, hooks, batches, reads: () => reads };
}
