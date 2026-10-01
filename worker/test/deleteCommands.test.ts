import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { sqliteD1 } from './helpers/sqliteD1';
import { parseCommandEnvelope, parseChangesPreview, parseChangesResult } from '@shared/wire/commands';
import { readDeleteContext } from '../src/storage/deletion';
import { handleApiRequest } from '../src/api';
import { handleMcpRequest } from '../src/mcp';
import { parseFoundationErrorEnvelope } from '@shared/wire/planning';
import { parseTaskId } from '@shared/parse';
const instant='2026-10-01T00:00:00Z';
const target=parseTaskId('t_target1');if(!target.ok)throw new Error();
async function setup(mode:'fresh'|'upgrade'='fresh',project=false,count=2) {
 const fixture=sqliteD1(mode),db=new DB(fixture.d1);
 fixture.sql.prepare("INSERT INTO projects(id,title,status,created_at,updated_at) VALUES('p_first1','Project','active',?,?)").run(instant,instant);
 const insert=fixture.sql.prepare("INSERT INTO tasks(id,title,status,project_id,notes,created_at,updated_at) VALUES(?,?,'pending',?,'Preserved',?,?)");
 insert.run('t_target1','Target',null,instant,instant);
 for(let i=0;i<count;i++) {const id=`t_child${String(i).padStart(3,'0')}`;insert.run(id,id,project?'p_first1':null,instant,instant);if(!project)fixture.sql.prepare("INSERT INTO task_links VALUES('t_target1',?,'blocks')").run(id);}
 const id=project?'p_first1':'t_target1';const kind=project?'project.delete':'task.delete';const structural=(await db.getEntitySnapshot(project?{entity:'project',id:'p_first1' as never}:{entity:'task',id:target.value})).structuralRevision;
 const input=parseCommandEnvelope({contractVersion:2,actor:'user',commandId:'c_delete1',commands:[{kind,id,expectedRevision:1,expectedStructuralRevision:structural}]});if(!input.ok)throw new Error();
 return {...fixture,db,input:input.value};
}
describe.each(['fresh','upgrade'] as const)('reliable deletion (%s)',mode=>{
 it.each([false,true])('returns all derived effects and commits once (project=%s)',async project=>{
  const {sql,db,input,batches}=await setup(mode,project);try {
   const preview=await db.previewChanges(input);expect(parseChangesPreview(preview).ok).toBe(true);expect(preview.requiredStatements).toBe(project?13:9);expect(batches).toEqual([]);
   const result=await db.applyChanges(input);expect(parseChangesResult(result).ok).toBe(true);expect(result.changes).toHaveLength(3);expect(result.changes[0]).toMatchObject({entity:project?'project':'task',before:{revision:1},after:{deleted:true,revision:2}});
   if(project){const tasks=await db.listTasks();expect(tasks).toHaveLength(3);for(const change of result.changes.slice(1))expect(change).toMatchObject({entity:'task',before:{row:{project_id:'p_first1'}},after:{revision:2,row:{project_id:null,notes:'Preserved',updated_at:result.serverNow}}});expect(await db.listProjects()).toEqual([]);}
   else {expect(await db.listAllLinks()).toEqual([]);expect(sql.prepare("SELECT revision,deleted_at FROM entity_versions WHERE entity='link'").all()).toEqual(expect.arrayContaining([expect.objectContaining({revision:2,deleted_at:expect.any(String)})]));}
   expect(sql.prepare('SELECT operation FROM change_feed ORDER BY seq').all()).toEqual(project?[{operation:'delete'},{operation:'upsert'},{operation:'upsert'}]:[{operation:'delete'},{operation:'delete'},{operation:'delete'}]);
   expect(await db.applyChanges(input)).toEqual(result);expect(batches).toEqual([project?13:9]);
  }finally{sql.close();}
 });
});
it.each([false,true])('enforces the atomic capacity boundary with exact counts (project=%s)',async project=>{
 for(const count of [project?31:93,project?32:94]) {
  const {sql,db,input,batches}=await setup('fresh',project,count);try{
   const required=7+count*(project?3:1);
   if(required>100){for(const action of [()=>db.previewChanges(input),()=>db.applyChanges(input)])await expect(action()).rejects.toMatchObject({detail:{code:'capacity_exceeded',requiredStatements:required,limit:100},status:413});expect(batches).toEqual([]);expect(sql.prepare('SELECT * FROM command_receipts').all()).toEqual([]);}
   else {expect((await db.previewChanges(input)).requiredStatements).toBe(required);const result=await db.applyChanges(input);expect(parseChangesResult(result).ok).toBe(true);expect(batches).toEqual([required]);}
  }finally{sql.close();}
 }
});
it.each([false,true])('guards concurrent phantom/member/edge writes (project=%s)',async project=>{
 const {sql,db,input,hooks}=await setup('fresh',project);try{
  hooks.beforeBatch=async()=>{const task=await db.addTask({title:'Phantom'});if(project)await db.updateTask(task.id,{project_id:'p_first1'});else await db.linkTasks('t_target1',task.id,'related');};
  await expect(db.applyChanges(input)).rejects.toMatchObject({detail:{code:'structural_conflict'}});for(const table of ['command_receipts','command_audit','change_feed'])expect(sql.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);expect(sql.prepare('SELECT id FROM tasks WHERE id=?').get('t_target1')).toBeDefined();
 }finally{sql.close();}
});
it.each([false,true])('replays lost response and identical races after deletion (project=%s)',async project=>{
 const {sql,db,input,hooks}=await setup('fresh',project);try{hooks.loseResponse=true;const result=await db.applyChanges(input);expect(await db.applyChanges(input)).toEqual(result);await expect(db.applyChanges({...input,reason:'different'})).rejects.toMatchObject({detail:{code:'command_id_conflict'}});}finally{sql.close();}
 const fixture=await setup('fresh',project);try{let winner:unknown;fixture.hooks.beforeBatch=async()=>{winner=await fixture.db.applyChanges(fixture.input);};expect(await fixture.db.applyChanges(fixture.input)).toEqual(winner);expect(fixture.sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toMatchObject({n:1});}finally{fixture.sql.close();}
});
it.each([false,true])('rolls back deletion effects and all provenance after late failure (project=%s)',async project=>{
 const {sql,db,d1,input,hooks}=await setup('fresh',project);try{const before=await readDeleteContext(d1,{entity:'task',id:target.value});hooks.failAfter=project?12:8;await expect(db.applyChanges(input)).rejects.toMatchObject({detail:{code:'storage_unavailable'}});expect(await readDeleteContext(d1,{entity:'task',id:target.value})).toEqual(before);for(const table of ['command_receipts','command_audit','change_feed'])expect(sql.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);expect(await db.listProjects()).toHaveLength(1);expect((await db.listTasks()).filter(task=>task.project_id==='p_first1')).toHaveLength(project?2:0);}finally{sql.close();}
});
it.each(['entity','effect','workspace'])('rejects %s revision exhaustion before writes',async exhaustion=>{
 const {sql,db,input}=await setup();try{
  if(exhaustion==='entity')sql.exec("UPDATE entity_versions SET revision=9007199254740991 WHERE entity_key='t_target1'");else if(exhaustion==='effect')sql.exec("UPDATE entity_versions SET revision=9007199254740991 WHERE entity='link'");else sql.exec('UPDATE workspace_versions SET structural_revision=9007199254740990');
  const current=await db.getEntitySnapshot({entity:'task',id:target.value});const command=input.commands[0];if(command.kind!=='task.delete')throw new Error();const envelope={...input,commands:[{...command,expectedRevision:current.version!.revision,expectedStructuralRevision:current.structuralRevision}]};
  await expect(db.applyChanges(envelope)).rejects.toMatchObject({detail:{code:'revision_exhausted',retryable:false}});expect(sql.prepare('SELECT * FROM command_receipts').all()).toEqual([]);
 }finally{sql.close();}
});
it('rejects projects with duty ownership before preview or apply',async()=>{
 const {sql,db,input}=await setup('fresh',true,0);try{
  sql.exec("INSERT INTO duties(id,title,dtstart,timezone,rrule,project_id,created_at,updated_at) VALUES('d_first1','Duty','2026-10-01T00:00:00Z','UTC','FREQ=DAILY','p_first1','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')");
  const current=await db.getEntitySnapshot({entity:'project',id:'p_first1' as never});const command=input.commands[0];if(command.kind!=='project.delete')throw new Error();const envelope={...input,commands:[{...command,expectedStructuralRevision:current.structuralRevision}]};
  await expect(db.previewChanges(envelope)).rejects.toMatchObject({detail:{code:'invalid_transition'}});await expect(db.applyChanges(envelope)).rejects.toMatchObject({detail:{code:'invalid_transition'}});
 }finally{sql.close();}
});
it('shares complete deletion and retained stale diagnostics over REST/MCP',async()=>{
 const {sql,db,d1,input}=await setup();try{
  const request=new Request('https://test/api/v2/changes',{method:'POST',body:JSON.stringify(input)});const response=await handleApiRequest(request,new URL(request.url),db);expect(response.status).toBe(200);const result=await response.json();expect(parseChangesResult(result).ok).toBe(true);
  const rpc=new Request('https://test/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'apply_changes',arguments:input}})});expect(await(await handleMcpRequest(rpc,db,{DB:d1,AUTH_TOKEN:'test'})).json()).toMatchObject({result:{structuredContent:result}});
  const stale=new Request('https://test/api/v2/changes',{method:'POST',body:JSON.stringify({...input,commandId:'c_stale001'})});const failed=await handleApiRequest(stale,new URL(stale.url),db);expect(failed.status).toBe(409);const body=await failed.json();expect(parseFoundationErrorEnvelope(body).ok).toBe(true);expect(body).toMatchObject({error:{code:'revision_conflict',currentEntity:{row:null,version:{revision:2}}}});
 }finally{sql.close();}
});
it('returns versioned exact capacity errors on REST/MCP before writes',async()=>{
 const {sql,db,d1,input,batches}=await setup('fresh',true,32);try{
  const request=new Request('https://test/api/v2/changes/preview',{method:'POST',body:JSON.stringify(input)});const response=await handleApiRequest(request,new URL(request.url),db);expect(response.status).toBe(413);const body=await response.json();expect(parseFoundationErrorEnvelope(body).ok).toBe(true);expect(body).toMatchObject({contractVersion:2,error:{code:'capacity_exceeded',requiredStatements:103,limit:100,retryable:false}});
  const rpc=new Request('https://test/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'apply_changes',arguments:input}})});expect(await(await handleMcpRequest(rpc,db,{DB:d1,AUTH_TOKEN:'test'})).json()).toMatchObject({result:{isError:true,structuredContent:body}});expect(batches).toEqual([]);
 }finally{sql.close();}
});
