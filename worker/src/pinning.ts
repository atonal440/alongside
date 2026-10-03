/**
 * Loose-intent pinning for `preview_changes` (phase B of docs/plans/mcp-surface.md).
 *
 * A loose envelope (`intent: true`) carries entity IDs, client refs and values but no revisions,
 * no minted IDs and no structural revision. `pinIntent` reads current state, fills every guard
 * and mints every ID, and returns the strict envelope `apply_changes` accepts. Pinning only
 * *fills in* what the caller left out; the real planner still validates the result, so a stale
 * pin fails with the usual revision_conflict instead of applying.
 */
import { nanoid } from 'nanoid';
import { parseEntityKey } from '@shared/wire/versions';
import { CommandError } from './domain/commands';
import { invalidInput } from './domain/temporalFoundation';
import type { DB } from './db';

type Json = Record<string, unknown>;
type Kind = { entity: 'task' | 'project' };

const MAX_ATTEMPTS = 3;
const REF = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const fail = (path: string[], message: string): CommandError =>
  new CommandError(invalidInput([{ code: 'invalid_input', path, message }]), 400);

export const isLooseIntent = (args: unknown): args is Json =>
  args !== null && typeof args === 'object' && !Array.isArray(args) && (args as Json).intent === true;

class StaleRead extends Error {}

/** What an earlier command in the same batch created or wrote, keyed by `entity:id`. */
interface Predicted { revision: number }

export async function pinIntent(args: Json, db: DB): Promise<Json> {
  for (let attempt = 1; ; attempt++) {
    try { return await pinOnce(args, db); }
    catch (error) {
      // A write landed between our reads: the snapshots disagree on the structural revision.
      if (!(error instanceof StaleRead)) throw error;
      if (attempt >= MAX_ATTEMPTS) throw new CommandError({ code: 'structural_conflict', path: [], message: 'The workspace kept changing while the intent was being pinned.', retryable: true, recoveryHint: 'Repeat the preview.' }, 409);
    }
  }
}

async function pinOnce(args: Json, db: DB): Promise<Json> {
  const allowed = ['intent', 'contractVersion', 'commandId', 'actor', 'reason', 'commands'];
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw fail([key], `Unknown key "${key}".`);
  if (args.contractVersion !== 2) throw fail(['contractVersion'], 'contractVersion must be 2.');
  if (!Array.isArray(args.commands) || args.commands.length < 1 || args.commands.length > 20) throw fail(['commands'], 'commands must hold 1–20 loose commands.');
  const commandId = args.commandId === undefined ? `c_${nanoid(12)}` : args.commandId;
  const actor = args.actor === undefined ? 'llm' : args.actor;

  const probe = parseEntityKey({ entity: 'task', id: 't_pinprobe' });
  if (!probe.ok) throw new Error('Invalid probe key.');
  const structural = (await db.getEntityVersion(probe.value)).structuralRevision;

  const snapshots = new Map<string, Awaited<ReturnType<DB['getEntitySnapshot']>>>();
  const refs = new Map<string, { id: string; entity: Kind['entity'] }>();
  const predicted = new Map<string, Predicted>();
  const written = (entity: string, id: string, revision: number) => predicted.set(`${entity}:${id}`, { revision });

  const read = async (entity: Kind['entity'], id: string, path: string[]) => {
    const key = `${entity}:${id}`;
    let snapshot = snapshots.get(key);
    if (!snapshot) {
      const parsed = parseEntityKey({ entity, id });
      if (!parsed.ok || parsed.value.entity === 'duty' || parsed.value.entity === 'link') throw fail(path, `"${id}" is not a valid ${entity} ID.`);
      snapshot = await db.getEntitySnapshot({ entity, id: parsed.value.id } as never);
      if (snapshot.structuralRevision !== structural) throw new StaleRead();
      snapshots.set(key, snapshot);
    }
    return snapshot;
  };
  const resolve = (value: unknown, entity: Kind['entity'], path: string[]): { id: string; created: boolean } => {
    if (typeof value !== 'string') throw fail(path, `Expected a ${entity} ID or @clientRef.`);
    if (!value.startsWith('@')) return { id: value, created: false };
    const ref = refs.get(value.slice(1));
    if (!ref) throw fail(path, `No earlier command created "${value}"; creation commands set clientRef.`);
    if (ref.entity !== entity) throw fail(path, `"${value}" refers to a ${ref.entity}, not a ${entity}.`);
    return { id: ref.id, created: true };
  };
  /** Revision a guard should name: a batch-local prediction, else the live revision. */
  const revisionOf = async (entity: Kind['entity'], id: string, path: string[]): Promise<number> => {
    const local = predicted.get(`${entity}:${id}`);
    if (local) return local.revision;
    const snapshot = await read(entity, id, path);
    if (snapshot.row === null || snapshot.version === null) throw fail(path, `${entity} ${id} does not exist.`);
    return snapshot.version.revision;
  };
  const liveRow = async (entity: Kind['entity'], id: string, path: string[]) => {
    const snapshot = await read(entity, id, path);
    if (snapshot.row === null) throw fail(path, `${entity} ${id} does not exist.`);
    return snapshot.row as Json;
  };
  const project = async (value: unknown, path: string[]) => {
    if (value === null) return null;
    const { id } = resolve(value, 'project', path);
    return { id, expectedRevision: await revisionOf('project', id, path) };
  };

  const commands: Json[] = [];
  for (const [index, raw] of (args.commands as unknown[]).entries()) {
    const at = ['commands', String(index)];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw fail(at, 'Each command must be an object.');
    const command = raw as Json;
    const keys = (...allowedKeys: string[]) => {
      for (const key of Object.keys(command)) if (key !== 'kind' && !allowedKeys.includes(key)) throw fail([...at, key], `Unknown key "${key}" for ${String(command.kind)}.`);
    };
    const idOf = (entity: Kind['entity']) => resolve(command.id, entity, [...at, 'id']).id;
    const clientRef = () => {
      if (command.clientRef === undefined) return {};
      if (typeof command.clientRef !== 'string' || !REF.test(command.clientRef)) throw fail([...at, 'clientRef'], 'clientRef must start with a letter and use letters, digits, _ or -.');
      return { clientRef: command.clientRef };
    };
    const values = (): Json => {
      if (command.values === null || typeof command.values !== 'object' || Array.isArray(command.values)) throw fail([...at, 'values'], 'values must be an object.');
      return command.values as Json;
    };
    const remember = (entity: Kind['entity'], id: string) => {
      if (typeof command.clientRef === 'string') {
        if (refs.has(command.clientRef)) throw fail([...at, 'clientRef'], `clientRef "${command.clientRef}" is used twice.`);
        refs.set(command.clientRef, { id, entity });
      }
      written(entity, id, 1);
    };
    const edit = async (entity: Kind['entity'], id: string) => {
      // The planner writes each identity once per batch, so say so here, before it rejects the pinned envelope.
      if (predicted.has(`${entity}:${id}`)) throw fail([...at, 'id'], `${entity} ${id} is already written by an earlier command in this batch; a batch writes each identity once. Fold the changes into one command or apply them in separate calls.`);
      const revision = await revisionOf(entity, id, [...at, 'id']);
      written(entity, id, revision + 1);
      return revision;
    };
    const only = (input: Json, allowedKeys: string[], path: string[]) => {
      for (const key of Object.keys(input)) if (!allowedKeys.includes(key)) throw fail([...path, key], `Unknown key "${key}".`);
    };

    switch (command.kind) {
      case 'task.create': {
        keys('clientRef', 'values');
        const input = values(); only(input, ['title', 'notes', 'kickoffNote', 'taskType', 'project'], [...at, 'values']);
        const id = `t_${nanoid(5)}`;
        const out = { kind: 'task.create', id, ...clientRef(), expectedRevision: null, expectedStructuralRevision: structural,
          values: { title: input.title, notes: input.notes ?? null, kickoffNote: input.kickoffNote ?? null, taskType: input.taskType ?? 'action', project: await project(input.project ?? null, [...at, 'values', 'project']) } };
        remember('task', id); commands.push(out); break;
      }
      case 'project.create': {
        keys('clientRef', 'values');
        const input = values(); only(input, ['title', 'notes', 'kickoffNote'], [...at, 'values']);
        const id = `p_${nanoid(5)}`;
        commands.push({ kind: 'project.create', id, ...clientRef(), expectedRevision: null, expectedStructuralRevision: structural,
          values: { title: input.title, notes: input.notes ?? null, kickoffNote: input.kickoffNote ?? null } });
        remember('project', id); break;
      }
      case 'task.content.set':
      case 'project.content.set': {
        keys('id', 'values');
        const entity = command.kind === 'task.content.set' ? 'task' : 'project';
        const id = idOf(entity);
        const input = values();
        const names = entity === 'task' ? ['title', 'notes', 'kickoffNote', 'sessionLog'] : ['title', 'notes', 'kickoffNote'];
        only(input, names, [...at, 'values']);
        // The command replaces the whole field group, so patches merge into current values.
        const row = await liveRow(entity, id, [...at, 'id']);
        const current: Json = { title: row.title, notes: row.notes, kickoffNote: row.kickoff_note, ...(entity === 'task' ? { sessionLog: row.session_log } : {}) };
        commands.push({ kind: command.kind, id, expectedRevision: await edit(entity, id), values: { ...current, ...input } });
        break;
      }
      case 'task.focus.set': { keys('id', 'focusedUntil'); const id = idOf('task'); commands.push({ kind: command.kind, id, expectedRevision: await edit('task', id), focusedUntil: command.focusedUntil }); break; }
      case 'task.defer.set': { keys('id', 'defer'); const id = idOf('task'); commands.push({ kind: command.kind, id, expectedRevision: await edit('task', id), defer: command.defer }); break; }
      case 'task.type.set': { keys('id', 'taskType'); const id = idOf('task'); commands.push({ kind: command.kind, id, expectedRevision: await edit('task', id), taskType: command.taskType }); break; }
      case 'task.reopen': { keys('id'); const id = idOf('task'); commands.push({ kind: command.kind, id, expectedRevision: await edit('task', id) }); break; }
      case 'project.archive':
      case 'project.reopen': { keys('id'); const id = idOf('project'); commands.push({ kind: command.kind, id, expectedRevision: await edit('project', id) }); break; }
      case 'task.legacy-schedule.set': {
        keys('id', 'values');
        const id = idOf('task');
        const input = values(); only(input, ['dueDate', 'dueAllDay', 'recurrence'], [...at, 'values']);
        const row = await liveRow('task', id, [...at, 'id']);
        const current = { dueDate: row.due_date, dueAllDay: row.due_all_day, recurrence: row.recurrence };
        commands.push({ kind: command.kind, id, expectedRevision: await edit('task', id), values: { ...current, ...input } });
        break;
      }
      case 'task.complete': {
        keys('id', 'clientRef');
        const id = idOf('task');
        const row = await liveRow('task', id, [...at, 'id']);
        const successorId = `t_${nanoid(5)}`;
        const recurring = row.recurrence !== null && row.recurrence !== undefined;
        commands.push({ kind: command.kind, id, expectedRevision: await edit('task', id), expectedStructuralRevision: structural,
          successor: recurring ? { id: successorId, ...clientRef() } : null });
        if (recurring) remember('task', successorId);
        break;
      }
      case 'task.project.set': {
        keys('id', 'project');
        const id = idOf('task');
        commands.push({ kind: command.kind, id, expectedRevision: await edit('task', id), expectedStructuralRevision: structural, project: await project(command.project, [...at, 'project']) });
        break;
      }
      case 'task.delete':
      case 'project.delete': {
        keys('id');
        const entity = command.kind === 'task.delete' ? 'task' : 'project';
        const id = idOf(entity);
        commands.push({ kind: command.kind, id, expectedRevision: await edit(entity, id), expectedStructuralRevision: structural });
        break;
      }
      case 'link.add':
      case 'link.remove': {
        keys('from', 'to', 'linkType');
        const from = resolve(command.from, 'task', [...at, 'from']), to = resolve(command.to, 'task', [...at, 'to']);
        const linkType = command.linkType ?? 'blocks';
        let expectedRevision: number | null = null;
        if (!from.created && !to.created) {
          const link = await db.getLinkSnapshot({ entity: 'link', from: from.id, to: to.id, linkType } as never);
          if (link.structuralRevision !== structural) throw new StaleRead();
          expectedRevision = link.version?.revision ?? null;
        }
        if (command.kind === 'link.remove' && expectedRevision === null) throw fail(at, 'That link does not exist.');
        commands.push({ kind: command.kind, from: from.id, to: to.id, linkType, expectedRevision, expectedStructuralRevision: structural });
        break;
      }
      case 'planning.set': {
        keys('values');
        commands.push({ kind: command.kind, expectedRevision: (await db.getPlanningSettings())?.revision ?? null, values: command.values });
        break;
      }
      default:
        throw fail([...at, 'kind'], `Unknown command kind "${String(command.kind)}"; see describe_commands.`);
    }
  }

  return { contractVersion: 2, commandId, actor, ...(args.reason === undefined ? {} : { reason: args.reason }),
    ...(commands.length > 1 ? { expectedStructuralRevision: structural } : {}), commands };
}
