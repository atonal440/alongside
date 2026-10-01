import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

it.each(['fresh', 'upgrade'])('keeps the latest Drizzle snapshot aligned with installed SQL tables, columns and indexes (%s)', mode => {
  const journal = JSON.parse(readFileSync(fileURLToPath(new URL('../drizzle/meta/_journal.json', import.meta.url)), 'utf8'));
  const last = journal.entries.at(-1);
  const snapshot = JSON.parse(readFileSync(fileURLToPath(new URL(`../drizzle/meta/${String(last.idx).padStart(4, '0')}_snapshot.json`, import.meta.url)), 'utf8'));
  const sql = new DatabaseSync(':memory:');
  try {
    if (mode === 'fresh') sql.exec(readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8'));
    else {
      const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
      for (const name of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) sql.exec(readFileSync(`${dir}/${name}`, 'utf8'));
    }
    const tables = sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name).sort();
    expect(Object.keys(snapshot.tables).sort()).toEqual(tables);
    for (const name of tables) {
      const stored = snapshot.tables[name as string];
      // Migration 002 retired session_id without dropping its historical
      // column. Only this known upgrade-only residue is outside the model.
      const columns = sql.prepare('SELECT name FROM pragma_table_info(?)').all(name as string).map(row => row.name)
        .filter(column => !(mode === 'upgrade' && name === 'tasks' && column === 'session_id')).sort();
      expect(Object.keys(stored.columns).sort(), `${name} columns`).toEqual(columns);
      const indexes = sql.prepare("SELECT name FROM pragma_index_list(?) WHERE name NOT LIKE 'sqlite_%'").all(name as string).map(row => row.name).sort();
      expect(Object.keys(stored.indexes).sort(), `${name} indexes`).toEqual(indexes);
    }
  } finally { sql.close(); }
});
