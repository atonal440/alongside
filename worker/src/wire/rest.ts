import * as v from 'valibot';
import { ProjectIdSchema, TaskIdSchema } from '../parse';
import { defineRoute } from './route';

export const EmptyParamsSchema = v.object({});
export const EmptyQuerySchema = v.object({});
export const EmptyBodySchema = v.object({});

export const TaskIdParamsSchema = v.object({
  task_id: TaskIdSchema,
});

export const ProjectIdParamsSchema = v.object({
  project_id: ProjectIdSchema,
});

export const RestRouteSpecs = {
  getTask: defineRoute({
    method: 'GET',
    pattern: '/api/tasks/:task_id',
    params: TaskIdParamsSchema,
    query: EmptyQuerySchema,
    body: EmptyBodySchema,
  }),
  getProject: defineRoute({
    method: 'GET',
    pattern: '/api/projects/:project_id',
    params: ProjectIdParamsSchema,
    query: EmptyQuerySchema,
    body: EmptyBodySchema,
  }),
} as const;
