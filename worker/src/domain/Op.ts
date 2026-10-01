import type { ActionLog, Project, Task, TaskLink } from '@shared/types';
import type { LinkType, ProjectId, TaskId } from '../parse';
import type { PreferenceEntry } from './preference';
import type { CommandId, EventInstant, Revision } from '@shared/parse';
import type { ChangesResult } from '@shared/wire/commands';
import type { PlanningSettings } from '@shared/wire/planning';

export type TaskRow = Task;
export type ProjectRow = Project;
export type TaskLinkRow = TaskLink;
export type ActionLogRow = ActionLog;
export type TaskRowPatch = Partial<Omit<TaskRow, 'id' | 'created_at'>>;
export type ProjectRowPatch = Partial<Omit<ProjectRow, 'id' | 'created_at'>>;

export type PreCheck =
  | { kind: 'task.exists'; id: TaskId }
  | { kind: 'project.exists'; id: ProjectId }
  | { kind: 'link.blocks_acyclic'; from: TaskId; to: TaskId }
  | { kind: 'planning.revision'; expected: Revision | null }
  | { kind: 'custom'; description: string };

export type Op =
  | { kind: 'task.insert'; row: TaskRow }
  | { kind: 'task.update'; id: TaskId; patch: TaskRowPatch }
  | { kind: 'task.delete'; id: TaskId }
  | { kind: 'project.insert'; row: ProjectRow }
  | { kind: 'project.update'; id: ProjectId; patch: ProjectRowPatch }
  | { kind: 'project.delete'; id: ProjectId }
  | { kind: 'link.upsert'; row: TaskLinkRow }
  | { kind: 'link.delete'; from: TaskId; to: TaskId; linkType: LinkType }
  | { kind: 'pref.upsert'; entry: PreferenceEntry }
  | { kind: 'log.insert'; entry: ActionLogRow }
  | { kind: 'planning.replace'; settings: PlanningSettings; now: EventInstant }
  | { kind: 'receipt.insert'; result: ChangesResult }
  | { kind: 'command.audit'; commandId: CommandId; actor: 'user' | 'llm' | 'import'; reason: string | null; result: ChangesResult }
  | { kind: 'command.feed'; result: ChangesResult }
  | { kind: 'wipe' };

export interface Plan {
  ops: Op[];
  assertions: PreCheck[];
}

export function emptyPlan(): Plan {
  return { ops: [], assertions: [] };
}
