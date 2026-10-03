import type { Result } from '@shared/result';
import { err, ok } from '@shared/result';
import type { AppError } from '../domain/errors';
import type { Op, Plan, PreCheck, ProjectRowPatch, TaskRowPatch } from '../domain/Op';
import { entityStorageKey, parseEntityVersionResponse, type EntityKey, type EntityVersionResponse } from '@shared/wire/versions';

/** One statement returns a coherent entity/aggregate revision pair. */
export async function readEntityVersion(d1: D1Database, key: EntityKey): Promise<EntityVersionResponse> {
  const row = await d1.prepare(`SELECT w.structural_revision, e.revision, e.deleted_at
    FROM workspace_versions w LEFT JOIN entity_versions e ON e.entity=? AND e.entity_key=? WHERE w.id=1`)
    .bind(key.entity, entityStorageKey(key)).first<{ structural_revision: number; revision: number | null; deleted_at: string | null }>();
  if (!row) throw new Error('Workspace version singleton is missing.');
  const parsed = parseEntityVersionResponse({ contractVersion: 2, key, structuralRevision: row.structural_revision,
    version: row.revision === null ? null : { revision: row.revision, deletedAt: row.deleted_at },
  });
  if (!parsed.ok) throw new Error('Stored entity versions failed validation.');
  return parsed.value;
}

export interface ApplySummary {
  appliedOps: number;
}

export type ApplyResult = Result<ApplySummary, AppError>;

export interface PlanApplier {
  apply(plan: Plan): Promise<ApplyResult>;
}

interface ExistingRowGuard {
  entity: 'task' | 'project';
  id: string;
}

interface PlannedStatement {
  statement: D1PreparedStatement;
  guard?: ExistingRowGuard;
}

const TASK_INSERT_COLUMNS = [
  'id',
  'title',
  'notes',
  'status',
  'due_date',
  'due_all_day',
  'recurrence',
  'created_at',
  'updated_at',
  'defer_until',
  'defer_kind',
  'task_type',
  'project_id',
  'kickoff_note',
  'session_log',
  'focused_until',
  'duty_id',
  'occurrence_at',
] as const;

const TASK_RESTORE_COLUMNS = TASK_INSERT_COLUMNS;
const DUTY_RESTORE_COLUMNS = [
  'id', 'title', 'notes', 'kickoff_note', 'task_type', 'project_id', 'rrule', 'dtstart', 'timezone', 'status',
  'catch_up', 'last_spawned_at', 'next_occurrence_at', 'created_at', 'updated_at',
] as const;
const LOG_RESTORE_COLUMNS = ['id', 'tool_name', 'task_id', 'duty_id', 'title', 'detail', 'created_at'] as const;

const TASK_UPDATE_COLUMNS = [
  'title',
  'notes',
  'status',
  'due_date',
  'due_all_day',
  'recurrence',
  'updated_at',
  'defer_until',
  'defer_kind',
  'task_type',
  'project_id',
  'kickoff_note',
  'session_log',
  'focused_until',
] as const satisfies readonly (keyof TaskRowPatch)[];

const PROJECT_INSERT_COLUMNS = [
  'id',
  'title',
  'notes',
  'kickoff_note',
  'status',
  'created_at',
  'updated_at',
] as const;

const PROJECT_UPDATE_COLUMNS = [
  'title',
  'notes',
  'kickoff_note',
  'status',
  'updated_at',
] as const satisfies readonly (keyof ProjectRowPatch)[];

const TASK_EXISTS_GUARD_SQL =
  "INSERT INTO tasks (title,status,created_at,updated_at,defer_kind,task_type) SELECT NULL,'pending','','','none','action' WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE id = ?)";

const PROJECT_EXISTS_GUARD_SQL =
  "INSERT INTO projects (title,status,created_at,updated_at) SELECT NULL,'active','','' WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id = ?)";
const BLOCKS_ACYCLIC_GUARD_SQL = `
INSERT INTO task_links (from_task_id,to_task_id,link_type)
SELECT NULL,NULL,'blocks'
WHERE ? = ? OR EXISTS (
  WITH RECURSIVE downstream(id) AS (
    SELECT to_task_id
    FROM task_links
    WHERE from_task_id = ? AND link_type = 'blocks'
    UNION
    SELECT task_links.to_task_id
    FROM task_links
    JOIN downstream ON task_links.from_task_id = downstream.id
    WHERE task_links.link_type = 'blocks'
  )
  SELECT 1 FROM downstream WHERE id = ? LIMIT 1
)`;
export const MAX_ATOMIC_STATEMENTS = 100;

function storageError(message: string, cause: unknown): AppError {
  return { kind: 'storage', message, cause };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled plan variant: ${JSON.stringify(value)}`);
}

async function runExistingRowCheck(d1: D1Database, guard: ExistingRowGuard): Promise<Result<void, AppError>> {
  try {
    switch (guard.entity) {
      case 'task': {
        const row = await d1
          .prepare('SELECT id FROM tasks WHERE id = ? LIMIT 1')
          .bind(guard.id)
          .first<{ id: string }>();
        return row ? ok(undefined) : err({ kind: 'not_found', entity: 'task', id: guard.id });
      }
      case 'project': {
        const row = await d1
          .prepare('SELECT id FROM projects WHERE id = ? LIMIT 1')
          .bind(guard.id)
          .first<{ id: string }>();
        return row ? ok(undefined) : err({ kind: 'not_found', entity: 'project', id: guard.id });
      }
      default:
        return assertNever(guard.entity);
    }
  } catch (cause) {
    return err(storageError(`Failed to run ${guard.entity} existence check.`, cause));
  }
}

async function runBlocksAcyclicCheck(d1: D1Database, from: string, to: string): Promise<Result<void, AppError>> {
  if (from === to) {
    return err({
      kind: 'conflict',
      message: 'A task cannot block itself.',
    });
  }

  try {
    const cycle = await d1
      .prepare(`
        WITH RECURSIVE downstream(id) AS (
          SELECT to_task_id
          FROM task_links
          WHERE from_task_id = ? AND link_type = 'blocks'
          UNION
          SELECT task_links.to_task_id
          FROM task_links
          JOIN downstream ON task_links.from_task_id = downstream.id
          WHERE task_links.link_type = 'blocks'
        )
        SELECT id FROM downstream WHERE id = ? LIMIT 1
      `)
      .bind(to, from)
      .first<{ id: string }>();

    return cycle
      ? err({
        kind: 'conflict',
        message: `Adding a blocks link from ${from} to ${to} would create a cycle.`,
      })
      : ok(undefined);
  } catch (cause) {
    return err(storageError('Failed to run link cycle check.', cause));
  }
}

async function runPreCheck(d1: D1Database, check: PreCheck): Promise<Result<void, AppError>> {
  switch (check.kind) {
    case 'entity.revision': {
      try {
        const current = await readEntityVersion(d1, check.key);
        return (current.version?.revision ?? null) === check.expected ? ok(undefined) : err({ kind: 'conflict', message: 'Entity revision changed.' });
      } catch (cause) { return err(storageError('Failed to read entity revision.', cause)); }
    }
    case 'workspace.structural_revision': {
      try {
        const row = await d1.prepare('SELECT structural_revision FROM workspace_versions WHERE id=1').first<{ structural_revision: number }>();
        return row?.structural_revision === check.expected ? ok(undefined) : err({ kind: 'conflict', message: 'Workspace structure changed.' });
      } catch (cause) { return err(storageError('Failed to read structural revision.', cause)); }
    }
    case 'task.exists':
      return runExistingRowCheck(d1, { entity: 'task', id: check.id });
    case 'project.exists':
      return runExistingRowCheck(d1, { entity: 'project', id: check.id });
    case 'link.blocks_acyclic':
      return runBlocksAcyclicCheck(d1, check.from, check.to);
    case 'planning.revision': {
      try {
        const row = await d1.prepare('SELECT revision FROM planning_settings WHERE id = 1').first<{ revision: number }>();
        return (row?.revision ?? null) === check.expected ? ok(undefined) : err({ kind: 'conflict', message: 'Planning settings revision changed.' });
      } catch (cause) {
        return err(storageError('Failed to read planning revision.', cause));
      }
    }
    case 'sync.cursor': {
      try {
        const row = await d1.prepare('SELECT epoch, watermark FROM sync_metadata WHERE id=1').first<{ epoch: number; watermark: number }>();
        return row?.epoch === check.epoch && row.watermark === check.sequence ? ok(undefined) : err({ kind: 'conflict', message: 'Workspace changed since the supplied sync cursor.' });
      } catch (cause) { return err(storageError('Failed to read sync cursor.', cause)); }
    }
    case 'custom':
      return err({
        kind: 'invariant_violation',
        message: `Custom precheck is not supported by applyPlan: ${check.description}`,
      });
    default:
      return assertNever(check);
  }
}

function bindBlocksAcyclicGuard(d1: D1Database, from: string, to: string): PlannedStatement {
  return guardedStatement(d1.prepare(BLOCKS_ACYCLIC_GUARD_SQL).bind(from, to, to, from));
}

function bindPreCheckGuard(d1: D1Database, check: PreCheck): PlannedStatement[] {
  switch (check.kind) {
    case 'entity.revision': {
      const condition = check.expected === null
        ? 'EXISTS (SELECT 1 FROM entity_versions WHERE entity=? AND entity_key=?)'
        : 'NOT EXISTS (SELECT 1 FROM entity_versions WHERE entity=? AND entity_key=? AND revision=?)';
      // Deliberately violate NOT NULL to abort the entire transactional batch.
      const statement = d1.prepare(`INSERT INTO entity_versions(entity,entity_key,revision) SELECT NULL,'',0 WHERE ${condition}`);
      const args = [check.key.entity, entityStorageKey(check.key)];
      return [guardedStatement(check.expected === null ? statement.bind(...args) : statement.bind(...args, check.expected))];
    }
    case 'workspace.structural_revision':
      return [guardedStatement(d1.prepare(`INSERT INTO workspace_versions(id,structural_revision) SELECT 1,NULL
        WHERE NOT EXISTS (SELECT 1 FROM workspace_versions WHERE id=1 AND structural_revision=?)`).bind(check.expected))];
    case 'task.exists':
      return [bindExistingRowGuard(d1, { entity: 'task', id: check.id })];
    case 'project.exists':
      return [bindExistingRowGuard(d1, { entity: 'project', id: check.id })];
    case 'link.blocks_acyclic':
      return [bindBlocksAcyclicGuard(d1, check.from, check.to)];
    case 'planning.revision': {
      // Fail a NOT NULL constraint inside the same batch if the precondition
      // changed after planning. A pre-read alone cannot prevent an overwrite.
      const condition = check.expected === null
        ? 'EXISTS (SELECT 1 FROM planning_settings WHERE id = 1)'
        : 'NOT EXISTS (SELECT 1 FROM planning_settings WHERE id = 1 AND revision = ?)';
      const statement = d1.prepare(`INSERT INTO planning_settings (id,timezone,created_at,updated_at) SELECT 1,NULL,'','' WHERE ${condition}`);
      return [guardedStatement(check.expected === null ? statement : statement.bind(check.expected))];
    }
    case 'sync.cursor':
      // Violates the singleton CHECK (and trigger) inside the batch if any writer advanced the feed.
      return [guardedStatement(d1.prepare(`INSERT INTO sync_metadata(id) SELECT 2
        WHERE NOT EXISTS (SELECT 1 FROM sync_metadata WHERE id=1 AND epoch=? AND watermark=?)`).bind(check.epoch, check.sequence))];
    case 'custom':
      return [];
    default:
      return assertNever(check);
  }
}

// D1/SQLite's raw bind() rejects JS booleans outright (unlike Drizzle's own
// insert/update paths, which convert boolean-mode columns internally) — this
// raw layer has to do that conversion itself.
function toBindable(value: unknown): unknown {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

function bindInsert<Row extends Record<string, unknown>>(
  d1: D1Database,
  table: string,
  columns: readonly (keyof Row & string)[],
  row: Row,
): D1PreparedStatement {
  const placeholders = columns.map(() => '?').join(',');
  const values = columns.map(column => toBindable(row[column]));
  return d1
    .prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`)
    .bind(...values);
}

function bindUpdate<Patch extends Record<string, unknown>>(
  d1: D1Database,
  table: string,
  idColumn: string,
  id: string,
  allowedColumns: readonly (keyof Patch & string)[],
  patch: Patch,
): D1PreparedStatement | null {
  const columns = allowedColumns.filter(column => Object.prototype.hasOwnProperty.call(patch, column));
  if (columns.length === 0) return null;

  const setClause = columns.map(column => `${column} = ?`).join(', ');
  const values = columns.map(column => toBindable(patch[column]));
  return d1
    .prepare(`UPDATE ${table} SET ${setClause} WHERE ${idColumn} = ?`)
    .bind(...values, id);
}

function bindExistingRowGuard(d1: D1Database, guard: ExistingRowGuard): PlannedStatement {
  const sql = guard.entity === 'task' ? TASK_EXISTS_GUARD_SQL : PROJECT_EXISTS_GUARD_SQL;
  return {
    statement: d1.prepare(sql).bind(guard.id),
    guard,
  };
}

function guardedStatement(statement: D1PreparedStatement, guard?: ExistingRowGuard): PlannedStatement {
  return guard ? { statement, guard } : { statement };
}

function opStatements(d1: D1Database, op: Op): PlannedStatement[] {
  switch (op.kind) {
    case 'planning.replace':
      return [
        guardedStatement(d1.prepare(`INSERT INTO planning_settings(id,timezone,buffer_minutes,revision,created_at,updated_at) VALUES(1,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET timezone=excluded.timezone,buffer_minutes=excluded.buffer_minutes,revision=excluded.revision,updated_at=excluded.updated_at`)
          .bind(op.settings.timezone, op.settings.bufferMinutes, op.settings.revision, op.now, op.now)),
        guardedStatement(d1.prepare('DELETE FROM planning_working_hours WHERE settings_id = 1')),
        ...op.settings.workingHours.map(hour => guardedStatement(d1.prepare('INSERT INTO planning_working_hours(settings_id,weekday,start_time,end_time) VALUES(1,?,?,?)').bind(hour.weekday, hour.start, hour.end))),
      ];
    case 'receipt.insert':
      return [guardedStatement(d1.prepare('INSERT INTO command_receipts(command_id,payload_hash,result_json,created_at) VALUES(?,?,?,?)')
        .bind(op.result.commandId, op.result.payloadHash, JSON.stringify(op.result), op.result.serverNow))];
    case 'command.audit':
      return [guardedStatement(d1.prepare('INSERT INTO command_audit(command_id,actor,reason,changes_json,created_at) VALUES(?,?,?,?,?)')
        .bind(op.commandId, op.actor, op.reason, JSON.stringify(op.result.changes), op.result.serverNow))];
    case 'command.feed':
      return op.result.changes.map(change => guardedStatement(d1.prepare(`INSERT INTO change_feed(command_id,entity,entity_id,revision,operation,payload_json,created_at) VALUES(?,?,?,?,?,?,?)`)
        .bind(op.result.commandId, change.entity, change.id, change.after.revision, 'deleted' in change.after ? 'delete' : 'upsert', JSON.stringify(change.after), op.result.serverNow)));
    case 'duty.update_cursor':
      return [guardedStatement(d1.prepare(`UPDATE duties
        SET last_spawned_at=?, next_occurrence_at=?, updated_at=?
        WHERE id=? AND status='active' AND (last_spawned_at IS NULL OR last_spawned_at<?)`)
        .bind(op.lastSpawnedAt, op.nextOccurrenceAt, op.updatedAt, op.id, op.lastSpawnedAt))];
    case 'task.insert': {
      if ((op.row.duty_id === null) !== (op.row.occurrence_at === null)) {
        throw new Error('Duty identity and occurrence must be supplied together.');
      }
      if (op.row.duty_id !== null) {
        const values = TASK_INSERT_COLUMNS.map(column => toBindable(op.row[column]));
        return [guardedStatement(d1.prepare(`INSERT INTO tasks (${TASK_INSERT_COLUMNS.join(',')})
          SELECT ${TASK_INSERT_COLUMNS.map(() => '?').join(',')}
          WHERE EXISTS (SELECT 1 FROM duties WHERE id=? AND status='active'
            AND (last_spawned_at IS NULL OR last_spawned_at<?))
          ON CONFLICT(duty_id,occurrence_at) DO NOTHING`)
          .bind(...values, op.row.duty_id, op.row.occurrence_at))];
      }
      return [guardedStatement(bindInsert(d1, 'tasks', TASK_INSERT_COLUMNS, op.row))];
    }
    case 'task.update': {
      const guard = { entity: 'task' as const, id: op.id };
      const statement = bindUpdate(d1, 'tasks', 'id', op.id, TASK_UPDATE_COLUMNS, op.patch);
      return statement ? [bindExistingRowGuard(d1, guard), guardedStatement(statement, guard)] : [];
    }
    case 'task.delete':
      return [
        bindExistingRowGuard(d1, { entity: 'task', id: op.id }),
        guardedStatement(d1.prepare('DELETE FROM tasks WHERE id = ?').bind(op.id), { entity: 'task', id: op.id }),
      ];
    case 'project.insert':
      return [guardedStatement(bindInsert(d1, 'projects', PROJECT_INSERT_COLUMNS, op.row))];
    case 'project.update': {
      const guard = { entity: 'project' as const, id: op.id };
      const statement = bindUpdate(d1, 'projects', 'id', op.id, PROJECT_UPDATE_COLUMNS, op.patch);
      return statement ? [bindExistingRowGuard(d1, guard), guardedStatement(statement, guard)] : [];
    }
    case 'project.delete_empty':
      return [bindExistingRowGuard(d1, { entity: 'project', id: op.id }),
        guardedStatement(d1.prepare('DELETE FROM projects WHERE id = ?').bind(op.id), { entity: 'project', id: op.id })];
    case 'project.delete':
      return [
        bindExistingRowGuard(d1, { entity: 'project', id: op.id }),
        guardedStatement(d1.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').bind(op.id)),
        guardedStatement(d1.prepare('DELETE FROM projects WHERE id = ?').bind(op.id), { entity: 'project', id: op.id }),
      ];
    case 'graph.assert_acyclic':
      return [bindBlocksAcyclicGuard(d1, op.from, op.to)];
    case 'link.insert':
      return [guardedStatement(d1.prepare('INSERT INTO task_links(from_task_id,to_task_id,link_type) VALUES(?,?,?)')
        .bind(op.row.from_task_id, op.row.to_task_id, op.row.link_type))];
    case 'link.upsert':
      return [
        guardedStatement(
          d1
            .prepare('INSERT OR REPLACE INTO task_links (from_task_id,to_task_id,link_type) VALUES (?,?,?)')
            .bind(op.row.from_task_id, op.row.to_task_id, op.row.link_type),
        ),
      ];
    case 'link.delete':
      return [
        guardedStatement(
          d1
            .prepare('DELETE FROM task_links WHERE from_task_id = ? AND to_task_id = ? AND link_type = ?')
            .bind(op.from, op.to, op.linkType),
        ),
      ];
    case 'pref.upsert':
      return [
        guardedStatement(
          d1
            .prepare('INSERT OR REPLACE INTO user_preferences (key,value) VALUES (?,?)')
            .bind(op.entry.key, op.entry.value),
        ),
      ];
    case 'log.insert':
      return [
        guardedStatement(
          d1
            .prepare('INSERT INTO action_log (tool_name,task_id,title,detail,created_at) VALUES (?,?,?,?,?)')
            .bind(op.entry.tool_name, op.entry.task_id, op.entry.title, op.entry.detail, op.entry.created_at),
        ),
      ];
    case 'sync.epoch_advance':
      return [guardedStatement(d1.prepare('UPDATE sync_metadata SET epoch=epoch+1 WHERE id=1'))];
    case 'workspace.wipe':
      // Dependency order: tasks reference duties, duties/tasks reference projects. Receipts,
      // audit, credentials and sync/version ledgers are deliberately retained.
      return ['task_links', 'action_log', 'tasks', 'duties', 'projects', 'user_preferences', 'planning_settings']
        .map(table => guardedStatement(d1.prepare(`DELETE FROM ${table}`)));
    case 'duty.restore':
      return [guardedStatement(bindInsert(d1, 'duties', DUTY_RESTORE_COLUMNS, op.row))];
    case 'task.restore':
      return [guardedStatement(bindInsert(d1, 'tasks', TASK_RESTORE_COLUMNS, op.row))];
    case 'pref.restore':
      return [guardedStatement(d1.prepare('INSERT INTO user_preferences (key,value) VALUES (?,?)').bind(op.key, op.value))];
    case 'log.restore':
      return [guardedStatement(bindInsert(d1, 'action_log', LOG_RESTORE_COLUMNS, op.entry))];
    case 'wipe':
      return [
        guardedStatement(d1.prepare('DELETE FROM task_links')),
        guardedStatement(d1.prepare('DELETE FROM action_log')),
        guardedStatement(d1.prepare('DELETE FROM tasks')),
        guardedStatement(d1.prepare('DELETE FROM projects')),
        guardedStatement(d1.prepare('DELETE FROM user_preferences')),
      ];
    default:
      return assertNever(op);
  }
}

async function findMissingGuard(d1: D1Database, guards: ExistingRowGuard[]): Promise<AppError | null> {
  for (const guard of guards) {
    const checked = await runExistingRowCheck(d1, guard);
    if (!checked.ok) return checked.error;
  }
  return null;
}

async function findFailedPreCheck(d1: D1Database, checks: PreCheck[]): Promise<AppError | null> {
  for (const check of checks) {
    const checked = await runPreCheck(d1, check);
    if (!checked.ok) return checked.error;
  }
  return null;
}

// Build the actual SQL before accepting a plan. Preparing/binding performs no
// I/O; guards, wipe side effects, logs and future receipt/feed ops count exactly
// as they will execute. No parallel hand-maintained count can drift from SQL.
function prepareAtomicPlan(d1: D1Database, plan: Plan): Result<PlannedStatement[], AppError> {
  try {
    const statements = [
      ...plan.assertions.flatMap(assertion => bindPreCheckGuard(d1, assertion)),
      ...plan.ops.flatMap(op => opStatements(d1, op)),
    ];
    if (statements.length > MAX_ATOMIC_STATEMENTS) {
      return err({ kind: 'capacity_exceeded', requiredStatements: statements.length, limit: MAX_ATOMIC_STATEMENTS });
    }
    return ok(statements);
  } catch (cause) {
    return err(storageError('Failed to prepare mutation plan.', cause));
  }
}

/** Side-effect-free acceptance check, shared by import preview and apply. */
export function checkPlanCapacity(d1: D1Database, plan: Plan): Result<{ requiredStatements: number; limit: number }, AppError> {
  const prepared = prepareAtomicPlan(d1, plan);
  return prepared.ok ? ok({ requiredStatements: prepared.value.length, limit: MAX_ATOMIC_STATEMENTS }) : prepared;
}

export async function applyPlan(d1: D1Database, plan: Plan): Promise<ApplyResult> {
  const prepared = prepareAtomicPlan(d1, plan);
  if (!prepared.ok) return prepared;

  for (const assertion of plan.assertions) {
    const checked = await runPreCheck(d1, assertion);
    if (!checked.ok) return checked;
  }
  if (plan.ops.length === 0) return ok({ appliedOps: 0 });

  const guards = prepared.value.flatMap(item => item.guard ? [item.guard] : []);
  try {
    const statements = prepared.value.map(item => item.statement);
    // A logical plan is always one transactional D1 batch. Oversized work needs
    // a separately designed staging protocol, never wipe-then-chunk.
    if (statements.length > 0) await d1.batch(statements);
    return ok({ appliedOps: plan.ops.length });
  } catch (cause) {
    const missing = await findMissingGuard(d1, guards);
    if (missing) return err(missing);
    const failedPreCheck = await findFailedPreCheck(d1, plan.assertions);
    if (failedPreCheck) return err(failedPreCheck);
    return err(storageError('Failed to apply mutation plan.', cause));
  }
}
