import * as v from 'valibot';
import { DutyIdSchema, EventInstantSchema, LinkTypeSchema, ProjectIdSchema, RevisionSchema, TaskIdSchema, parseSchema } from '../parse';
import { ProjectRowSchema, TaskRowSchema } from './rows';

export const EntityKeySchema = v.variant('entity', [
  v.strictObject({ entity: v.literal('task'), id: TaskIdSchema }),
  v.strictObject({ entity: v.literal('project'), id: ProjectIdSchema }),
  v.strictObject({ entity: v.literal('duty'), id: DutyIdSchema }),
  v.strictObject({ entity: v.literal('link'), from: TaskIdSchema, to: TaskIdSchema, linkType: LinkTypeSchema }),
]);
export type EntityKey = v.InferOutput<typeof EntityKeySchema>;
// JSON tuple encoding is shared with SQLite json_array, not delimiter joining.
export function entityStorageKey(key: EntityKey): string {
  return key.entity === 'link' ? JSON.stringify([key.from, key.to, key.linkType]) : key.id;
}
export const EntityVersionSchema = v.strictObject({ revision: RevisionSchema, deletedAt: v.nullable(EventInstantSchema) });
export type EntityVersion = v.InferOutput<typeof EntityVersionSchema>;
export const EntityVersionResponseSchema = v.strictObject({
  contractVersion: v.literal(2), key: EntityKeySchema,
  structuralRevision: RevisionSchema, version: v.nullable(EntityVersionSchema),
});
export type EntityVersionResponse = v.InferOutput<typeof EntityVersionResponseSchema>;
export const parseEntityKey = (input: unknown) => parseSchema(EntityKeySchema, input);
export const parseEntityVersionResponse = (input: unknown) => parseSchema(EntityVersionResponseSchema, input);

export const EntityReadKeySchema = v.variant('entity', [
  v.strictObject({ entity: v.literal('task'), id: TaskIdSchema }),
  v.strictObject({ entity: v.literal('project'), id: ProjectIdSchema }),
]);
export type EntityReadKey = v.InferOutput<typeof EntityReadKeySchema>;
const snapshotEntries = { contractVersion: v.literal(2), structuralRevision: RevisionSchema, version: v.nullable(EntityVersionSchema) };
export const EntitySnapshotSchema = v.pipe(v.variant('entity', [
  v.strictObject({ ...snapshotEntries, entity: v.literal('task'), id: TaskIdSchema, row: v.nullable(TaskRowSchema) }),
  v.strictObject({ ...snapshotEntries, entity: v.literal('project'), id: ProjectIdSchema, row: v.nullable(ProjectRowSchema) }),
]), v.check(value => value.row === null
  ? value.version === null || value.version.deletedAt !== null
  : value.row.id === value.id && value.version !== null && value.version.deletedAt === null,
'Entity content must match its identity and live/deleted version.'));
export type EntitySnapshot = v.InferOutput<typeof EntitySnapshotSchema>;
export const parseEntityReadKey = (input: unknown) => parseSchema(EntityReadKeySchema, input);
export const parseEntitySnapshot = (input: unknown) => parseSchema(EntitySnapshotSchema, input);
