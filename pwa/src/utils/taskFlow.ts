import type { Project, Task, TaskLink } from '../types';
import {
  firstNoteEntry,
  formatDue,
  isBlocked,
  isDeferred,
  isFocused,
  isSomeday,
  projectColor,
  projectTitle,
  readinessScore,
} from './design';

export type TaskFlowMode = 'ready' | 'focused' | 'blocked' | 'done' | 'deferred' | 'someday';
export type TaskFlowEmphasis = 'primary' | 'secondary' | 'muted';
export type TaskFlowActionId = 'defer' | 'focus' | 'complete' | 'unfocus' | 'edit' | 'delete' | 'reopen';
export type TaskFlowActionTone = 'primary' | 'neutral' | 'danger';
export type TaskFlowSurface = 'focus' | 'queue' | 'list' | 'detail';
export type TaskFlowPredicateId = 'done' | 'focused' | 'someday' | 'deferred' | 'blocked' | 'ready';

export interface TaskFlowAction {
  id: TaskFlowActionId;
  label: string;
  tone: TaskFlowActionTone;
}

export interface TaskFlowStateDefinition {
  mode: TaskFlowMode;
  predicate: TaskFlowPredicateId;
  emphasis: TaskFlowEmphasis;
  statusLabel: string | ((context: { dueLabel: string }) => string);
  actions: Partial<Record<TaskFlowSurface, TaskFlowActionSet>>;
}

export interface TaskFlowActionSet {
  primaryAction?: TaskFlowAction;
  secondaryActions: TaskFlowAction[];
}

export interface TaskFlow {
  taskId: string;
  mode: TaskFlowMode;
  emphasis: TaskFlowEmphasis;
  statusLabel: string;
  metaLabel: string | null;
  projectLabel: string;
  projectColor: string;
  dueLabel: string;
  readiness: number;
  title: string;
  kickoff: string;
  notePreview: string;
  relationships: {
    blockedBy: string[];
    unlocks: string[];
  };
  primaryAction?: TaskFlowAction;
  secondaryActions: TaskFlowAction[];
}

export interface TaskFlowContext {
  today: string;
  projects: Project[];
  links: TaskLink[];
  tasks?: Task[];
  surface?: TaskFlowSurface;
  selected?: boolean;
}

const completeAction: TaskFlowAction = { id: 'complete', label: 'Done', tone: 'neutral' };
const deleteAction: TaskFlowAction = { id: 'delete', label: 'Delete', tone: 'danger' };
const deferAction: TaskFlowAction = { id: 'defer', label: 'Defer', tone: 'neutral' };
const reopenAction: TaskFlowAction = { id: 'reopen', label: 'Bring back', tone: 'neutral' };
const unfocusAction: TaskFlowAction = { id: 'unfocus', label: 'Unfocus', tone: 'neutral' };

export const TASK_FLOW_CHART: TaskFlowStateDefinition[] = [
  {
    mode: 'done',
    predicate: 'done',
    emphasis: 'muted',
    statusLabel: 'Done',
    actions: {
      detail: actionSet(undefined, editAction('Edit notes'), deleteAction),
      focus: actionSet(undefined, editAction('Edit >')),
      list: actionSet(undefined),
      queue: actionSet(undefined),
    },
  },
  {
    mode: 'focused',
    predicate: 'focused',
    emphasis: 'primary',
    statusLabel: 'In focus',
    actions: {
      detail: actionSet(primaryAction('complete', 'Mark complete'), unfocusAction, deferAction, editAction('Edit notes'), deleteAction),
      focus: actionSet(primaryAction('complete', 'Mark complete'), unfocusAction, deferAction, editAction('Edit >')),
      list: actionSet(primaryAction('focus', 'Focus this ->')),
      queue: actionSet(primaryAction('focus', 'Focus this ->')),
    },
  },
  {
    mode: 'someday',
    predicate: 'someday',
    emphasis: 'muted',
    statusLabel: 'Someday',
    actions: {
      detail: actionSet(reopenAction, completeAction, editAction('Edit notes'), deleteAction),
      focus: actionSet(reopenAction, editAction('Edit >')),
      list: actionSet(reopenAction),
      queue: actionSet(reopenAction),
    },
  },
  {
    mode: 'deferred',
    predicate: 'deferred',
    emphasis: 'muted',
    statusLabel: 'Deferred',
    actions: {
      detail: actionSet(reopenAction, completeAction, editAction('Edit notes'), deleteAction),
      focus: actionSet(reopenAction, editAction('Edit >')),
      list: actionSet(reopenAction),
      queue: actionSet(reopenAction),
    },
  },
  {
    mode: 'blocked',
    predicate: 'blocked',
    emphasis: 'muted',
    statusLabel: 'Blocked',
    actions: {
      detail: actionSet(primaryAction('focus', 'Focus this ->'), completeAction, deferAction, editAction('Edit notes'), deleteAction),
      focus: actionSet(primaryAction('focus', 'Focus this ->'), deferAction, editAction('Edit >')),
      list: actionSet(primaryAction('focus', 'Focus this ->')),
      queue: actionSet(primaryAction('focus', 'Focus this ->')),
    },
  },
  {
    mode: 'ready',
    predicate: 'ready',
    emphasis: 'secondary',
    statusLabel: ({ dueLabel }) => dueLabel || 'Ready',
    actions: {
      detail: actionSet(primaryAction('focus', 'Focus this ->'), completeAction, deferAction, editAction('Edit notes'), deleteAction),
      focus: actionSet(primaryAction('focus', 'Focus this ->'), deferAction, editAction('Edit >')),
      list: actionSet(primaryAction('focus', 'Focus this ->')),
      queue: actionSet(primaryAction('focus', 'Focus this ->')),
    },
  },
];

export function deriveTaskFlow(task: Task, context: TaskFlowContext): TaskFlow {
  const blockedBy = context.links
    .filter(link => link.link_type === 'blocks' && link.to_task_id === task.id)
    .map(link => link.from_task_id);
  const unlocks = context.links
    .filter(link => link.link_type === 'blocks' && link.from_task_id === task.id)
    .map(link => link.to_task_id);

  const dueLabel = formatDue(task, context.today);
  const focused = isFocused(task);
  const someday = isSomeday(task);
  const deferred = isDeferred(task);
  const allTasks = context.tasks ?? [];
  const blocked = isBlocked(task, context.links, allTasks);
  const done = task.status === 'done';
  const predicates: Record<TaskFlowPredicateId, boolean> = {
    done,
    focused,
    someday,
    deferred,
    blocked,
    ready: true,
  };

  const state = TASK_FLOW_CHART.find(definition => predicates[definition.predicate]) ?? TASK_FLOW_CHART[TASK_FLOW_CHART.length - 1];
  const emphasis: TaskFlowEmphasis = context.selected ? 'primary' : state.emphasis;
  const statusLabel = typeof state.statusLabel === 'function'
    ? state.statusLabel({ dueLabel })
    : state.statusLabel;
  const metaLabel = taskFlowMetaLabel(task, state.mode, statusLabel);
  const actions = state.actions[context.surface ?? 'focus'] ?? actionSet(undefined);

  return {
    taskId: task.id,
    mode: state.mode,
    emphasis,
    statusLabel,
    metaLabel,
    projectLabel: projectTitle(task, context.projects),
    projectColor: projectColor(task.project_id),
    dueLabel,
    readiness: readinessScore(task, context.today, context.links, allTasks),
    title: task.title,
    kickoff: task.kickoff_note ?? '',
    notePreview: firstNoteEntry(task.notes),
    relationships: { blockedBy, unlocks },
    primaryAction: actions.primaryAction,
    secondaryActions: actions.secondaryActions,
  };
}

function taskFlowMetaLabel(task: Task, mode: TaskFlowMode, statusLabel: string): string | null {
  switch (mode) {
    case 'ready':
    case 'focused':
      return null;
    case 'deferred':
      return task.defer_until ? `Until ${formatMetaDate(task.defer_until)}` : statusLabel;
    case 'someday':
      return 'Someday';
    case 'done':
      return formatMetaDate(task.updated_at);
    case 'blocked':
      return statusLabel;
  }
}

function formatMetaDate(value: string): string {
  const [datePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(year, month - 1, day));
}

function actionSet(primaryAction?: TaskFlowAction, ...secondaryActions: TaskFlowAction[]): TaskFlowActionSet {
  return { primaryAction, secondaryActions };
}

function primaryAction(id: TaskFlowActionId, label: string): TaskFlowAction {
  return { id, label, tone: 'primary' };
}

function editAction(label: string): TaskFlowAction {
  return { id: 'edit', label, tone: 'neutral' };
}
