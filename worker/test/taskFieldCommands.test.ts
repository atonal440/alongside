import { describe, it, expect } from 'vitest';
import { DB } from '../src/db';
import { sqliteD1 } from './helpers/sqliteD1';
import { parseCommandEnvelope, parseChangesPreview, parseChangesResult } from '@shared/wire/commands';
import { parseEntityReadKey } from '@shared/wire/versions';
import { handleApiRequest } from '../src/api';
import { handleMcpRequest } from '../src/mcp';
function key(entity: 'task'|'project',id:string) {const p=parseEntityReadKey({entity,id});if(!p.ok)throw new Error();return p.value;}
function input(kind:string,id:string,revision:number,fields:object,commandId='c_fields01') {
 const p=parseCommandEnvelope({contractVersion:2,commandId,actor:'user',commands:[{kind,id,expectedRevision:revision,...fields}]});if(!p.ok)throw new Error(JSON.stringify(p.error));return p.value;
}
async function setup(mode:'fresh'|'upgrade'='fresh') {
 const fixture=sqliteD1(mode);const db=new DB(fixture.d1);const project=await db.createProject({title:'Project'});const task=await db.addTask({title:'Task',notes:'Context',due_date:'2026-10-05',recurrence:'FREQ=WEEKLY'});
 fixture.batches.length=0;return {...fixture,db,task,project};
}
const schedule={values:{dueDate:'2026-10-12',dueAllDay:true,recurrence:'FREQ=MONTHLY'}};
describe.each(['fresh','upgrade'] as const)('task field commands (%s)',mode=>{
 it('assigns/clears project with coherent guards while preserving other fields',async()=>{
  const {sql,db,task,project,batches}=await setup(mode);
  try {
   const before=await db.getEntitySnapshot(key('task',task.id));const projectBefore=await db.getEntitySnapshot(key('project',project.id));
   const envelope=input('task.project.set',task.id,1,{expectedStructuralRevision:before.structuralRevision,project:{id:project.id,expectedRevision:1}});
   const preview=await db.previewChanges(envelope);expect(parseChangesPreview(preview).ok).toBe(true);expect(preview.requiredStatements).toBe(9);expect(batches).toEqual([]);expect(await db.getEntitySnapshot(key('task',task.id))).toEqual(before);
   const result=await db.applyChanges(envelope);expect(parseChangesResult(result).ok).toBe(true);expect(result).toMatchObject({changes:[{before:{row:task,revision:1},after:{revision:2,row:{project_id:project.id}}}]});
   expect((await db.getEntitySnapshot(key('project',project.id))).version).toEqual(projectBefore.version);
   const assigned=await db.getEntitySnapshot(key('task',task.id));const clear=input('task.project.set',task.id,2,{expectedStructuralRevision:assigned.structuralRevision,project:null},'c_clear01');expect((await db.previewChanges(clear)).requiredStatements).toBe(7);
   await db.applyChanges(clear);const after=await db.getTask(task.id);const omit=(row:object)=>Object.fromEntries(Object.entries(row).filter(([name])=>name!=='updated_at'));
   expect(omit(after!)).toEqual(omit(task));
  }finally{sql.close();}
 });
 it('changes type and complete legacy schedule without altering content, status or attention',async()=>{
  const {sql,db,task}=await setup(mode);
  try {
   await db.focusTask(task.id,'2026-10-14T10:00:00Z');const before=await db.getEntitySnapshot(key('task',task.id));
   const typed=await db.applyChanges(input('task.type.set',task.id,2,{taskType:'plan'}));expect(parseChangesResult(typed).ok).toBe(true);
   const changed=await db.applyChanges(input('task.legacy-schedule.set',task.id,3,schedule,'c_schedule1'));expect(parseChangesResult(changed).ok).toBe(true);
   expect(changed).toMatchObject({changes:[{after:{row:{due_date:'2026-10-12T12:00:00Z',due_all_day:true,recurrence:'FREQ=MONTHLY',task_type:'plan',focused_until:before.row!.focused_until,status:'pending',notes:'Context'},revision:4}}]});
   const cleared=await db.applyChanges(input('task.legacy-schedule.set',task.id,4,{values:{dueDate:null,dueAllDay:null,recurrence:null}},'c_clear02'));expect(cleared).toMatchObject({changes:[{after:{row:{due_date:null,due_all_day:null,recurrence:null}}}]});
  }finally{sql.close();}
 });
});
it.each(['timed','ambiguous'])('stores explicit %s legacy date classification',async kind=>{
 const {sql,db,task}=await setup();
 try {
  const result=await db.applyChanges(input('task.legacy-schedule.set',task.id,1,{values:{dueDate:'2026-10-06T13:22:59-07:00',dueAllDay:kind==='timed'?false:null,recurrence:null}}));
  expect(result).toMatchObject({changes:[{after:{row:{due_date:'2026-10-06T20:22:00Z',due_all_day:kind==='timed'?false:null}}}]});
 }finally{sql.close();}
});
it('preserves done tasks and permits archived project membership under legacy policy',async()=>{
 const {sql,db,task,project}=await setup();
 try {
  await db.completeTask(task.id);await db.updateProject(project.id,{status:'archived'});const current=await db.getEntitySnapshot(key('task',task.id));
  await db.applyChanges(input('task.project.set',task.id,2,{expectedStructuralRevision:current.structuralRevision,project:{id:project.id,expectedRevision:2}}));
  await db.applyChanges(input('task.type.set',task.id,3,{taskType:'plan'},'c_type002'));await db.applyChanges(input('task.legacy-schedule.set',task.id,4,schedule,'c_dates02'));
  expect(await db.getTask(task.id)).toMatchObject({status:'done',project_id:project.id,task_type:'plan'});expect((await db.getProject(project.id))?.status).toBe('archived');
 }finally{sql.close();}
});
it.each(['stale','deleted','missing'])('reports selected project conflict (%s) with its snapshot',async kind=>{
 const {sql,db,task,project,batches}=await setup();
 try {
  if(kind==='stale')await db.updateProject(project.id,{notes:'Winner'});if(kind==='deleted')await db.deleteProject(project.id);
  const current=await db.getEntitySnapshot(key('task',task.id));const id=kind==='missing'?'p_missing':project.id;batches.length=0;
  await expect(db.applyChanges(input('task.project.set',task.id,1,{expectedStructuralRevision:current.structuralRevision,project:{id,expectedRevision:1}}))).rejects.toMatchObject({detail:{code:'revision_conflict',currentEntity:{entity:'project',id},expectedRevision:1}});expect(batches).toEqual([]);
 }finally{sql.close();}
});
it.each(['task-edit','project-edit','project-delete','phantom','identical'])('closes membership race (%s)',async race=>{
 const {sql,db,task,project,hooks}=await setup();
 try {
  const before=await db.getEntitySnapshot(key('task',task.id));const envelope=input('task.project.set',task.id,1,{expectedStructuralRevision:before.structuralRevision,project:{id:project.id,expectedRevision:1}});let winner:unknown;
  hooks.beforeBatch=async()=>{if(race==='task-edit')await db.updateTask(task.id,{notes:'Winner'});else if(race==='project-edit')await db.updateProject(project.id,{notes:'Winner'});else if(race==='project-delete')await db.deleteProject(project.id);else if(race==='phantom')await db.addTask({title:'Phantom'});else winner=await db.applyChanges(envelope);};
  if(race==='identical')expect(await db.applyChanges(envelope)).toEqual(winner);else{await expect(db.applyChanges(envelope)).rejects.toMatchObject({detail:{code:race==='task-edit'?'revision_conflict':'structural_conflict'}});expect((await db.getTask(task.id))?.project_id).toBeNull();expect(sql.prepare('SELECT * FROM command_receipts').all()).toEqual([]);}
 }finally{sql.close();}
});
it.each(['task.type.set','task.legacy-schedule.set'])('allows unrelated races for %s but rejects task races',async kind=>{
 const {sql,db,task,project,hooks}=await setup();
 try {
  const fields=kind==='task.type.set'?{taskType:'plan'}:schedule;hooks.beforeBatch=async()=>{await db.updateProject(project.id,{notes:'Unrelated'});};expect(parseChangesResult(await db.applyChanges(input(kind,task.id,1,fields))).ok).toBe(true);
  hooks.beforeBatch=async()=>{await db.updateTask(task.id,{notes:'Winner'});};await expect(db.applyChanges(input(kind,task.id,2,fields,'c_race002'))).rejects.toMatchObject({detail:{code:'revision_conflict'}});
 }finally{sql.close();}
});
it.each(['task.project.set','task.type.set','task.legacy-schedule.set'])('replays %s after lost response, edits and deletion',async kind=>{
 const {sql,db,task,project,hooks}=await setup();
 try {
  const current=await db.getEntitySnapshot(key('task',task.id));const fields=kind==='task.project.set'?{expectedStructuralRevision:current.structuralRevision,project:{id:project.id,expectedRevision:1}}:kind==='task.type.set'?{taskType:'plan'}:schedule;
  const envelope=input(kind,task.id,1,fields);hooks.loseResponse=true;const first=await db.applyChanges(envelope);await db.updateTask(task.id,{notes:'Later'});await db.deleteTask(task.id);expect(await db.applyChanges(envelope)).toEqual(first);expect(sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toMatchObject({n:1});
 }finally{sql.close();}
});
it.each([7,8])('rolls back membership and ledgers/history on late failure %s',async failAfter=>{
 const {sql,db,task,project,hooks}=await setup();
 try {
  const before=await db.getEntitySnapshot(key('task',task.id));hooks.failAfter=failAfter;await expect(db.applyChanges(input('task.project.set',task.id,1,{expectedStructuralRevision:before.structuralRevision,project:{id:project.id,expectedRevision:1}}))).rejects.toMatchObject({detail:{code:'storage_unavailable'}});
  expect(await db.getEntitySnapshot(key('task',task.id))).toEqual(before);for(const table of ['command_receipts','command_audit','change_feed'])expect(sql.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
 }finally{sql.close();}
});
it('uses REST/MCP shared field contract and parsed diffs',async()=>{
 const {sql,db,d1,task}=await setup();
 try {
  const envelope=input('task.legacy-schedule.set',task.id,1,schedule);const req=new Request('https://test/api/v2/changes',{method:'POST',body:JSON.stringify(envelope)});const r=await handleApiRequest(req,new URL(req.url),db);expect(r.status).toBe(200);const result=await r.json();expect(parseChangesResult(result).ok).toBe(true);
  const rpc=new Request('https://test/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'apply_changes',arguments:envelope}})});expect(await(await handleMcpRequest(rpc,db,{DB:d1,AUTH_TOKEN:'test'})).json()).toMatchObject({result:{structuredContent:result}});
 }finally{sql.close();}
});
it.each([
 {dueDate:null,dueAllDay:true,recurrence:null},{dueDate:null,dueAllDay:null,recurrence:'FREQ=WEEKLY'},
 {dueDate:'2026-10-05',dueAllDay:false,recurrence:'FREQ=WEEKLY'},{dueDate:'0099-12-31',dueAllDay:true,recurrence:null},
 {dueDate:'0100-01-01T00:00:00+01:00',dueAllDay:false,recurrence:null},{dueDate:'2026-10-05',recurrence:null},
 {dueDate:'2026-10-05',dueAllDay:true,recurrence:'FREQ=SECONDLY'},{dueDate:'2026-10-05',dueAllDay:true,recurrence:null,deadline:null},
])('rejects incomplete/inconsistent legacy schedule at boundary',values=>{
 expect(parseCommandEnvelope({contractVersion:2,commandId:'c_fields01',actor:'user',commands:[{kind:'task.legacy-schedule.set',id:'t_first1',expectedRevision:1,values}]}).ok).toBe(false);
});
