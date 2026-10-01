import * as v from 'valibot';
import { DutyIdSchema, EventInstantSchema, LinkTypeSchema, ProjectIdSchema, RevisionSchema, TaskIdSchema, parseSchema } from '../parse';

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
