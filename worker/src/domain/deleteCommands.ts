import { parseRevision, type EventInstant } from '@shared/parse';
import { entityStorageKey } from '@shared/wire/versions';
import type { CommandEnvelope, ChangesResult } from '@shared/wire/commands';
import type { Plan } from './Op';
import type { DeleteContext } from '../storage/deletion';
import { CommandError, entityCommandConflict } from './commands';
import { taskFromRow } from './task';

export function planDeleteCommand(input: CommandEnvelope, context: DeleteContext, hash: string, now: EventInstant): {plan:Plan;result:ChangesResult} {
  const command = input.commands[0]!;
  if (command.kind !== 'task.delete' && command.kind !== 'project.delete') throw new Error('Expected deletion command.');
  const {current} = context;
  if (current.id !== command.id || current.entity !== (command.kind === 'task.delete' ? 'task' : 'project')) throw new Error('Deletion identity mismatch.');
  const conflict = entityCommandConflict(input,current); if (conflict) throw conflict;
  if (current.structuralRevision !== command.expectedStructuralRevision) throw new CommandError({code:'structural_conflict',path:['commands','0','expectedStructuralRevision'],message:'Workspace changed since deletion planning.',retryable:false,currentEntity:current,expectedStructuralRevision:command.expectedStructuralRevision,recoveryHint:'Retain deletion intent; inspect the complete affected graph and explicitly rebase with a new command ID.'});
  if (context.hasDutyReferences) throw new CommandError({code:'invalid_transition',path:['commands','0'],message:'This project still owns duties.',retryable:false,currentEntity:current,recoveryHint:'Retain intent; inspect duty ownership. Reliable duty reassignment is required before project deletion.'});
  // Count every guard, mutation and feed image before expanding an atomic plan.
  const requiredStatements = 7 + context.affectedCount * (command.kind === 'task.delete' ? 1 : 3);
  if (requiredStatements > 100) throw new CommandError({code:'capacity_exceeded',path:['commands'],message:`Atomic deletion requires ${requiredStatements} SQL statements; the limit is 100.`,retryable:false,requiredStatements,limit:100,recoveryHint:'Retain deletion intent. Inspect the affected graph and explicitly reduce the scope before resubmitting; this command cannot be split silently.'},413);
  if (context.affectedCount !== context.links.length + context.members.length) throw new Error('Incomplete bounded deletion context.');
  const next = (revision: number) => {
    const parsed = parseRevision(revision+1);
    if (!parsed.ok) throw new CommandError({code:'revision_exhausted',path:['commands','0','expectedRevision'],message:'An affected revision reached its supported limit.',retryable:false,recoveryHint:'Contact the administrator; do not reset any revision.'});
    return parsed.value;
  };
  const advances = context.affectedCount+1;
  const aggregate = parseRevision(current.structuralRevision+advances);
  if (!aggregate.ok) throw new CommandError({code:'revision_exhausted',path:['commands','0','expectedStructuralRevision'],message:'Workspace revision cannot cover this deletion.',retryable:false,recoveryHint:'Contact the administrator; do not reset the revision.'});
  const changes: ChangesResult['changes'] = [];
  if (current.entity === 'task' && current.row !== null && current.version !== null) changes.push({entity:'task',id:current.id,before:{row:current.row,revision:current.version.revision},after:{deleted:true,revision:next(current.version.revision)}});
  else if (current.entity === 'project' && current.row !== null && current.version !== null) changes.push({entity:'project',id:current.id,before:{row:current.row,revision:current.version.revision},after:{deleted:true,revision:next(current.version.revision)}});
  else throw new Error('Deletion target disappeared.');
  const mutations: Plan['ops'] = [];
  for (const link of context.links) {
    if (link.row === null || link.version === null) throw new Error('Cascade link disappeared.');
    changes.push({entity:'link',id:entityStorageKey(link.key),before:{row:link.row,revision:link.version.revision},after:{deleted:true,revision:next(link.version.revision)}});
  }
  for (const member of context.members) {
    if (member.entity !== 'task' || member.row === null || member.version === null || member.row.project_id !== current.id) throw new Error('Deletion member mismatch.');
    const after = {...member.row,project_id:null,updated_at:now};
    if (!taskFromRow(after).ok) throw new Error('Invalid detached task.');
    changes.push({entity:'task',id:member.id,before:{row:member.row,revision:member.version.revision},after:{row:after,revision:next(member.version.revision)}});
    mutations.push({kind:'task.update',id:member.id,patch:{project_id:null,updated_at:now}});
  }
  mutations.push(command.kind === 'task.delete' ? {kind:'task.delete',id:command.id} : {kind:'project.delete_empty',id:command.id});
  const result:ChangesResult = {contractVersion:2,commandId:input.commandId,payloadHash:hash,serverNow:now,applied:true,changes,warnings:[],refs:{}};
  return {result,plan:{assertions:[{kind:'entity.revision',key:current.entity === 'task' ? {entity:'task',id:current.id} : {entity:'project',id:current.id},expected:command.expectedRevision},{kind:'workspace.structural_revision',expected:command.expectedStructuralRevision}],ops:[{kind:'receipt.insert',result},...mutations,{kind:'command.audit',commandId:input.commandId,actor:input.actor,reason:input.reason??null,result},{kind:'command.feed',result}]}};
}
