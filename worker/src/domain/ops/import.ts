import type { Result } from '@shared/result';
import { err, ok } from '@shared/result';
import type { ActionLog, Project, Task, TaskLink } from '@shared/types';
import {
  parseIsoDateTime,
  parsePreferenceKey,
  type InternalPreferenceKey,
  type UserPreferenceKey,
  type ValidationError,
} from '../../parse';
import type { AppError } from '../errors';
import { validationErrorResult } from '../errors';
import type { Plan } from '../Op';
import type { PreferenceEntry } from '../preference';
import { findBlocksCycle } from '../link';
import { taskFromRow } from '../task';

export type ImportPlanResult = Result<Plan, AppError>;

export interface ImportPlanner<Payload> {
  planImport(payload: Payload): ImportPlanResult;
}

export interface ImportPayload {
  version: 1;
  exported_at: string;
  projects: Project[];
  tasks: Task[];
  links: TaskLink[];
  preferences: Record<string, string>;
  action_log?: ActionLog[];
}

const SORT_BY_VALUES = ['readiness', 'due', 'project'] as const;
const URGENCY_VISIBILITY_VALUES = ['show', 'hide'] as const;
const KICKOFF_NUDGE_VALUES = ['always', 'missing', 'never'] as const;
const SESSION_LOG_VALUES = ['ask_at_end', 'auto_generate', 'off'] as const;
const INTERRUPTION_STYLE_VALUES = ['proactive', 'quiet'] as const;
const PLANNING_PROMPT_VALUES = ['auto', 'always', 'never'] as const;

function validationError(path: string[], code: string, message: string): ValidationError {
  return { path, code, message };
}

function withPath(prefix: string[], errors: ValidationError[]): ValidationError[] {
  return errors.map(error => ({ ...error, path: [...prefix, ...error.path] }));
}

function isOneOf<const TValues extends readonly string[]>(
  values: TValues,
  value: string,
): value is TValues[number] {
  return values.includes(value);
}

function duplicateIdErrors<T>(
  rows: readonly T[],
  idOf: (row: T) => string,
  collectionPath: string,
  label: string,
): ValidationError[] {
  const firstIndexById = new Map<string, number>();
  const errors: ValidationError[] = [];

  rows.forEach((row, index) => {
    const id = idOf(row);
    const firstIndex = firstIndexById.get(id);
    if (firstIndex === undefined) {
      firstIndexById.set(id, index);
      return;
    }

    errors.push(validationError(
      [collectionPath, String(index), 'id'],
      'duplicate',
      `${label} id ${id} duplicates ${collectionPath}[${firstIndex}].`,
    ));
  });

  return errors;
}

function duplicateLinkErrors(payload: ImportPayload): ValidationError[] {
  const firstIndexByKey = new Map<string, number>();
  const errors: ValidationError[] = [];

  payload.links.forEach((link, index) => {
    const key = `${link.from_task_id}\u0000${link.to_task_id}\u0000${link.link_type}`;
    const firstIndex = firstIndexByKey.get(key);
    if (firstIndex === undefined) {
      firstIndexByKey.set(key, index);
      return;
    }

    errors.push(validationError(
      ['links', String(index)],
      'duplicate',
      `Link duplicates links[${firstIndex}].`,
    ));
  });

  return errors;
}

function preferenceValueError(key: string, values: readonly string[]): ValidationError {
  return validationError(
    ['preferences', key],
    'picklist',
    `${key} must be one of: ${values.join(', ')}.`,
  );
}

function preferenceEntries(preferences: Record<string, string>): Result<PreferenceEntry[], ValidationError[]> {
  const entries: PreferenceEntry[] = [];
  const errors: ValidationError[] = [];

  for (const [key, value] of Object.entries(preferences)) {
    const parsedKey = parsePreferenceKey(key);
    if (!parsedKey.ok) {
      errors.push(...withPath(['preferences', key], parsedKey.error));
      continue;
    }

    switch (key) {
      case 'sort_by':
        if (!isOneOf(SORT_BY_VALUES, value)) {
          errors.push(preferenceValueError(key, SORT_BY_VALUES));
          break;
        }
        entries.push({ key: parsedKey.value as UserPreferenceKey, name: key, value });
        break;
      case 'urgency_visibility':
        if (!isOneOf(URGENCY_VISIBILITY_VALUES, value)) {
          errors.push(preferenceValueError(key, URGENCY_VISIBILITY_VALUES));
          break;
        }
        entries.push({ key: parsedKey.value as UserPreferenceKey, name: key, value });
        break;
      case 'kickoff_nudge':
        if (!isOneOf(KICKOFF_NUDGE_VALUES, value)) {
          errors.push(preferenceValueError(key, KICKOFF_NUDGE_VALUES));
          break;
        }
        entries.push({ key: parsedKey.value as UserPreferenceKey, name: key, value });
        break;
      case 'session_log':
        if (!isOneOf(SESSION_LOG_VALUES, value)) {
          errors.push(preferenceValueError(key, SESSION_LOG_VALUES));
          break;
        }
        entries.push({ key: parsedKey.value as UserPreferenceKey, name: key, value });
        break;
      case 'interruption_style':
        if (!isOneOf(INTERRUPTION_STYLE_VALUES, value)) {
          errors.push(preferenceValueError(key, INTERRUPTION_STYLE_VALUES));
          break;
        }
        entries.push({ key: parsedKey.value as UserPreferenceKey, name: key, value });
        break;
      case 'planning_prompt':
        if (!isOneOf(PLANNING_PROMPT_VALUES, value)) {
          errors.push(preferenceValueError(key, PLANNING_PROMPT_VALUES));
          break;
        }
        entries.push({ key: parsedKey.value as UserPreferenceKey, name: key, value });
        break;
      case 'last_session_at': {
        const parsedValue = parseIsoDateTime(value);
        if (!parsedValue.ok) {
          errors.push(...withPath(['preferences', key], parsedValue.error));
          break;
        }
        entries.push({ key: parsedKey.value as InternalPreferenceKey, name: key, value: parsedValue.value });
        break;
      }
    }
  }

  return errors.length > 0 ? err(errors) : ok(entries);
}

function validatePayloadRows(payload: ImportPayload): Result<PreferenceEntry[], ValidationError[]> {
  const errors: ValidationError[] = [];

  errors.push(...duplicateIdErrors(payload.projects, project => project.id, 'projects', 'Project'));
  errors.push(...duplicateIdErrors(payload.tasks, task => task.id, 'tasks', 'Task'));
  errors.push(...duplicateLinkErrors(payload));

  const projectIds = new Set(payload.projects.map(project => project.id));
  const taskIds = new Set(payload.tasks.map(task => task.id));

  payload.tasks.forEach((task, index) => {
    const parsedTask = taskFromRow(task);
    if (!parsedTask.ok) errors.push(...withPath(['tasks', String(index)], parsedTask.error));

    if (task.project_id !== null && !projectIds.has(task.project_id)) {
      errors.push(validationError(
        ['tasks', String(index), 'project_id'],
        'unknown_reference',
        `Task ${task.id} references unknown project ${task.project_id}.`,
      ));
    }
  });

  payload.links.forEach((link, index) => {
    if (link.from_task_id === link.to_task_id) {
      errors.push(validationError(
        ['links', String(index), 'to_task_id'],
        'invalid_state',
        'A task cannot be linked to itself.',
      ));
    }

    if (!taskIds.has(link.from_task_id)) {
      errors.push(validationError(
        ['links', String(index), 'from_task_id'],
        'unknown_reference',
        `Link references unknown task ${link.from_task_id}.`,
      ));
    }
    if (!taskIds.has(link.to_task_id)) {
      errors.push(validationError(
        ['links', String(index), 'to_task_id'],
        'unknown_reference',
        `Link references unknown task ${link.to_task_id}.`,
      ));
    }
  });

  const cycle = findBlocksCycle(payload.links);
  if (cycle) {
    errors.push(validationError(
      ['links'],
      'cycle',
      `Blocks links must be acyclic. Cycle: ${cycle.join(' -> ')}.`,
    ));
  }

  const parsedPreferences = preferenceEntries(payload.preferences);
  if (!parsedPreferences.ok) {
    errors.push(...parsedPreferences.error);
    return err(errors);
  }

  return errors.length > 0 ? err(errors) : ok(parsedPreferences.value);
}

export function planImport(payload: ImportPayload): ImportPlanResult {
  const parsedEntries = validatePayloadRows(payload);
  if (!parsedEntries.ok) return err(validationErrorResult(parsedEntries.error));

  return ok({
    assertions: [],
    ops: [
      { kind: 'wipe' },
      ...payload.projects.map(row => ({ kind: 'project.insert' as const, row })),
      ...payload.tasks.map(row => ({ kind: 'task.insert' as const, row })),
      ...payload.links.map(row => ({ kind: 'link.upsert' as const, row })),
      ...parsedEntries.value.map(entry => ({ kind: 'pref.upsert' as const, entry })),
      ...(payload.action_log ?? []).map(entry => ({ kind: 'log.insert' as const, entry })),
    ],
  });
}
