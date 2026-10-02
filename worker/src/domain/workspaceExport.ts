import type { WorkspaceSnapshot, SyncEntity } from '@shared/wire/sync';
import { parseWorkspaceExport, type WorkspaceExport } from '@shared/wire/workspaceExport';

/** Portable user data only; replay receipts and sync/version metadata stay local. */
export function workspaceExport(snapshot: WorkspaceSnapshot, exportedAt: string): WorkspaceExport {
  const families = new Map<SyncEntity['entity'], unknown[]>();
  for (const image of snapshot.entities) {
    if (image.row === null) continue;
    const rows = families.get(image.entity) ?? [];
    rows.push(image.row);
    families.set(image.entity, rows);
  }
  const planning = snapshot.entities.find(image => image.entity === 'planning_settings');
  const settings = planning?.entity === 'planning_settings' ? planning.row : null;
  const parsed = parseWorkspaceExport({ version: 2, exported_at: exportedAt,
    tasks: families.get('task') ?? [], projects: families.get('project') ?? [], links: families.get('link') ?? [],
    duties: families.get('duty') ?? [], preferences: families.get('preference') ?? [],
    action_log: families.get('action_log') ?? [], command_audit: families.get('command_audit') ?? [],
    planning_settings: settings == null ? null : { timezone: settings.timezone, bufferMinutes: settings.buffer_minutes,
      workingHours: settings.working_hours.map(hour => ({ weekday: hour.weekday, start: hour.start_time, end: hour.end_time })) },
  });
  if (!parsed.ok) throw new Error(`Workspace export failed validation: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}
