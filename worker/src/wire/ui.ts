import * as v from 'valibot';
import { TaskIdSchema } from '../parse';

export const UiCompleteParamsSchema = v.object({
  task_id: TaskIdSchema,
});
