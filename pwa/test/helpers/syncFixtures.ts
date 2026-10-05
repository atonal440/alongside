import { parseWorkspaceDelta, parseWorkspaceSnapshot } from '@shared/wire/sync';

const now = '2026-10-01T10:00:00Z';
export const config = { apiBase: 'http://localhost:8787', authToken: 'tok' };
export const taskRow = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, notes: null, kickoff_note: null, status: 'pending', task_type: 'action', project_id: null, due_date: null,
  due_all_day: null, recurrence: null, defer_kind: 'none', defer_until: null, focused_until: null, session_log: null, duty_id: null, occurrence_at: null,available_from: null,deadline: null, parent_id: null, position: null, created_at: now, updated_at: now, ...extra });
export const taskImage = (id: string, revision: number, extra: Record<string, unknown> = {}) => ({ entity: 'task', key: id, revision, deletedAt: null, row: taskRow(id, extra) });
export const projectImage = (id: string, revision: number) => ({ entity: 'project', key: id, revision, deletedAt: null, row: { id, title: id, notes: null, kickoff_note: null, status: 'active', created_at: now, updated_at: now } });
export const tombstone = (entity: string, key: string, revision: number) => ({ entity, key, revision, deletedAt: '2026-10-01T11:00:00.123Z', row: null });

export function snapshot(cursor: { epoch: number; sequence: number }, entities: unknown[], structuralRevision = 1) {
  const parsed = parseWorkspaceSnapshot({ contractVersion: 2, cursor, structuralRevision, entities });
  if (!parsed.ok) throw new Error(`bad snapshot fixture: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}
export function page(from: number, cursor: number, watermark: number, hasMore: boolean, changes: [number, unknown][], epoch = 1) {
  const raw = { contractVersion: 2, from: { epoch, sequence: from }, cursor: { epoch, sequence: cursor }, watermark: { epoch, sequence: watermark }, hasMore,
    changes: changes.map(([sequence, entity]) => ({ sequence, entity })) };
  const parsed = parseWorkspaceDelta(raw);
  if (!parsed.ok) throw new Error(`bad delta fixture: ${JSON.stringify(parsed.error)}`);
  return { raw, parsed: parsed.value };
}
