import type { Result } from '@shared/result';
import { ok } from '@shared/result';
import type { IsoDateTime, TaskId } from '../../parse';
import type { AppError } from '../errors';
import type { Plan, ProjectRow } from '../Op';

export type ProjectPlanResult = Result<Plan, AppError>;

export function createProjectPlan(
  project: ProjectRow,
  taskIds: TaskId[],
  updatedAt: IsoDateTime,
): ProjectPlanResult {
  const uniqueTaskIds = [...new Set(taskIds)];

  return ok({
    assertions: uniqueTaskIds.map(id => ({ kind: 'task.exists', id })),
    ops: [
      { kind: 'project.insert', row: project },
      ...uniqueTaskIds.map(id => ({
        kind: 'task.update' as const,
        id,
        patch: { project_id: project.id, updated_at: updatedAt },
      })),
    ],
  });
}

export interface ProjectPlanner {
  createProjectPlan(project: ProjectRow, taskIds: TaskId[], updatedAt: IsoDateTime): ProjectPlanResult;
}
