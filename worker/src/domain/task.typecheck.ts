import type { IsoDateTime, MintedTaskId } from '../parse';
import { completeTaskPlan } from './ops/task';
import type { DoneTaskDomain } from './task';

declare const completedAt: IsoDateTime;
declare const doneTask: DoneTaskDomain;
declare const nextTaskId: MintedTaskId;

// @ts-expect-error completeTaskPlan only accepts pending tasks.
completeTaskPlan(doneTask, { completedAt, nextTaskId });
