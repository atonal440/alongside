import type {
  BoundedString,
  DoneTaskStatus,
  IsoDate,
  IsoDateTime,
  NonEmptyString,
  PendingTaskStatus,
  ProjectId,
  Rrule,
  RruleParts,
  TaskId,
  TaskType,
} from '../parse';

export type DeferState =
  | { kind: 'none' }
  | { kind: 'someday' }
  | { kind: 'until'; until: IsoDateTime };

export type Focus =
  | { kind: 'unfocused' }
  | { kind: 'focused'; until: IsoDateTime };

export type Recurrence =
  | { kind: 'one_shot' }
  | { kind: 'recurring'; rrule: Rrule; parts: RruleParts; firstDue: IsoDate };

export interface TaskBase {
  id: TaskId;
  title: NonEmptyString<200>;
  notes: BoundedString<10_000> | null;
  taskType: TaskType;
  projectId: ProjectId | null;
  dueDate: IsoDate | null;
  recurrence: Recurrence;
  kickoffNote: BoundedString<2_000> | null;
  sessionLog: BoundedString<10_000> | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type PendingTaskDomain = TaskBase & {
  lifecycle: 'pending';
  status: PendingTaskStatus;
  defer: DeferState;
  focus: Focus;
};

export type DeferredPendingTaskDomain = PendingTaskDomain & {
  defer: Exclude<DeferState, { kind: 'none' }>;
};

export type DoneTaskDomain = TaskBase & {
  lifecycle: 'done';
  status: DoneTaskStatus;
  defer: { kind: 'none' };
  focus: { kind: 'unfocused' };
};

export type TaskDomain = PendingTaskDomain | DoneTaskDomain;
