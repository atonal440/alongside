import * as v from 'valibot';
import {
  boundedStringSchema,
  DeferKindSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  LinkTypeSchema,
  ProjectIdSchema,
  ProjectStatusSchema,
  RruleSchema,
  TaskIdSchema,
  TaskStatusSchema,
  TaskTypeSchema,
  type NonEmptyString,
} from '../parse';
import { defineRoute } from './route';

const TASK_TITLE_MAX = 200;
const TASK_NOTES_MAX = 10_000;
const TASK_KICKOFF_MAX = 2_000;
const TASK_SESSION_LOG_MAX = 10_000;
const PROJECT_TITLE_MAX = 200;
const PROJECT_NOTES_MAX = 10_000;
const PROJECT_KICKOFF_MAX = 2_000;

function preservingTitleSchema<const Max extends number>(max: Max) {
  return v.pipe(
    v.string(),
    v.check(value => value.trim().length > 0, 'Expected a non-empty string.'),
    v.check(value => value.trim().length <= max, `Expected at most ${max} characters.`),
    v.transform(value => value as NonEmptyString<Max>),
  );
}

const StrictBooleanQuerySchema = v.pipe(
  v.string(),
  v.check(value => value === 'true' || value === 'false', 'Expected "true" or "false".'),
  v.transform(value => value === 'true'),
);

export const EmptyParamsSchema = v.object({});
export const EmptyQuerySchema = v.object({});
export const EmptyBodySchema = v.object({});

export const TaskIdParamsSchema = v.object({
  task_id: TaskIdSchema,
});

export const ProjectIdParamsSchema = v.object({
  project_id: ProjectIdSchema,
});

export const ExportQuerySchema = v.pipe(
  v.object({
    include_log: v.optional(StrictBooleanQuerySchema),
  }),
  v.transform(query => ({ include_log: query.include_log ?? false })),
);

export const ImportQuerySchema = v.pipe(
  v.object({
    dry_run: v.optional(StrictBooleanQuerySchema),
  }),
  v.transform(query => ({ dry_run: query.dry_run ?? false })),
);

export const TaskCreateBodySchema = v.object({
  title: preservingTitleSchema(TASK_TITLE_MAX),
  notes: v.optional(v.nullable(boundedStringSchema(TASK_NOTES_MAX))),
  due_date: v.optional(v.nullable(IsoDateSchema)),
  recurrence: v.optional(v.nullable(RruleSchema)),
  task_type: v.optional(TaskTypeSchema),
  project_id: v.optional(v.nullable(ProjectIdSchema)),
  kickoff_note: v.optional(v.nullable(boundedStringSchema(TASK_KICKOFF_MAX))),
});

export const TaskUpdateBodySchema = v.object({
  title: v.optional(preservingTitleSchema(TASK_TITLE_MAX)),
  notes: v.optional(v.nullable(boundedStringSchema(TASK_NOTES_MAX))),
  due_date: v.optional(v.nullable(IsoDateSchema)),
  recurrence: v.optional(v.nullable(RruleSchema)),
  kickoff_note: v.optional(v.nullable(boundedStringSchema(TASK_KICKOFF_MAX))),
  session_log: v.optional(v.nullable(boundedStringSchema(TASK_SESSION_LOG_MAX))),
  task_type: v.optional(TaskTypeSchema),
  project_id: v.optional(v.nullable(ProjectIdSchema)),
  status: v.optional(TaskStatusSchema),
  defer_until: v.optional(v.nullable(IsoDateTimeSchema)),
  defer_kind: v.optional(DeferKindSchema),
  focused_until: v.optional(v.nullable(IsoDateTimeSchema)),
});

export const TaskLinkBodySchema = v.object({
  from_task_id: TaskIdSchema,
  to_task_id: TaskIdSchema,
  link_type: LinkTypeSchema,
});

export const ProjectCreateBodySchema = v.object({
  title: preservingTitleSchema(PROJECT_TITLE_MAX),
  kickoff_note: v.optional(v.nullable(boundedStringSchema(PROJECT_KICKOFF_MAX))),
  notes: v.optional(v.nullable(boundedStringSchema(PROJECT_NOTES_MAX))),
});

export const ProjectUpdateBodySchema = v.object({
  title: v.optional(preservingTitleSchema(PROJECT_TITLE_MAX)),
  kickoff_note: v.optional(v.nullable(boundedStringSchema(PROJECT_KICKOFF_MAX))),
  notes: v.optional(v.nullable(boundedStringSchema(PROJECT_NOTES_MAX))),
  status: v.optional(ProjectStatusSchema),
});

export const ImportBodySchema = v.unknown();

export const RestRouteSpecs = {
  listTasks: defineRoute({
    method: 'GET',
    pattern: '/api/tasks',
    params: EmptyParamsSchema,
    query: EmptyQuerySchema,
    body: EmptyBodySchema,
  }),
  syncTasks: defineRoute({
    method: 'GET',
    pattern: '/api/tasks/sync',
    params: EmptyParamsSchema,
    query: EmptyQuerySchema,
    body: EmptyBodySchema,
  }),
  listTaskLinks: defineRoute({
    method: 'GET',
    pattern: '/api/tasks/links',
    params: EmptyParamsSchema,
    query: EmptyQuerySchema,
    body: EmptyBodySchema,
  }),
  createTaskLink: defineRoute({
    method: 'POST',
    pattern: '/api/tasks/links',
    params: EmptyParamsSchema,
    query: EmptyQuerySchema,
    body: TaskLinkBodySchema,
  }),
  deleteTaskLink: defineRoute({
    method: 'DELETE',
    pattern: '/api/tasks/links',
    params: EmptyParamsSchema,
    query: EmptyQuerySchema,
    body: TaskLinkBodySchema,
  }),
  getTask: defineRoute({
    method: 'GET',
    pattern: '/api/tasks/:task_id',
    params: TaskIdParamsSchema,
    query: EmptyQuerySchema,
    body: EmptyBodySchema,
  }),
  createTask: defineRoute({
    method: 'POST',
    pattern: '/api/tasks',
    params: EmptyParamsSchema,
    query: EmptyQuerySchema,
    body: TaskCreateBodySchema,
  }),
  updateTask: defineRoute({
    method: 'PATCH',
    pattern: '/api/tasks/:task_id',
    params: TaskIdParamsSchema,
    query: EmptyQuerySchema,
    body: TaskUpdateBodySchema,
  }),
  deleteTask: defineRoute({
    method: 'DELETE',
    pattern: '/api/tasks/:task_id',
    params: TaskIdParamsSchema,
    query: EmptyQuerySchema,
    body: EmptyBodySchema,
  }),
  completeTask: defineRoute({
    method: 'POST',
    pattern: '/api/tasks/:task_id/complete',
    params: TaskIdParamsSchema,
    query: EmptyQuerySchema,
    body: EmptyBodySchema,
  }),
  listProjects: defineRoute({
    method: 'GET',
    pattern: '/api/projects',
    params: EmptyParamsSchema,
    query: EmptyQuerySchema,
    body: EmptyBodySchema,
  }),
  syncProjects: defineRoute({
    method: 'GET',
    pattern: '/api/projects/sync',
    params: EmptyParamsSchema,
    query: EmptyQuerySchema,
    body: EmptyBodySchema,
  }),
  createProject: defineRoute({
    method: 'POST',
    pattern: '/api/projects',
    params: EmptyParamsSchema,
    query: EmptyQuerySchema,
    body: ProjectCreateBodySchema,
  }),
  getProject: defineRoute({
    method: 'GET',
    pattern: '/api/projects/:project_id',
    params: ProjectIdParamsSchema,
    query: EmptyQuerySchema,
    body: EmptyBodySchema,
  }),
  updateProject: defineRoute({
    method: 'PATCH',
    pattern: '/api/projects/:project_id',
    params: ProjectIdParamsSchema,
    query: EmptyQuerySchema,
    body: ProjectUpdateBodySchema,
  }),
  deleteProject: defineRoute({
    method: 'DELETE',
    pattern: '/api/projects/:project_id',
    params: ProjectIdParamsSchema,
    query: EmptyQuerySchema,
    body: EmptyBodySchema,
  }),
  getActionLog: defineRoute({
    method: 'GET',
    pattern: '/api/action-log',
    params: EmptyParamsSchema,
    query: EmptyQuerySchema,
    body: EmptyBodySchema,
  }),
  exportAll: defineRoute({
    method: 'GET',
    pattern: '/api/export',
    params: EmptyParamsSchema,
    query: ExportQuerySchema,
    body: EmptyBodySchema,
  }),
  importAll: defineRoute({
    method: 'POST',
    pattern: '/api/import',
    params: EmptyParamsSchema,
    query: ImportQuerySchema,
    body: ImportBodySchema,
  }),
} as const;
