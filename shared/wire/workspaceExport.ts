import * as v from 'valibot';
import { EventInstantSchema, parseSchema } from '../parse';
import { ProjectRowSchema, TaskLinkRowSchema, taskRowEntries } from './rows';
import { DutyRowSchema, PreferenceRowSchema, SyncActionLogRowSchema, SyncAuditRowSchema } from './sync';
import { PlanningValuesSchema } from './commands';

// Portable data rejects unknown fields rather than silently stripping future
// user data. Live sync's row codecs remain compatible with legacy projections.
export const PortableTaskRowSchema = v.strictObject(taskRowEntries);
export const PortableProjectRowSchema = v.strictObject(ProjectRowSchema.pipe[0].entries);
export const PortableLinkRowSchema = v.strictObject(TaskLinkRowSchema.pipe[0].entries);
export const WorkspaceExportSchema = v.pipe(v.strictObject({
  version: v.literal(2), exported_at: EventInstantSchema,
  tasks: v.array(PortableTaskRowSchema), projects: v.array(PortableProjectRowSchema),
  links: v.array(PortableLinkRowSchema), duties: v.array(DutyRowSchema),
  preferences: v.array(PreferenceRowSchema), planning_settings: v.nullable(PlanningValuesSchema),
  action_log: v.array(SyncActionLogRowSchema), command_audit: v.array(SyncAuditRowSchema),
}), v.check(value => {
  const tasks = new Set(value.tasks.map(row => row.id));
  const projects = new Set(value.projects.map(row => row.id));
  const duties = new Set<string>(value.duties.map(row => row.id));
  if (tasks.size !== value.tasks.length || projects.size !== value.projects.length || duties.size !== value.duties.length
    || new Set(value.links.map(row => JSON.stringify([row.from_task_id, row.to_task_id, row.link_type]))).size !== value.links.length
    || new Set(value.preferences.map(row => row.key)).size !== value.preferences.length
    || new Set(value.action_log.map(row => row.id)).size !== value.action_log.length
    || new Set(value.command_audit.map(row => row.command_id)).size !== value.command_audit.length) return false;
  return value.tasks.every(row => (row.project_id === null || projects.has(row.project_id)) && (row.duty_id === null || duties.has(row.duty_id)))
    && value.duties.every(row => row.project_id === null || projects.has(row.project_id))
    && value.links.every(row => tasks.has(row.from_task_id) && tasks.has(row.to_task_id));
}, 'Portable identities must be unique and live references must resolve.'));
export type WorkspaceExport = v.InferOutput<typeof WorkspaceExportSchema>;
export const parseWorkspaceExport = (input: unknown) => parseSchema(WorkspaceExportSchema, input);
