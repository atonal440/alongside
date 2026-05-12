import type { BoundedString, IsoDateTime, TaskId, ToolName } from '../parse';

export type LogPolicy =
  | { kind: 'requires_task'; taskId: TaskId }
  | { kind: 'project_or_global' }
  | { kind: 'none' };

export interface ActionLogEntryDomain {
  id: number;
  toolName: ToolName;
  taskId: TaskId | null;
  title: BoundedString<500>;
  detail: BoundedString<2_000> | null;
  createdAt: IsoDateTime;
}
