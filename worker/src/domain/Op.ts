import type { ActionLog, Duty, Project, Task, TaskLink } from '@shared/types';
import type { LinkType, ProjectId, TaskId } from '../parse';
import type { PreferenceEntry } from './preference';
import type { CommandId, EventInstant, IsoDateTime, Revision } from '@shared/parse';
import type { ChangesResult } from '@shared/wire/commands';
import type { ReceiptTool } from '@shared/wire/receipts';
import type { PlanningSettings } from '@shared/wire/planning';
import type { EntityKey } from '@shared/wire/versions';

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
  | { kind: 'entity.revision'; key: EntityKey; expected: Revision | null }
  | { kind: 'workspace.structural_revision'; expected: Revision }
  | { kind: 'sync.cursor'; epoch: number; sequence: number }
  | { kind: 'custom'; description: string };

export type Op =
  | { kind: 'task.insert'; row: TaskRow }
  | { kind: 'task.update'; id: TaskId; patch: TaskRowPatch }
  | { kind: 'task.delete'; id: TaskId }
  // Calendar execution guards land before the duty planners/drivers.
  | { kind: 'duty.update_cursor'; id: Duty['id']; lastSpawnedAt: IsoDateTime; nextOccurrenceAt: IsoDateTime | null; updatedAt: IsoDateTime }
  | { kind: 'project.insert'; row: ProjectRow }
  | { kind: 'project.update'; id: ProjectId; patch: ProjectRowPatch }
  | { kind: 'project.delete'; id: ProjectId }
  | { kind: 'project.delete_empty'; id: ProjectId }
  | { kind: 'link.upsert'; row: TaskLinkRow }
  | { kind: 'link.insert'; row: TaskLinkRow }
  | { kind: 'link.delete'; from: TaskId; to: TaskId; linkType: LinkType }
  | { kind: 'pref.upsert'; entry: PreferenceEntry }
  | { kind: 'log.insert'; entry: ActionLogRow }
  | { kind: 'planning.replace'; settings: PlanningSettings; now: EventInstant }
  | { kind: 'receipt.insert'; result: ChangesResult; stored?: { tool: ReceiptTool; response: unknown } }
  /** A no-op tool call: records the command ID and the response, with no entity change. */
  | { kind: 'receipt.insert_noop'; commandId: CommandId; payloadHash: string; serverNow: EventInstant; tool: ReceiptTool; response: unknown }
  | { kind: 'command.audit'; commandId: CommandId; actor: 'user' | 'llm' | 'import'; reason: string | null; result: ChangesResult }
  | { kind: 'command.feed'; result: ChangesResult }
  | { kind: 'graph.assert_acyclic'; from: TaskId; to: TaskId }
  | { kind: 'wipe' }
  // Version 2 restore: whole-workspace replacement that preserves every portable column.
  | { kind: 'sync.epoch_advance' }
  | { kind: 'workspace.wipe' }
  | { kind: 'duty.restore'; row: Duty }
  | { kind: 'task.restore'; row: TaskRow }
  | { kind: 'pref.restore'; key: string; value: string }
  | { kind: 'log.restore'; entry: ActionLogRow };

export interface Plan {
  ops: Op[];
  assertions: PreCheck[];
}

export function emptyPlan(): Plan {
  return { ops: [], assertions: [] };
}
