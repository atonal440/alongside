import type { IsoDateTime, MintedTaskId } from '../../src/parse';
import { completeTaskPlan } from '../../src/domain/ops/task';
import type { DoneTaskDomain } from '../../src/domain/task';

declare const completedAt: IsoDateTime;
declare const doneTask: DoneTaskDomain;
declare const nextTaskId: MintedTaskId;

// @ts-expect-error completeTaskPlan only accepts pending tasks.
completeTaskPlan(doneTask, { completedAt, nextTaskId });
