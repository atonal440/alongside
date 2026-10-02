import { parseTaskRow } from '@shared/wire/rows';
import type { ApiConfig } from './client';
import type { ApiResult } from './result';
import { toRequest, rebindTaskId } from './pendingOps';
import { api } from './endpoints';
import { buildEnvelope, type CommandOp } from '../sync/envelope';
import { parseCommandEnvelope, type CommandEnvelope } from '@shared/wire/commands';
import { parseProjectId, parseTaskId } from '@shared/parse';
import type { RetainedReason } from './retainedOps';
import type { PendingOp } from './pendingOps';
import { isDurableFailure } from './result';
import { messageFromResult, referencesTaskId, ATTEMPTS_CAP } from './syncPolicy';
import { idbRetainOp } from '../idb/retainedOps';
import {
  idbGetPendingOps, idbDeletePendingOp, idbPutPendingOp,
} from '../idb/pendingOps';

export interface FlushSummary {
  flushed: number;
  rejected: string[];
  halted: boolean;
}

// Surfaced once per app session when an op sits wedged at the attempts cap.
let _stuckNoticeFired = false;

export function _resetStuckNotice(): void {
  _stuckNoticeFired = false;
}

// Rebind all queued ops that reference oldId to newId.
async function rebindTempId(oldId: string, newId: string): Promise<void> {
  const pending = await idbGetPendingOps();
  for (const op of pending) {
    const rebound = rebindTaskId(op, oldId, newId);
    if (rebound !== op) await idbPutPendingOp(rebound);
  }
}

// Retain (then remove from the queue) all queued ops that reference taskId. Returns the IDB ids that were
// deleted so the flush loop can skip them without re-fetching.
async function dropDependentOps(taskId: string, dependsOn: string): Promise<Set<number>> {
  const skipped = new Set<number>();
  const pending = await idbGetPendingOps();
  for (const op of pending) {
    if (referencesTaskId(op, taskId) && op.id !== undefined) {
      await idbRetainOp(op, { kind: 'dependency', dependsOn, message: 'Not sent because the task it depends on was rejected.' });
      await idbDeletePendingOp(op.id);
      skipped.add(op.id);
    }
  }
  return skipped;
}

// The task whose row and the aggregate revision to ask the server about before building a command.
function lookupTaskId(op: CommandOp): string {
  const i = op.intent;
  return i.kind === 'link.add' || i.kind === 'link.remove' ? i.from : i.id;
}

const synthetic = (status: number, error: string): ApiResult<unknown> => ({ kind: 'http', status, body: { error } });

/**
 * Send one command. The envelope is built once, from the server's current row and aggregate
 * revision, and persisted before the first send; every retry (a lost response, a transient failure)
 * resends exactly that payload under the same command ID, so the server replays the original result
 * instead of applying it twice. Only a structural-guard conflict, which proves nothing was applied,
 * discards it and builds again, once.
 */
async function sendCommand(initial: CommandOp, config: ApiConfig): Promise<{ result: ApiResult<unknown>; op: CommandOp }> {
  let op = initial;
  for (let attempt = 0; attempt < 2; attempt++) {
    // A previously sent envelope is only trusted if it still parses; anything else is rebuilt.
    const stored = attempt === 0 && op.sent !== undefined ? parseCommandEnvelope(op.sent) : null;
    let envelope: CommandEnvelope;
    if (stored?.ok) {
      envelope = stored.value;
    } else {
      const taskId = parseTaskId(lookupTaskId(op));
      if (!taskId.ok) return { result: synthetic(422, 'The change refers to an invalid task ID.'), op };
      const target = await api.entity({ entity: 'task', id: taskId.value }, config);
      if (target.kind !== 'ok') return { result: target, op };
      let projectRevision: number | null = null;
      if (op.intent.kind === 'task.project' && op.intent.projectId) {
        const projectId = parseProjectId(op.intent.projectId);
        if (!projectId.ok) return { result: synthetic(422, 'The change refers to an invalid project ID.'), op };
        const project = await api.entity({ entity: 'project', id: projectId.value }, config);
        if (project.kind !== 'ok') return { result: project, op };
        projectRevision = project.value.version?.revision ?? null;
      }
      const row = target.value.entity === 'task' ? target.value.row : null;
      const built = buildEnvelope(op, { row, structuralRevision: target.value.structuralRevision, projectRevision });
      if (!built.ok) return { result: synthetic(422, built.error[0]?.message ?? 'The change could not be expressed as a command.'), op };
      envelope = built.value;
      op = { ...op, sent: envelope };
      if (op.id !== undefined) await idbPutPendingOp(op);
    }
    const result = await api.applyChanges(envelope, config);
    const code = result.kind === 'http' ? result.body.contractError?.code : undefined;
    if (code === 'structural_conflict' && attempt === 0) {
      { const { sent: _discarded, ...rest } = op; op = rest as CommandOp; }
      if (op.id !== undefined) await idbPutPendingOp(op);
      continue;
    }
    // Two structural conflicts in a row mean the graph is busy, not that the command is wrong.
    return { result: code === 'structural_conflict' ? { kind: 'network' } : result, op };
  }
  return { result: { kind: 'network' }, op };
}

function retainedReason(result: ApiResult<unknown>): RetainedReason {
  const message = messageFromResult(result);
  const status = result.kind === 'http' ? result.status : 0;
  if (result.kind === 'http' && result.body.contractError?.code === 'revision_conflict') {
    const current = result.body.contractError.currentEntity?.version?.revision ?? result.body.contractError.currentLink?.version?.revision ?? null;
    return { kind: 'conflict', status, message, currentRevision: current };
  }
  return { kind: 'rejected', status, message };
}

// Overlapping flushes (StrictMode's doubled effects, a service-worker nudge landing mid-cycle)
// would each send the same queued op and duplicate creates, so concurrent callers share one run.
let inFlight: Promise<FlushSummary> | null = null;

export function flushPendingOps(config: ApiConfig): Promise<FlushSummary> {
  if (!inFlight) inFlight = flushQueue(config).finally(() => { inFlight = null; });
  return inFlight;
}

async function flushQueue(config: ApiConfig): Promise<FlushSummary> {
  const ops = await idbGetPendingOps();
  let flushed = 0;
  const rejected: string[] = [];
  let halted = false;
  const skippedIds = new Set<number>();

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.id !== undefined && skippedIds.has(op.id)) continue;

    let live: PendingOp = op;
    let result: ApiResult<unknown>;
    if (op.op === 'command') {
      const sent = await sendCommand(op, config);
      result = sent.result;
      live = sent.op;
    } else {
      result = await toRequest(op, config);
    }

    if (result.kind === 'contract') {
      // 2xx response whose body failed the schema check. The server has already
      // applied the write — drop the op to prevent retry duplication.
      console.error('[sync] contract violation on queued op; dropping', op.op);
      await idbDeletePendingOp(op.id!);
      if (op.op === 'task.create') {
        const raw = result.raw as Record<string, unknown> | undefined;
        const serverId = typeof raw?.['id'] === 'string' ? raw['id'] : null;
        if (serverId) {
          await rebindTempId(op.localId, serverId);
          for (let j = i + 1; j < ops.length; j++) {
            ops[j] = rebindTaskId(ops[j]!, op.localId, serverId);
          }
        }
      }
      flushed++;
      continue;
    }

    if (result.kind === 'ok') {
      if (op.op === 'task.create') {
        // Parse the server row BEFORE deleting the op so that a validation
        // failure doesn't leave the op gone with no rebinding done.
        const parsed = parseTaskRow(result.value);
        const oldId = op.localId;

        if (!parsed.ok) {
          console.error('[sync] offline-create response failed schema check', parsed.error);
          await idbDeletePendingOp(op.id!);
          const raw = result.value as Record<string, unknown>;
          const serverId = typeof raw?.['id'] === 'string' ? raw['id'] : null;
          if (serverId) {
            await rebindTempId(oldId, serverId);
            for (let j = i + 1; j < ops.length; j++) {
              ops[j] = rebindTaskId(ops[j]!, oldId, serverId);
            }
          }
          flushed++;
          continue;
        }

        const newId = parsed.value.id;
        await idbDeletePendingOp(op.id!);
        // Rebind in IDB and in the local array so subsequent ops in this cycle
        // use the real server ID, not the temp ID.
        await rebindTempId(oldId, newId);
        for (let j = i + 1; j < ops.length; j++) {
          ops[j] = rebindTaskId(ops[j]!, oldId, newId);
        }
      } else {
        await idbDeletePendingOp(op.id!);
      }
      flushed++;
      continue;
    }

    if (isDurableFailure(result)) {
      // 4xx rejection: the write can never succeed. Retain it with diagnostics, remove it from the queue and report to caller.
      const message = messageFromResult(result);
      rejected.push(message);
      // Keep the user's intent with the diagnostics before it leaves the queue.
      await idbRetainOp(op, retainedReason(result));
      await idbDeletePendingOp(op.id!);

      if (op.op === 'task.create' || (op.op === 'command' && op.intent.kind === 'task.create')) {
        const createdId = op.op === 'task.create' ? op.localId : (op.intent as { id: string }).id;
        // All ops targeting this temp ID will also fail (the task will never
        // exist on the server), so drop them and mark them as skipped in the
        // current loop to avoid sending doomed requests.
        const newSkipped = await dropDependentOps(createdId, createdId);
        for (const id of newSkipped) skippedIds.add(id);
      }
      continue;
    }

    // Transient failure (network, 5xx, unconfigured): increment attempts and
    // stop the flush to preserve op ordering. Later ops are not attempted.
    const newAttempts = op.attempts + 1;
    await idbPutPendingOp({ ...live, attempts: newAttempts } as PendingOp);
    halted = true;

    if (newAttempts >= ATTEMPTS_CAP && !_stuckNoticeFired) {
      _stuckNoticeFired = true;
      rejected.push('Some changes aren\'t syncing — they may need to be redone.');
    }

    break;
  }

  return { flushed, rejected, halted };
}
