import type { Result } from '@shared/result';
import { err, ok } from '@shared/result';
import type { AppError } from '../domain/errors';
import type { Op, Plan, PreCheck, ProjectRowPatch, TaskRowPatch } from '../domain/Op';

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
] as const;

const TASK_UPDATE_COLUMNS = [
  'title',
  'notes',
  'status',
  'due_date',
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
const MAX_BATCH_STATEMENTS = 100;

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

async function runPreCheck(d1: D1Database, check: PreCheck): Promise<Result<void, AppError>> {
  switch (check.kind) {
    case 'task.exists':
      return runExistingRowCheck(d1, { entity: 'task', id: check.id });
    case 'project.exists':
      return runExistingRowCheck(d1, { entity: 'project', id: check.id });
    case 'link.blocks_acyclic':
      return err({
        kind: 'invariant_violation',
        message: 'link.blocks_acyclic prechecks are not supported until the link graph slice.',
      });
    case 'custom':
      return err({
        kind: 'invariant_violation',
        message: `Custom precheck is not supported by applyPlan: ${check.description}`,
      });
    default:
      return assertNever(check);
  }
}

function guardForPreCheck(check: PreCheck): ExistingRowGuard | null {
  switch (check.kind) {
    case 'task.exists':
      return { entity: 'task', id: check.id };
    case 'project.exists':
      return { entity: 'project', id: check.id };
    case 'link.blocks_acyclic':
    case 'custom':
      return null;
    default:
      return assertNever(check);
  }
}

function bindInsert<Row extends Record<string, unknown>>(
  d1: D1Database,
  table: string,
  columns: readonly (keyof Row & string)[],
  row: Row,
): D1PreparedStatement {
  const placeholders = columns.map(() => '?').join(',');
  const values = columns.map(column => row[column]);
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
  const values = columns.map(column => patch[column]);
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
    case 'task.insert':
      return [guardedStatement(bindInsert(d1, 'tasks', TASK_INSERT_COLUMNS, op.row))];
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
    case 'project.delete':
      return [
        bindExistingRowGuard(d1, { entity: 'project', id: op.id }),
        guardedStatement(d1.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').bind(op.id)),
        guardedStatement(d1.prepare('DELETE FROM projects WHERE id = ?').bind(op.id), { entity: 'project', id: op.id }),
      ];
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

async function runPlannedStatements(
  d1: D1Database,
  statements: D1PreparedStatement[],
  canChunk: boolean,
): Promise<void> {
  if (statements.length <= MAX_BATCH_STATEMENTS || !canChunk) {
    await d1.batch(statements);
    return;
  }

  // D1 has no transaction primitive across batches. Chunk only plans with no
  // row-existence guards so guard+mutation pairs stay atomic for normal flows.
  for (let index = 0; index < statements.length; index += MAX_BATCH_STATEMENTS) {
    await d1.batch(statements.slice(index, index + MAX_BATCH_STATEMENTS));
  }
}

export async function applyPlan(d1: D1Database, plan: Plan): Promise<ApplyResult> {
  for (const assertion of plan.assertions) {
    const checked = await runPreCheck(d1, assertion);
    if (!checked.ok) return checked;
  }

  if (plan.ops.length === 0) return ok({ appliedOps: 0 });

  let guards: ExistingRowGuard[] = [];
  try {
    const assertionGuards = plan.assertions.flatMap(assertion => {
      const guard = guardForPreCheck(assertion);
      return guard ? [bindExistingRowGuard(d1, guard)] : [];
    });
    const plannedStatements = [
      ...assertionGuards,
      ...plan.ops.flatMap(op => opStatements(d1, op)),
    ];
    const statements = plannedStatements.map(item => item.statement);
    guards = plannedStatements.flatMap(item => item.guard ? [item.guard] : []);

    if (statements.length > 0) await runPlannedStatements(d1, statements, guards.length === 0);
    return ok({ appliedOps: plan.ops.length });
  } catch (cause) {
    const missing = await findMissingGuard(d1, guards);
    if (missing) return err(missing);
    return err(storageError('Failed to apply mutation plan.', cause));
  }
}
