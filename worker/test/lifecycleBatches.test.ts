import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { sqliteD1 } from './helpers/sqliteD1';
import { parseCommandEnvelope, parseChangesResult, parseChangesPreview } from '@shared/wire/commands';
function envelope(commands:unknown[],structural:number,id='c_life001') {const parsed=parseCommandEnvelope({contractVersion:2,actor:'user',commandId:id,expectedStructuralRevision:structural,commands});if(!parsed.ok)throw new Error(JSON.stringify(parsed.error));return parsed.value;}
async function setup(mode:'fresh'|'upgrade'='fresh',recurring=false){
 const fixture=sqliteD1(mode),db=new DB(fixture.d1);const project=await db.createProject({title:'Project'});
 const task=await db.addTask({title:'Target',project_id:project.id,...(recurring?{due_date:'2026-10-01',due_all_day:true,recurrence:'FREQ=WEEKLY'}:{})});const other=await db.addTask({title:'Other'});await db.linkTasks(task.id,other.id,'blocks');
 return {...fixture,db,project,task,other,structural:4};
}
describe.each(['fresh','upgrade'] as const)('compound lifecycle batches (%s)',mode=>{
 it('completes recurring work plus unrelated edits with one successor receipt',async()=>{
  const {sql,db,task,other,structural,hooks}=await setup(mode,true);try{
   const input=envelope([{kind:'task.complete',id:task.id,expectedRevision:1,expectedStructuralRevision:structural,successor:{id:'t_next001',clientRef:'next'}},{kind:'task.content.set',id:other.id,expectedRevision:1,values:{title:'Edited',notes:null,kickoffNote:null,sessionLog:null}}],structural);
   const preview=await db.previewChanges(input);expect(parseChangesPreview(preview).ok).toBe(true);expect(preview.changeGroups).toEqual([2,1]);expect((await db.getTask(task.id))?.status).toBe('pending');hooks.loseResponse=true;
   const result=await db.applyChanges(input);expect(parseChangesResult(result).ok).toBe(true);expect(result.changeGroups).toEqual([2,1]);expect(result.refs).toEqual({next:'t_next001'});expect(result.changes[0]).toMatchObject({after:{row:{status:'done'}}});expect(result.changes[1]).toMatchObject({after:{row:{due_date:'2026-10-08T12:00:00Z'}}});expect(result.changes[2]).toMatchObject({after:{row:{title:'Edited'}}});
   await db.deleteTask('t_next001');expect(await db.applyChanges(input)).toEqual(result);expect(sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toMatchObject({n:1});
  }finally{sql.close();}
 });
 it('deletes a task with link cascades and changes a surviving task atomically',async()=>{
  const {sql,db,task,other,structural}=await setup(mode);try{
   const input=envelope([{kind:'task.delete',id:task.id,expectedRevision:1,expectedStructuralRevision:structural},{kind:'task.type.set',id:other.id,expectedRevision:1,taskType:'plan'}],structural);
   const result=await db.applyChanges(input);expect(parseChangesResult(result).ok).toBe(true);expect(result.changeGroups).toEqual([2,1]);expect(result.changes.slice(0,2).every(change=>'deleted' in change.after)).toBe(true);expect((await db.getTask(other.id))?.task_type).toBe('plan');expect(await db.listAllLinks()).toEqual([]);expect(await db.applyChanges(input)).toEqual(result);
  }finally{sql.close();}
 });
 it('detaches project members while preserving unrelated field intent',async()=>{
  const {sql,db,project,task,other,structural}=await setup(mode);try{
   const input=envelope([{kind:'project.delete',id:project.id,expectedRevision:1,expectedStructuralRevision:structural},{kind:'task.type.set',id:other.id,expectedRevision:1,taskType:'plan'}],structural);
   const result=await db.applyChanges(input);expect(parseChangesResult(result).ok).toBe(true);expect(result.changeGroups).toEqual([2,1]);expect((await db.getTask(task.id))?.project_id).toBeNull();expect(await db.listAllLinks()).toHaveLength(1);expect((await db.getTask(other.id))?.task_type).toBe('plan');
  }finally{sql.close();}
 });
});
it('allows explicitly removed cascade edges without double-writing their identity',async()=>{
 const {sql,db,task,other,structural}=await setup();try{
  const input=envelope([{kind:'link.remove',from:task.id,to:other.id,linkType:'blocks',expectedRevision:1,expectedStructuralRevision:structural},{kind:'task.delete',id:task.id,expectedRevision:1,expectedStructuralRevision:structural}],structural);
  const result=await db.applyChanges(input);expect(result.changeGroups).toEqual([1,1]);expect(result.changes).toHaveLength(2);expect(parseChangesResult(result).ok).toBe(true);expect(sql.prepare("SELECT revision FROM entity_versions WHERE entity='link'").all()).toEqual([{revision:2}]);
 }finally{sql.close();}
});
it('rejects overlapping derived writes before any mutation',async()=>{
 const {sql,db,project,task,structural,batches}=await setup();try{
  batches.length=0;const input=envelope([{kind:'task.type.set',id:task.id,expectedRevision:1,taskType:'plan'},{kind:'project.delete',id:project.id,expectedRevision:1,expectedStructuralRevision:structural}],structural);
  await expect(db.applyChanges(input)).rejects.toMatchObject({detail:{code:'invalid_input',path:['commands','1']}});expect(batches).toEqual([]);expect((await db.getTask(task.id))?.project_id).toBe(project.id);expect((await db.getTask(task.id))?.task_type).toBe('action');
 }finally{sql.close();}
});
it.each(['phantom','identical','failure'])('keeps compound lifecycle effects atomic under %s',async race=>{
 const {sql,db,task,other,structural,hooks}=await setup('upgrade');try{
  const input=envelope([{kind:'task.delete',id:task.id,expectedRevision:1,expectedStructuralRevision:structural},{kind:'task.type.set',id:other.id,expectedRevision:1,taskType:'plan'}],structural);let winner:unknown;
  if(race==='failure')hooks.failAfter=(await db.previewChanges(input)).requiredStatements-1;else hooks.beforeBatch=async()=>{if(race==='identical')winner=await db.applyChanges(input);else await db.linkTasks(other.id,task.id,'related');};
  if(race==='identical')expect(await db.applyChanges(input)).toEqual(winner);else{await expect(db.applyChanges(input)).rejects.toMatchObject({detail:{code:race==='phantom'?'structural_conflict':'storage_unavailable'}});expect((await db.getTask(task.id))?.status).toBe('pending');expect((await db.getTask(other.id))?.task_type).toBe('action');for(const table of ['command_receipts','command_audit','change_feed'])expect(sql.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);}
 }finally{sql.close();}
});
it.each([29,30])('counts all derived lifecycle images at the combined capacity boundary (members=%s)',async count=>{
 const {sql,db,project,other,batches,structural}=await setup();try{
  for(let i=1;i<count;i++)await db.addTask({title:'Member '+i,project_id:project.id});
  const expected=structural+count-1,input=envelope([{kind:'project.delete',id:project.id,expectedRevision:1,expectedStructuralRevision:expected},{kind:'task.type.set',id:other.id,expectedRevision:1,taskType:'plan'}],expected);batches.length=0;
  if(count===30){for(const action of [()=>db.previewChanges(input),()=>db.applyChanges(input)])await expect(action()).rejects.toMatchObject({status:413,detail:{code:'capacity_exceeded',requiredStatements:101,limit:100}});expect(batches).toEqual([]);expect(await db.getProject(project.id)).not.toBeNull();expect((await db.getTask(other.id))?.task_type).toBe('action');}
  else{const preview=await db.previewChanges(input);expect(preview.requiredStatements).toBe(98);const result=await db.applyChanges(input);expect(result.changeGroups).toEqual([30,1]);expect(parseChangesResult(result).ok).toBe(true);expect(batches).toEqual([98]);}
 }finally{sql.close();}
});
it('can link a new recurring successor within the same atomic command',async()=>{
 const {sql,db,task,other,structural}=await setup('fresh',true);try{
  const input=envelope([{kind:'task.complete',id:task.id,expectedRevision:1,expectedStructuralRevision:structural,successor:{id:'t_next001'}},{kind:'link.add',from:'t_next001',to:other.id,linkType:'blocks',expectedRevision:null,expectedStructuralRevision:structural}],structural);
  const result=await db.applyChanges(input);expect(result.changeGroups).toEqual([2,1]);expect(parseChangesResult(result).ok).toBe(true);expect(await db.listAllLinks()).toHaveLength(2);
 }finally{sql.close();}
});
it('can explicitly move a member before deleting its former project without detaching it again',async()=>{
 const {sql,db,task,project,structural}=await setup();try{
  const input=envelope([{kind:'task.project.set',id:task.id,expectedRevision:1,expectedStructuralRevision:structural,project:null},{kind:'project.delete',id:project.id,expectedRevision:1,expectedStructuralRevision:structural}],structural);
  const result=await db.applyChanges(input);expect(result.changeGroups).toEqual([1,1]);expect(parseChangesResult(result).ok).toBe(true);expect((await db.getEntitySnapshot({entity:'task',id:task.id as never})).version?.revision).toBe(2);
 }finally{sql.close();}
});
