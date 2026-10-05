import { parseRevision, type Revision, type EventInstant } from '@shared/parse';
import type { CommandEnvelope, ChangesResult } from '@shared/wire/commands';
import { entityStorageKey, parseEntitySnapshot, parseLinkKey, type EntityReadKey, type EntitySnapshot, type LinkSnapshot, type LinkKey } from '@shared/wire/versions';
import type { Op, Plan } from './Op';
import type { DeleteContext } from '../storage/deletion';
import type { LinkPlanningContext } from '../storage/link';
import { CommandError } from './commands';
export interface CommandReader {
  entity(key: EntityReadKey): Promise<EntitySnapshot>;
  link(key: LinkKey): Promise<LinkPlanningContext>;
  deletion(key:EntityReadKey):Promise<DeleteContext>;
  /** Direct subtasks of a task, identity and status only. */
  children(ids: string[]): Promise<{ id: string; status: string; parent_id: string }[]>;
}
type Planned = {
  plan: Plan;
  result: ChangesResult;
};
/** Simulate distinct writes in order; commit one aggregate guard and receipt. */
export async function planBatchCommand(input: CommandEnvelope, reader: CommandReader, planSingle: (input: CommandEnvelope, reader: CommandReader) => Promise<Planned>, validateGraph: (changes: ChangesResult['changes'], expected: Revision) => Promise<void>, hash: string, now: EventInstant): Promise<Planned> {
  const expected = input.expectedStructuralRevision;
  if (input.commands.length < 2 || expected === undefined)
    throw new Error('Expected mixed batch.');
  let structural = expected;
  const base = new Map<string, Revision | null>();
  const entities = new Map<string, EntitySnapshot>();
  const links = new Map<string, LinkPlanningContext>();
  const changes: ChangesResult['changes'] = [];
  const refs: ChangesResult['refs'] = {};
  const mutations: Plan['ops'] = [];
  const assertions: Plan['assertions'] = [];
  const storedEntities = new Map<string, EntitySnapshot>();
  const storedLinks = new Map<string, LinkSnapshot>();
  const touched = new Set<string>();
  // Same-identity composition: commands on one task/project apply in declared order to the virtual
  // state and leave one net change (original before image, final after image, one revision step).
  const writtenAt = new Map<string, number>();
  // Identities written as derived effects of a delete (detached members, cascaded links) cannot be composed:
  // the effect is one blanket statement, so a second write would move the revision twice.
  const sealed = new Set<string>();
  const commandChanges: number[][] = [];
  let composed = false;
  const groups:number[]=[];
  const identity = (entity: string, id: string) => `${entity}:${id}`;
  const removing = new Set(input.commands.flatMap(command => command.kind === 'link.remove' ? [entityStorageKey({ entity: 'link', from: command.from, to: command.to, linkType: command.linkType })] : []));
  const conflict = (message: string): never => { throw new CommandError({ code: 'structural_conflict', path: ['expectedStructuralRevision'], message, retryable: false, expectedStructuralRevision: expected, recoveryHint: 'Retain the entire batch intent, inspect the graph and explicitly rebase with a new command ID.' }); };
  const virtual: CommandReader = {
    async entity(key) {
      const id = identity(key.entity, key.id);
      let current = entities.get(id);
      if (!current) {
        current = await reader.entity(key);
        if (current.structuralRevision !== expected)
          conflict('Workspace changed during batch planning.');
        base.set(id, current.version?.revision ?? null);
        entities.set(id, current);
        storedEntities.set(id, current);
      }
      return { ...current, structuralRevision: structural };
    },
    async children(ids) {
      // Stored subtasks of any of these tasks, overlaid by every task this batch has read or rewritten.
      const wanted = new Set(ids);
      const found = new Map((await reader.children(ids)).map(child => [child.id, child]));
      for (const task of entities.values()) {
        if (task.entity !== 'task') continue;
        if (task.row !== null && task.row.parent_id != null && wanted.has(task.row.parent_id)) found.set(task.id, { id: task.id, status: task.row.status, parent_id: task.row.parent_id });
        else found.delete(task.id);
      }
      return [...found.values()];
    },
    async deletion(key) {
      const initial=await reader.deletion(key);
      if(initial.current.structuralRevision!==expected)conflict('Workspace changed during lifecycle planning.');
      const current=await virtual.entity(key);
      if(initial.affectedCount>initial.links.length+initial.members.length)return {...initial,current};
      for(const member of initial.members){
        const id=identity(member.entity,member.id);
        if(!entities.has(id)){entities.set(id,member);storedEntities.set(id,member);base.set(id,member.version?.revision??null);}
      }
      for(const link of initial.links){
        const id=identity('link',entityStorageKey(link.key));
        if(!links.has(id)){links.set(id,{current:link,reverse:null,fromExists:true,toExists:true,wouldCycle:false});storedLinks.set(id,link);base.set(id,link.version?.revision??null);}
      }
      const members=key.entity==='project'?[...entities.values()].filter(member=>member.entity==='task'&&member.row?.project_id===key.id).map(member=>({...member,structuralRevision:structural})):[];
      const incident=key.entity==='task'?[...links.values()].map(context=>context.current).filter(link=>link.row!==null&&(link.key.from===key.id||link.key.to===key.id)).map(link=>({...link,structuralRevision:structural})):[];
      return {...initial,current,members,links:incident,affectedCount:members.length+incident.length};
    },
    async link(key) {
      const id = identity('link', entityStorageKey(key));
      let context = links.get(id);
      if (!context) {
        context = await reader.link(key);
        if (context.current.structuralRevision !== expected)
          conflict('Workspace changed during graph planning.');
        base.set(id, context.current.version?.revision ?? null);
        links.set(id, context);
        storedLinks.set(id, context.current);
        if (context.reverse !== null)
          storedLinks.set(identity('link', entityStorageKey(context.reverse.key)), context.reverse);
      }
      const from = entities.get(identity('task', key.from)), to = entities.get(identity('task', key.to));
      const reverseKey = { ...key, from: key.to, to: key.from };
      const reverse = links.get(identity('link', entityStorageKey(reverseKey)));
      return { ...context, current: { ...context.current, structuralRevision: structural }, fromExists: from ? from.row !== null : context.fromExists, toExists: to ? to.row !== null : context.toExists,
        reverse: removing.has(entityStorageKey(reverseKey)) ? null : reverse ? reverse.current.row === null ? null : { ...reverse.current, structuralRevision: structural } : context.reverse === null ? null : { ...context.reverse, structuralRevision: structural }, wouldCycle: false };
    },
  };
  for (let index = 0; index < input.commands.length; index++) {
    const command = input.commands[index]!;
    if ('expectedStructuralRevision' in command && command.expectedStructuralRevision !== expected)
      conflict('Every graph command must use the batch base structural revision.');
    const atom: CommandEnvelope = { contractVersion: 2, commandId: input.commandId, actor: input.actor, ...(input.reason === undefined ? {} : { reason: input.reason }), commands: ['expectedStructuralRevision' in command ? { ...command, expectedStructuralRevision: structural } : command] };
    let planned: Planned;
    try {
      planned = await planSingle(atom, virtual);
    }
    catch (error) {
      if (error instanceof CommandError) {
        if (error.detail.currentEntity) {
          const key = identity(error.detail.currentEntity.entity, error.detail.currentEntity.id);
          const stored = storedEntities.get(key);
          if (stored)
            error.detail.currentEntity = stored;
        }
        if (error.detail.currentLink) {
          const key = identity('link', entityStorageKey(error.detail.currentLink.key));
          const stored = storedLinks.get(key);
          if (stored)
            error.detail.currentLink = stored;
        }
        error.detail.path = error.detail.path[0] === 'commands' ? ['commands', String(index), ...error.detail.path.slice(2)] : error.detail.path;
      }
      throw error;
    }
    groups.push(planned.result.changes.length);
    const mine: number[] = [];
    for (const change of planned.result.changes) {
      if (change.entity === 'planning_settings' || change.entity === 'preference')
        throw new Error('Settings cannot mix with graph commands.');
      const id = identity(change.entity, change.id);
      const earlier = writtenAt.get(id);
      const derived = (command.kind === 'task.delete' || command.kind === 'project.delete') && change !== planned.result.changes[0];
      if (sealed.has(id) || (derived && earlier !== undefined))
        throw new CommandError({ code: 'invalid_input', path: ['commands', String(index)], message: 'A lifecycle effect (detached member or removed link) cannot overlap another written identity in the same batch.', retryable: false, recoveryHint: 'Run the delete in its own envelope, or leave the affected identity out of this one.' }, 400);
      if (derived) sealed.add(id);
      let net = change;
      if (earlier === undefined) {
        writtenAt.set(id, changes.length);
        mine.push(changes.length);
        changes.push(change);
      } else {
        net = composeChange(changes[earlier]!, change, index) as typeof change;
        changes[earlier] = net;
        mine.push(earlier);
        composed = true;
      }
      touched.add(id);
      if (change.entity === 'link') {
        const row = 'row' in change.after ? change.after.row : change.before?.row;
        if (!row)
          throw new Error('Missing link identity.');
        const parsedKey = parseLinkKey({ entity: 'link', from: row.from_task_id, to: row.to_task_id, linkType: row.link_type });
        if (!parsedKey.ok)
          throw new Error('Invalid planned link key.');
        const prior = links.get(id);
        if (!prior)
          throw new Error('Missing initial link context.');
        links.set(id, { ...prior, current: { ...prior.current, row: 'row' in change.after ? change.after.row : null, version: { revision: change.after.revision, deletedAt: 'deleted' in change.after ? now : null } } });
      }
      else {
        const prior = entities.get(id);
        if (!prior)
          throw new Error('Missing initial entity context.');
        const current = parseEntitySnapshot({ ...prior, entity: net.entity, id: net.id, row: 'row' in net.after ? net.after.row : null, version: { revision: net.after.revision, deletedAt: 'deleted' in net.after ? now : null } });
        if (!current.ok)
          throw new Error('Invalid virtual entity snapshot.');
        entities.set(id, current.value);
      }
    }
    commandChanges.push([...new Set(mine)].sort((a, b) => a - b));
    for (const [ref, id] of Object.entries(planned.result.refs))
      refs[ref] = id;
    assertions.push(...planned.plan.assertions);
    mutations.push(...planned.plan.ops.filter(op => !['receipt.insert', 'command.audit', 'command.feed'].includes(op.kind)));
    const next = parseRevision(structural + planned.result.changes.length);
    if (!next.ok)
      throw new Error('Batch counter overflow after validated planning.');
    structural = next.value;
  }
  await validateGraph(changes, expected);
  const guarded = new Map<string, Plan['assertions'][number]>();
  for (const assertion of assertions) {
    if (assertion.kind === 'workspace.structural_revision' || assertion.kind === 'link.blocks_acyclic')
      continue;
    if (assertion.kind === 'entity.revision') {
      const id = identity(assertion.key.entity, entityStorageKey(assertion.key));
      const initial = base.get(id);
      if (initial === undefined)
        throw new Error('Missing batch base revision.');
      guarded.set(`revision:${id}`, { ...assertion, expected: initial });
    }
    else if (assertion.kind === 'task.exists' || assertion.kind === 'project.exists') {
      const entity = assertion.kind === 'task.exists' ? 'task' : 'project';
      const id = identity(entity, assertion.id);
      if (base.get(id) === null && touched.has(id))
        continue;
      guarded.set(`exists:${id}`, assertion);
    }
    else
      throw new Error('Unsupported mixed-batch assertion.');
  }
  const result: ChangesResult = { contractVersion: 2, commandId: input.commandId, payloadHash: hash, serverNow: now, batch: true, ...(composed ? { commandChanges } : { changeGroups: groups }), applied: true, changes, refs, warnings: [] };
  // Edge removals run before additions; endpoint/project creation keeps declared order.
  const merged = composed ? composeOps(mutations) : mutations;
  const ordered = [...merged.filter(op => op.kind === 'link.delete'), ...(composed ? dependencyOrder(merged.filter(op => op.kind !== 'link.delete')) : merged.filter(op => op.kind !== 'link.delete'))];
  for (const change of changes)
    if (change.entity === 'link' && 'row' in change.after && change.after.row.link_type === 'blocks') {
      const parsed = parseLinkKey({ entity: 'link', from: change.after.row.from_task_id, to: change.after.row.to_task_id, linkType: 'blocks' });
      if (!parsed.ok)
        throw new Error('Invalid graph guard key.');
      ordered.push({ kind: 'graph.assert_acyclic', from: parsed.value.from, to: parsed.value.to });
    }
  return { result, plan: { assertions: [{ kind: 'workspace.structural_revision', expected: expected }, ...guarded.values()], ops: [{ kind: 'receipt.insert', result }, ...ordered, { kind: 'command.audit', commandId: input.commandId, actor: input.actor, reason: input.reason ?? null, result }, { kind: 'command.feed', result }] } };
}

type Change = ChangesResult['changes'][number];

/** Fold a later change to the same task or project into the first, keeping one revision step. */
function composeChange(first: Change, next: Change, index: number): Change {
  const refuse = (message: string) => new CommandError({ code: 'invalid_input', path: ['commands', String(index)], message, retryable: false,
    recoveryHint: 'Split the intent into separately reviewed sequential commands.' }, 400);
  if (first.entity === 'link' || first.entity === 'planning_settings' || first.entity === 'preference' || next.entity === 'link' || next.entity === 'planning_settings' || next.entity === 'preference')
    throw refuse('A mixed batch may write each link only once.');
  if ('deleted' in first.after) throw refuse('A mixed batch cannot write an identity after deleting it.');
  if ('deleted' in next.after && first.before === null) throw refuse('A mixed batch cannot create and delete the same identity.');
  const revision = first.after.revision;
  return { ...first, after: 'deleted' in next.after ? { revision, deleted: true } : { revision, row: next.after.row } } as Change;
}

function opIdentity(op: Op): string | null {
  switch (op.kind) {
    case 'task.insert': return `task:${op.row.id}`;
    case 'project.insert': return `project:${op.row.id}`;
    case 'task.update': case 'task.delete': return `task:${op.id}`;
    case 'project.update': case 'project.delete': case 'project.delete_empty': return `project:${op.id}`;
    default: return null;
  }
}

/** One statement per identity, so the revision trigger fires once: merge patches into the first op. */
function composeOps(ops: Op[]): Op[] {
  const out: (Op | null)[] = [];
  const at = new Map<string, number>();
  for (const op of ops) {
    const key = opIdentity(op);
    const i = key === null ? undefined : at.get(key);
    if (key === null || i === undefined) {
      if (key !== null) at.set(key, out.length);
      out.push(op);
      continue;
    }
    const prev = out[i]!;
    if (op.kind === 'task.update' || op.kind === 'project.update') {
      if (prev.kind === 'task.insert' && op.kind === 'task.update') out[i] = { ...prev, row: { ...prev.row, ...op.patch } as typeof prev.row };
      else if (prev.kind === 'project.insert' && op.kind === 'project.update') out[i] = { ...prev, row: { ...prev.row, ...op.patch } as typeof prev.row };
      else if (prev.kind === 'task.update' && op.kind === 'task.update') out[i] = { ...prev, patch: { ...prev.patch, ...op.patch } };
      else if (prev.kind === 'project.update' && op.kind === 'project.update') out[i] = { ...prev, patch: { ...prev.patch, ...op.patch } };
      else throw new Error('Unsupported same-identity operation pair.');
    } else if (op.kind === 'task.delete' || op.kind === 'project.delete' || op.kind === 'project.delete_empty') {
      out[i] = null;
      at.set(key, out.length);
      out.push(op);
    } else throw new Error('Unsupported same-identity operation pair.');
  }
  return out.filter((op): op is Op => op !== null);
}

/** Projects exist before the tasks that name them, and both before every update or link. */
function dependencyOrder(ops: Op[]): Op[] {
  return [...ops.filter(op => op.kind === 'project.insert'), ...ops.filter(op => op.kind === 'task.insert'),
    ...ops.filter(op => op.kind !== 'project.insert' && op.kind !== 'task.insert')];
}
