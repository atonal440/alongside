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

function storageError(message: string, cause: unknown): AppError {
  return { kind: 'storage', message, cause };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled plan variant: ${JSON.stringify(value)}`);
}

async function runPreCheck(d1: D1Database, check: PreCheck): Promise<Result<void, AppError>> {
  try {
    switch (check.kind) {
      case 'task.exists': {
        const row = await d1
          .prepare('SELECT id FROM tasks WHERE id = ? LIMIT 1')
          .bind(check.id)
          .first<{ id: string }>();
        return row ? ok(undefined) : err({ kind: 'not_found', entity: 'task', id: check.id });
      }
      case 'project.exists': {
        const row = await d1
          .prepare('SELECT id FROM projects WHERE id = ? LIMIT 1')
          .bind(check.id)
          .first<{ id: string }>();
        return row ? ok(undefined) : err({ kind: 'not_found', entity: 'project', id: check.id });
      }
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
  } catch (cause) {
    return err(storageError(`Failed to run ${check.kind} precheck.`, cause));
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

function opStatements(d1: D1Database, op: Op): D1PreparedStatement[] {
  switch (op.kind) {
    case 'task.insert':
      return [bindInsert(d1, 'tasks', TASK_INSERT_COLUMNS, op.row)];
    case 'task.update': {
      const statement = bindUpdate(d1, 'tasks', 'id', op.id, TASK_UPDATE_COLUMNS, op.patch);
      return statement ? [statement] : [];
    }
    case 'task.delete':
      return [d1.prepare('DELETE FROM tasks WHERE id = ?').bind(op.id)];
    case 'project.insert':
      return [bindInsert(d1, 'projects', PROJECT_INSERT_COLUMNS, op.row)];
    case 'project.update': {
      const statement = bindUpdate(d1, 'projects', 'id', op.id, PROJECT_UPDATE_COLUMNS, op.patch);
      return statement ? [statement] : [];
    }
    case 'project.delete':
      return [d1.prepare('DELETE FROM projects WHERE id = ?').bind(op.id)];
    case 'link.upsert':
      return [
        d1
          .prepare('INSERT OR REPLACE INTO task_links (from_task_id,to_task_id,link_type) VALUES (?,?,?)')
          .bind(op.row.from_task_id, op.row.to_task_id, op.row.link_type),
      ];
    case 'link.delete':
      return [
        d1
          .prepare('DELETE FROM task_links WHERE from_task_id = ? AND to_task_id = ? AND link_type = ?')
          .bind(op.from, op.to, op.linkType),
      ];
    case 'pref.upsert':
      return [
        d1
          .prepare('INSERT OR REPLACE INTO user_preferences (key,value) VALUES (?,?)')
          .bind(op.entry.key, op.entry.value),
      ];
    case 'log.insert':
      return [
        d1
          .prepare('INSERT INTO action_log (tool_name,task_id,title,detail,created_at) VALUES (?,?,?,?,?)')
          .bind(op.entry.tool_name, op.entry.task_id, op.entry.title, op.entry.detail, op.entry.created_at),
      ];
    case 'wipe':
      return [
        d1.prepare('DELETE FROM task_links'),
        d1.prepare('DELETE FROM action_log'),
        d1.prepare('DELETE FROM tasks'),
        d1.prepare('DELETE FROM projects'),
        d1.prepare('DELETE FROM user_preferences'),
      ];
    default:
      return assertNever(op);
  }
}

export async function applyPlan(d1: D1Database, plan: Plan): Promise<ApplyResult> {
  for (const assertion of plan.assertions) {
    const checked = await runPreCheck(d1, assertion);
    if (!checked.ok) return checked;
  }

  try {
    const statements = plan.ops.flatMap(op => opStatements(d1, op));
    if (statements.length > 0) await d1.batch(statements);
    return ok({ appliedOps: plan.ops.length });
  } catch (cause) {
    return err(storageError('Failed to apply mutation plan.', cause));
  }
}
