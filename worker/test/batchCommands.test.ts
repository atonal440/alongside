import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { sqliteD1 } from './helpers/sqliteD1';
import { parseCommandEnvelope, parseChangesPreview, parseChangesResult } from '@shared/wire/commands';
const values={title:'Task',notes:null,kickoffNote:null,taskType:'action',project:null};
function input(commands:unknown[],expectedStructuralRevision=0,commandId='c_batch01') {
 const parsed=parseCommandEnvelope({contractVersion:2,actor:'user',commandId,expectedStructuralRevision,commands});if(!parsed.ok)throw new Error(JSON.stringify(parsed.error));return parsed.value;
}
function create(id:string,expectedStructuralRevision=0,patch={}) {return {kind:'task.create',id,expectedRevision:null,expectedStructuralRevision,values,...patch};}
function link(from:string,to:string,expectedStructuralRevision=0,patch={}) {return {kind:'link.add',from,to,linkType:'blocks',expectedRevision:null,expectedStructuralRevision,...patch};}
describe.each(['fresh','upgrade'] as const)('mixed batch (%s)',mode=>{
 it('creates project/tasks/edges with stable refs and one receipt',async()=>{
  const {sql,d1,batches}=sqliteD1(mode);const db=new DB(d1);try{
   const envelope=input([{kind:'project.create',id:'p_first1',clientRef:'project',expectedRevision:null,expectedStructuralRevision:0,values:{title:'Project',notes:null,kickoffNote:null}},create('t_first1',0,{clientRef:'first',values:{...values,project:{id:'p_first1',expectedRevision:1}}}),create('t_second',0,{clientRef:'second'}),link('t_first1','t_second')]);
   const preview=await db.previewChanges(envelope);expect(parseChangesPreview(preview).ok).toBe(true);expect(preview.batch).toBe(true);expect(batches).toEqual([]);expect(await db.listAllTasks()).toEqual([]);
   const result=await db.applyChanges(envelope);expect(parseChangesResult(result).ok).toBe(true);expect(result.changes).toHaveLength(4);expect(result.refs).toEqual({project:'p_first1',first:'t_first1',second:'t_second'});expect(batches).toEqual([preview.requiredStatements]);expect(sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toMatchObject({n:1});expect(sql.prepare('SELECT COUNT(*) AS n FROM command_audit').get()).toMatchObject({n:1});
   expect((await db.getEntitySnapshot({entity:'task',id:'t_first1' as never})).row?.project_id).toBe('p_first1');await db.deleteTask('t_second');expect(await db.applyChanges(envelope)).toEqual(result);await expect(db.applyChanges({...envelope,reason:'Changed'})).rejects.toMatchObject({detail:{code:'command_id_conflict'}});
  }finally{sql.close();}
 });
});
it.each([false,true])('validates final blocks graph regardless of removal position (removeFirst=%s)',async removeFirst=>{
 const {sql,d1}=sqliteD1();const db=new DB(d1);try{
  await db.applyChanges(input([create('t_first1'),create('t_second'),link('t_first1','t_second')]));
  const remove={kind:'link.remove',from:'t_first1',to:'t_second',linkType:'blocks',expectedRevision:1,expectedStructuralRevision:3};const add=link('t_second','t_first1',3);
  const envelope=input(removeFirst?[remove,add]:[add,remove],3,'c_reverse1');const result=await db.applyChanges(envelope);expect(parseChangesResult(result).ok).toBe(true);expect(await db.listAllLinks()).toEqual([{from_task_id:'t_second',to_task_id:'t_first1',link_type:'blocks'}]);
 }finally{sql.close();}
});
it('rejects cycles formed only by multiple new edges before a batch',async()=>{
 const {sql,d1,batches}=sqliteD1();const db=new DB(d1);try{
  const envelope=input([create('t_first1'),create('t_second'),link('t_first1','t_second'),link('t_second','t_first1')]);for(const action of [()=>db.previewChanges(envelope),()=>db.applyChanges(envelope)])await expect(action()).rejects.toMatchObject({detail:{code:'graph_cycle',retryable:false}});expect(batches).toEqual([]);expect(await db.listAllTasks()).toEqual([]);
 }finally{sql.close();}
});
it('atomically replaces a reverse legacy related identity in either command order',async()=>{
 const {sql,d1}=sqliteD1();const db=new DB(d1);try{
  await db.applyChanges(input([create('t_first1'),create('t_second')]));await db.linkTasks('t_second','t_first1','related');
  const envelope=input([link('t_first1','t_second',3,{linkType:'related'}),{kind:'link.remove',from:'t_second',to:'t_first1',linkType:'related',expectedRevision:1,expectedStructuralRevision:3}],3,'c_related1');expect(parseChangesResult(await db.applyChanges(envelope)).ok).toBe(true);expect(await db.listAllLinks()).toEqual([{from_task_id:'t_first1',to_task_id:'t_second',link_type:'related'}]);
 }finally{sql.close();}
});
it.each(['phantom','identical','lost'])('keeps the entire logical command atomic under %s',async race=>{
 const {sql,d1,hooks}=sqliteD1();const db=new DB(d1);try{
  const envelope=input([create('t_first1'),create('t_second'),link('t_first1','t_second')]);let winner:unknown;
  if(race==='lost')hooks.loseResponse=true;else hooks.beforeBatch=async()=>{if(race==='identical')winner=await db.applyChanges(envelope);else await db.addTask({title:'Phantom'});};
  if(race==='phantom'){await expect(db.applyChanges(envelope)).rejects.toMatchObject({detail:{code:'structural_conflict'}});expect(sql.prepare('SELECT * FROM command_receipts').all()).toEqual([]);expect(await db.listAllLinks()).toEqual([]);expect((await db.listAllTasks()).map(task=>task.title)).toEqual(['Phantom']);}
  else {const result=await db.applyChanges(envelope);if(race==='identical')expect(result).toEqual(winner);expect(await db.applyChanges(envelope)).toEqual(result);expect(await db.listAllTasks()).toHaveLength(2);expect(await db.listAllLinks()).toHaveLength(1);expect(sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toMatchObject({n:1});}
 }finally{sql.close();}
});
it('rolls back all entities and histories after a late final-graph guard failure',async()=>{
 const {sql,d1,hooks}=sqliteD1();const db=new DB(d1);try{
  const envelope=input([create('t_first1'),create('t_second'),link('t_first1','t_second')]);const preview=await db.previewChanges(envelope);hooks.failAfter=preview.requiredStatements-2;await expect(db.applyChanges(envelope)).rejects.toMatchObject({detail:{code:'storage_unavailable'}});for(const table of ['tasks','task_links','entity_versions','command_receipts','command_audit','change_feed'])expect(sql.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);expect(sql.prepare('SELECT structural_revision FROM workspace_versions').get()).toMatchObject({structural_revision:0});
 }finally{sql.close();}
});
it('rejects duplicate written identities and reports the actual command index',async()=>{
 const {sql,d1}=sqliteD1();const db=new DB(d1);try{
  await expect(db.applyChanges(input([create('t_first1'),{kind:'task.type.set',id:'t_first1',expectedRevision:1,taskType:'plan'}]))).rejects.toMatchObject({detail:{code:'invalid_input',path:['commands','1']}});
  await expect(db.applyChanges(input([create('t_first1'),link('t_first1','t_second')]))).rejects.toMatchObject({detail:{code:'invalid_transition',path:['commands','1']}});expect(await db.listAllTasks()).toEqual([]);
 }finally{sql.close();}
});
it('guards edited project references against their initial ledger version',async()=>{
 const {sql,d1}=sqliteD1();const db=new DB(d1);try{
  const project=await db.createProject({title:'Old'});const structural=1;
  const envelope=input([{kind:'project.content.set',id:project.id,expectedRevision:1,values:{title:'New',notes:null,kickoffNote:null}},create('t_first1',structural,{values:{...values,project:{id:project.id,expectedRevision:2}}})],structural);
  const result=await db.applyChanges(envelope);expect(parseChangesResult(result).ok).toBe(true);expect((await db.getProject(project.id))?.title).toBe('New');expect((await db.getTask('t_first1'))?.project_id).toBe(project.id);
 }finally{sql.close();}
});
it('counts deduplicated guards and every final validation/feed statement before writes',async()=>{
 const {sql,d1,batches}=sqliteD1();const db=new DB(d1);try{
  const tasks=Array.from({length:20},(_,i)=>create(`t_child${i.toString().padStart(3,'0')}`));const init=input(tasks);expect((await db.previewChanges(init)).requiredStatements).toBe(63);await db.applyChanges(init);batches.length=0;
  const edges=[...Array.from({length:19},(_,i)=>link(`t_child${i.toString().padStart(3,'0')}`,`t_child${(i+1).toString().padStart(3,'0')}`,20)),link('t_child000','t_child002',20)];
  const envelope=input(edges,20,'c_capacity1');await expect(db.previewChanges(envelope)).rejects.toMatchObject({status:413,detail:{code:'capacity_exceeded',requiredStatements:103,limit:100}});await expect(db.applyChanges(envelope)).rejects.toMatchObject({status:413,detail:{code:'capacity_exceeded',requiredStatements:103,limit:100}});expect(batches).toEqual([]);expect(await db.listAllLinks()).toEqual([]);
  const bounded=input(edges.map((edge,index)=>index>=17?{...edge,linkType:'related'}:edge),20,'c_exact100');expect((await db.previewChanges(bounded)).requiredStatements).toBe(100);expect(parseChangesResult(await db.applyChanges(bounded)).ok).toBe(true);expect(batches).toEqual([100]);
 }finally{sql.close();}
});
it('returns stored conflict values rather than uncommitted virtual images',async()=>{
 const {sql,d1}=sqliteD1();const db=new DB(d1);try{
  const project=await db.createProject({title:'Stored'});
  const envelope=input([{kind:'project.content.set',id:project.id,expectedRevision:1,values:{title:'Proposed',notes:null,kickoffNote:null}},create('t_first1',1,{values:{...values,project:{id:project.id,expectedRevision:99}}})],1);
  await expect(db.applyChanges(envelope)).rejects.toMatchObject({detail:{code:'revision_conflict',path:['commands','1','values','project'],currentEntity:{structuralRevision:1,version:{revision:1},row:{title:'Stored'}}}});expect((await db.getProject(project.id))?.title).toBe('Stored');
 }finally{sql.close();}
});
it.each([
 {expectedStructuralRevision:undefined}, {commands:[create('t_first1'),{kind:'planning.set',expectedRevision:null,values:{timezone:'UTC',workingHours:[],bufferMinutes:0}}]},
 {commands:[create('t_first1'),create('t_second',0,{clientRef:'same'}),create('t_third1',0,{clientRef:'same'})]},
 {commands:Array.from({length:21},(_,i)=>create(`t_child${i.toString().padStart(3,'0')}`))},
])('rejects missing aggregate guards, unsupported compound families and duplicate refs',patch=>{
 expect(parseCommandEnvelope({contractVersion:2,actor:'user',commandId:'c_batch01',expectedStructuralRevision:0,commands:[create('t_first1'),create('t_second')],...patch}).ok).toBe(false);
});
it('shares batch schemas, preview and receipt replay across REST/MCP',async()=>{
 const {handleApiRequest}=await import('../src/api');const {handleMcpRequest}=await import('../src/mcp');const {COMMAND_TOOLS}=await import('../src/commands');
 const {sql,d1}=sqliteD1();const db=new DB(d1);try{
  const envelope=input([create('t_first1'),create('t_second'),link('t_first1','t_second')]);
  const request=new Request('https://test/api/v2/changes',{method:'POST',body:JSON.stringify(envelope)});const response=await handleApiRequest(request,new URL(request.url),db);expect(response.status).toBe(200);const result=await response.json();expect(parseChangesResult(result).ok).toBe(true);
  const rpc=new Request('https://test/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'apply_changes',arguments:envelope}})});expect(await(await handleMcpRequest(rpc,db,{DB:d1,AUTH_TOKEN:'test'})).json()).toMatchObject({result:{structuredContent:result}});
  const tool=COMMAND_TOOLS.find(tool=>tool.name==='apply_changes');expect(tool?.inputSchema.properties.commands.maxItems).toBe(20);expect(tool?.inputSchema.properties.expectedStructuralRevision.type).toBe('integer');
 }finally{sql.close();}
});
it('enforces the final graph guard in SQL after all staged edge writes',async()=>{
 const {applyPlan}=await import('../src/storage/apply');const {sql,d1}=sqliteD1();const db=new DB(d1);try{
  await db.applyChanges(input([create('t_first1'),create('t_second')]));
  const result=await applyPlan(d1,{assertions:[],ops:[{kind:'link.insert',row:{from_task_id:'t_first1',to_task_id:'t_second',link_type:'blocks'}},{kind:'link.insert',row:{from_task_id:'t_second',to_task_id:'t_first1',link_type:'blocks'}},{kind:'graph.assert_acyclic',from:'t_first1' as never,to:'t_second' as never}]});
  expect(result).toMatchObject({ok:false,error:{kind:'storage'}});expect(await db.listAllLinks()).toEqual([]);expect(sql.prepare("SELECT * FROM entity_versions WHERE entity='link'").all()).toEqual([]);expect(sql.prepare('SELECT structural_revision FROM workspace_versions').get()).toMatchObject({structural_revision:2});
 }finally{sql.close();}
});
it('rejects aggregate exhaustion across the entire proposed batch before writes',async()=>{
 const {sql,d1,batches}=sqliteD1();const db=new DB(d1);try{
  const expected=Number.MAX_SAFE_INTEGER-1;sql.prepare('UPDATE workspace_versions SET structural_revision=?').run(expected);
  await expect(db.applyChanges(input([create('t_first1',expected),create('t_second',expected)],expected))).rejects.toMatchObject({detail:{code:'revision_exhausted',path:['commands','1','expectedStructuralRevision']}});expect(batches).toEqual([]);expect(await db.listAllTasks()).toEqual([]);
 }finally{sql.close();}
});
