import * as v from 'valibot';
import { TaskIdSchema } from '../parse';
import { defineRoute } from './route';

export const UiEmptyQuerySchema = v.object({});
export const UiEmptyBodySchema = v.object({});

export const UiCompleteParamsSchema = v.object({
  task_id: TaskIdSchema,
});

export const UiRouteSpecs = {
  completeTask: defineRoute({
    method: 'POST',
    pattern: '/ui/complete/:task_id',
    params: UiCompleteParamsSchema,
    query: UiEmptyQuerySchema,
    body: UiEmptyBodySchema,
  }),
} as const;
