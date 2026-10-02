import * as v from 'valibot';
import { RevisionSchema, parseSchema } from '../parse';
import { SyncCursorSchema } from './syncCursor';
import { WorkspaceExportSchema } from './workspaceExport';

export const RESTORE_FAMILIES = ['tasks', 'projects', 'links', 'duties', 'preferences', 'planning_settings', 'action_log'] as const;
const count = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
export const RestoreCountsSchema = v.strictObject({
  tasks: count, projects: count, links: count, duties: count, preferences: count, planning_settings: v.picklist([0, 1]), action_log: count,
});
export type RestoreCounts = v.InferOutput<typeof RestoreCountsSchema>;

/** `preflight` validates and reports without writing; `apply` commits one atomic replacement. */
export const WorkspaceRestoreInputSchema = v.strictObject({
  contractVersion: v.literal(2),
  mode: v.picklist(['preflight', 'apply']),
  expectedCursor: SyncCursorSchema,
  document: WorkspaceExportSchema,
});
export type WorkspaceRestoreInput = v.InferOutput<typeof WorkspaceRestoreInputSchema>;
export const parseWorkspaceRestoreInput = (input: unknown) => parseSchema(WorkspaceRestoreInputSchema, input);

export const WorkspaceRestoreResultSchema = v.pipe(v.strictObject({
  contractVersion: v.literal(2),
  mode: v.picklist(['preflight', 'apply']),
  applied: v.boolean(),
  previousCursor: SyncCursorSchema,
  /** Null for preflight; after apply, the first cursor of the new epoch. */
  resultingCursor: v.nullable(SyncCursorSchema),
  replaces: RestoreCountsSchema,
  restores: RestoreCountsSchema,
  /** Incoming command audit is validated but kept out of the restored workspace. */
  notRestored: v.strictObject({ command_audit: count }),
  requiredStatements: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
  limit: v.literal(100),
  nextEpoch: RevisionSchema,
}), v.check(value => value.applied === (value.mode === 'apply') && (value.resultingCursor === null) === !value.applied
  && value.nextEpoch === value.previousCursor.epoch + 1
  && (value.resultingCursor === null || value.resultingCursor.epoch === value.nextEpoch),
'Restore result must agree with its mode, epoch transition and cursor.'));
export type WorkspaceRestoreResult = v.InferOutput<typeof WorkspaceRestoreResultSchema>;
export const parseWorkspaceRestoreResult = (input: unknown) => parseSchema(WorkspaceRestoreResultSchema, input);
