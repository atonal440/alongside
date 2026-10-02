import type { CanonicalWorkspace } from './canonical';
import type { PendingOp } from '../api/pendingOps';
import { intentWrites } from './intent';

/**
 * The revision a new command should be guarded against: the canonical revision of the identity (live
 * or tombstone, null if never seen) advanced by each queued command that will write it before this
 * one. Every write advances an identity by exactly one and a create starts it at 1, so the guard of
 * the k-th queued command on an entity is known when it is queued, and a later command stays valid
 * after the earlier ones flush. If another device wrote in between, the server sees a different
 * revision and reports a conflict, which is the point.
 */
export function predictBase(canonical: Pick<CanonicalWorkspace, 'entities'>, ops: readonly PendingOp[], identity: string): number | null {
  const [entity, ...rest] = identity.split(':');
  const known = canonical.entities.get(`${entity}:${rest.join(':')}`);
  let revision: number | null = known ? known.revision : null;
  for (const op of ops) {
    if (op.op === 'command' && intentWrites(op.intent).includes(identity)) revision = (revision ?? 0) + 1;
  }
  return revision;
}
