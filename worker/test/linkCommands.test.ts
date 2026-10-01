import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { sqliteD1 } from './helpers/sqliteD1';
import { parseLinkKey, parseLinkSnapshot, entityStorageKey } from '@shared/wire/versions';
import { parseCommandEnvelope, parseChangesPreview, parseChangesResult } from '@shared/wire/commands';
import { handleApiRequest } from '../src/api';
import { handleMcpRequest } from '../src/mcp';
import { parseFoundationErrorEnvelope } from '@shared/wire/planning';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
function key(from='t_first1',to='t_second',linkType='blocks') {const p=parseLinkKey({entity:'link',from,to,linkType});if(!p.ok)throw new Error();return p.value;}
function input(kind:'link.add'|'link.remove',expectedRevision:number|null,structuralRevision:number,selected=key(),commandId='c_link001') {
 const p=parseCommandEnvelope({contractVersion:2,actor:'user',commandId,commands:[{kind,from:selected.from,to:selected.to,linkType:selected.linkType,expectedRevision,expectedStructuralRevision:structuralRevision}]});if(!p.ok)throw new Error(JSON.stringify(p.error));return p.value;
}
async function setup(mode:'fresh'|'upgrade'='fresh') {
 const fixture=sqliteD1(mode);const db=new DB(fixture.d1);
 for(const id of ['t_first1','t_second','t_third1'])fixture.sql.prepare("INSERT INTO tasks(id,title,status,created_at,updated_at) VALUES(?,?,'pending','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')").run(id,id);
 return {...fixture,db};
}
describe.each(['fresh','upgrade'] as const)('reliable links (%s)',mode=>{
 it.each(['blocks','related'])('previews/adds/removes/revives %s with exact versioned history',async type=>{
  const {sql,db,batches}=await setup(mode);
  try{
   const selected=key('t_first1','t_second',type);const before=await db.getLinkSnapshot(selected);expect(parseLinkSnapshot(before).ok).toBe(true);expect(before).toMatchObject({row:null,version:null,structuralRevision:3});
   const envelope=input('link.add',null,3,selected);const preview=await db.previewChanges(envelope);expect(parseChangesPreview(preview).ok).toBe(true);expect(preview.requiredStatements).toBe(type==='blocks'?9:8);expect(batches).toEqual([]);expect(await db.getLinkSnapshot(selected)).toEqual(before);
   const created=await db.applyChanges(envelope);expect(parseChangesResult(created).ok).toBe(true);expect(created).toMatchObject({changes:[{entity:'link',id:entityStorageKey(selected),before:null,after:{revision:1,row:{from_task_id:selected.from,to_task_id:selected.to,link_type:type}}}],refs:{}});
   const live=await db.getLinkSnapshot(selected);expect(live).toMatchObject({version:{revision:1,deletedAt:null},structuralRevision:4});
   const removed=await db.applyChanges(input('link.remove',1,4,selected,'c_remove1'));expect(parseChangesResult(removed).ok).toBe(true);expect(removed).toMatchObject({changes:[{before:{revision:1,row:live.row},after:{revision:2,deleted:true}}]});
   const deleted=await db.getLinkSnapshot(selected);expect(deleted).toMatchObject({row:null,version:{revision:2},structuralRevision:5});expect(deleted.version!.deletedAt).not.toBeNull();
   const revived=await db.applyChanges(input('link.add',2,5,selected,'c_revive1'));expect(parseChangesResult(revived).ok).toBe(true);expect(revived).toMatchObject({changes:[{before:{row:null,revision:2},after:{revision:3}}]});
   expect(sql.prepare('SELECT operation,revision FROM change_feed ORDER BY seq').all()).toEqual([{operation:'upsert',revision:1},{operation:'delete',revision:2},{operation:'upsert',revision:3}]);expect(sql.prepare('SELECT COUNT(*) AS n FROM command_audit').get()).toMatchObject({n:3});
  }finally{sql.close();}
 });
});
it.each([false,true])('uses a single revision increment with recursive_triggers=%s',async recursive=>{
 const {sql,db}=await setup();try{sql.exec(`PRAGMA recursive_triggers=${recursive?'ON':'OFF'}`);const selected=key();await db.applyChanges(input('link.add',null,3));await db.applyChanges(input('link.remove',1,4,selected,'c_delete1'));await db.applyChanges(input('link.add',2,5,selected,'c_again01'));expect((await db.getLinkSnapshot(selected)).version?.revision).toBe(3);}finally{sql.close();}
});
it('rejects cycles in side-effect-free preview and apply',async()=>{
 const {sql,db,batches}=await setup();try{
  await db.linkTasks('t_first1','t_second','blocks');await db.linkTasks('t_second','t_third1','blocks');batches.length=0;
  const selected=key('t_third1','t_first1');const current=await db.getLinkSnapshot(selected);const envelope=input('link.add',null,current.structuralRevision,selected);
  await expect(db.previewChanges(envelope)).rejects.toMatchObject({detail:{code:'graph_cycle',retryable:false}});await expect(db.applyChanges(envelope)).rejects.toMatchObject({detail:{code:'graph_cycle'}});expect(batches).toEqual([]);expect(await db.listAllLinks()).toHaveLength(2);
 }finally{sql.close();}
});
it('preserves legacy reverse related identities and avoids duplicate new edges',async()=>{
 const {sql,db}=await setup();try{
  const reversed=key('t_second','t_first1','related');await db.linkTasks(reversed.from,reversed.to,'related');const current=await db.getLinkSnapshot(reversed);expect(current.row).not.toBeNull();
  await expect(db.applyChanges(input('link.add',null,current.structuralRevision,key('t_first1','t_second','related')))).rejects.toMatchObject({detail:{code:'invalid_transition',currentLink:current}});
  await db.applyChanges(input('link.remove',1,current.structuralRevision,reversed));const canonical=await db.getLinkSnapshot(key('t_first1','t_second','related'));await db.applyChanges(input('link.add',null,canonical.structuralRevision,canonical.key,'c_canonical'));
  expect(await db.listAllLinks()).toEqual([{from_task_id:'t_first1',to_task_id:'t_second',link_type:'related'}]);expect((await db.getLinkSnapshot(reversed)).version?.deletedAt).not.toBeNull();
 }finally{sql.close();}
});
it.each(['add','remove'])('returns original %s after lost response, later writes and endpoint deletion',async action=>{
 const {sql,db,hooks}=await setup();try{
  if(action==='remove')await db.linkTasks('t_first1','t_second','blocks');const before=await db.getLinkSnapshot(key());const envelope=input(action==='add'?'link.add':'link.remove',before.version?.revision??null,before.structuralRevision);
  hooks.loseResponse=true;const first=await db.applyChanges(envelope);await db.deleteTask('t_second');expect(await db.applyChanges(envelope)).toEqual(first);expect(sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toMatchObject({n:1});await expect(db.applyChanges({...envelope,reason:'Changed'})).rejects.toMatchObject({detail:{code:'command_id_conflict'}});
 }finally{sql.close();}
});
it.each(['edge','endpoint','phantom','cycle','identical'])('guards add race (%s) without a partial receipt',async race=>{
 const {sql,db,hooks}=await setup();try{
  const envelope=input('link.add',null,3);let winner:unknown;hooks.beforeBatch=async()=>{
   if(race==='edge')await db.linkTasks('t_first1','t_second','blocks');else if(race==='endpoint')await db.deleteTask('t_second');else if(race==='phantom')await db.addTask({title:'Unrelated'});else if(race==='cycle')await db.linkTasks('t_second','t_first1','blocks');else winner=await db.applyChanges(envelope);
  };
  if(race==='identical')expect(await db.applyChanges(envelope)).toEqual(winner);else{await expect(db.applyChanges(envelope)).rejects.toMatchObject({detail:{code:race==='edge'?'revision_conflict':'structural_conflict'}});for(const table of ['command_receipts','command_audit','change_feed'])expect(sql.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);}
 }finally{sql.close();}
});
it.each(['delete','identical'])('guards remove race (%s)',async race=>{
 const {sql,db,hooks}=await setup();try{
  await db.linkTasks('t_first1','t_second','blocks');const envelope=input('link.remove',1,4);let winner:unknown;hooks.beforeBatch=async()=>{if(race==='delete')await db.unlinkTasks('t_first1','t_second','blocks');else winner=await db.applyChanges(envelope);};
  if(race==='identical')expect(await db.applyChanges(envelope)).toEqual(winner);else{await expect(db.applyChanges(envelope)).rejects.toMatchObject({detail:{code:'revision_conflict',currentLink:{row:null,version:{revision:2}}}});expect(sql.prepare('SELECT * FROM command_receipts').all()).toEqual([]);}
 }finally{sql.close();}
});
it.each([7,8])('rolls back link, ledger, structural counter and history after late failure %s',async failAfter=>{
 const {sql,db,hooks}=await setup();try{const before=await db.getLinkSnapshot(key());hooks.failAfter=failAfter;await expect(db.applyChanges(input('link.add',null,3))).rejects.toMatchObject({detail:{code:'storage_unavailable'}});expect(await db.getLinkSnapshot(key())).toEqual(before);for(const table of ['command_receipts','command_audit','change_feed'])expect(sql.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);}finally{sql.close();}
});
it('rejects live-add and missing-remove as durable invalid transitions',async()=>{
 const {sql,db}=await setup();try{await db.applyChanges(input('link.add',null,3));await expect(db.applyChanges(input('link.add',1,4,key(),'c_exists1'))).rejects.toMatchObject({detail:{code:'invalid_transition'}});await db.applyChanges(input('link.remove',1,4,key(),'c_remove1'));await expect(db.applyChanges(input('link.remove',2,5,key(),'c_missing1'))).rejects.toMatchObject({detail:{code:'invalid_transition'}});}finally{sql.close();}
});
it.each(['entity','workspace'])('rejects %s exhaustion before writes',async kind=>{
 const {sql,db}=await setup();try{await db.linkTasks('t_first1','t_second','blocks');if(kind==='entity')sql.exec("UPDATE entity_versions SET revision=9007199254740991 WHERE entity='link'");else sql.exec('UPDATE workspace_versions SET structural_revision=9007199254740991');const before=await db.getLinkSnapshot(key());await expect(db.applyChanges(input('link.remove',before.version!.revision,before.structuralRevision))).rejects.toMatchObject({detail:{code:'revision_exhausted',retryable:false}});expect(await db.getLinkSnapshot(key())).toEqual(before);}finally{sql.close();}
});
it('shares coherent link reads, mutations and parsed conflicts over REST/MCP',async()=>{
 const {sql,db,d1}=await setup();try{
  const read=new Request('https://test/api/v2/link',{method:'POST',body:JSON.stringify(key())});const response=await handleApiRequest(read,new URL(read.url),db);expect(parseLinkSnapshot(await response.json()).ok).toBe(true);
  const envelope=input('link.add',null,3);const write=new Request('https://test/api/v2/changes',{method:'POST',body:JSON.stringify(envelope)});const result=await(await handleApiRequest(write,new URL(write.url),db)).json();expect(parseChangesResult(result).ok).toBe(true);
  const rpc=new Request('https://test/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'apply_changes',arguments:envelope}})});expect(await(await handleMcpRequest(rpc,db,{DB:d1,AUTH_TOKEN:'test'})).json()).toMatchObject({result:{structuredContent:result}});
  const stale=new Request('https://test/api/v2/changes',{method:'POST',body:JSON.stringify({...envelope,commandId:'c_stale001'})});const failed=await handleApiRequest(stale,new URL(stale.url),db);expect(failed.status).toBe(409);const error=await failed.json();expect(parseFoundationErrorEnvelope(error).ok).toBe(true);expect(error).toMatchObject({error:{currentLink:{version:{revision:1}}}});
 }finally{sql.close();}
});
it.each([{from:'t_first1',to:'t_first1'},{from:'t_second',to:'t_first1',linkType:'related'},{expectedStructuralRevision:undefined},{clientRef:'edge'}])('rejects malformed/self/reversed additions',patch=>{
 expect(parseCommandEnvelope({contractVersion:2,commandId:'c_link001',actor:'user',commands:[{kind:'link.add',from:'t_first1',to:'t_second',linkType:'blocks',expectedRevision:null,expectedStructuralRevision:1,...patch}]}).ok).toBe(false);
});
it.each([false,true])('migration 013 preserves feed allocator with history removed=%s',removed=>{
 const sql=new DatabaseSync(':memory:');try{
  const dir=fileURLToPath(new URL('../migrations',import.meta.url));for(const name of readdirSync(dir).filter(name=>name.endsWith('.sql')&&name<'013').sort())sql.exec(readFileSync(`${dir}/${name}`,'utf8'));
  sql.exec("INSERT INTO command_receipts VALUES('c_before1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{}','2026-10-01T00:00:00Z'); INSERT INTO change_feed(seq,command_id,entity,entity_id,revision,operation,payload_json,created_at) VALUES(42,'c_before1','task','t_first1',1,'upsert','{}','2026-10-01T00:00:00Z')");if(removed)sql.exec('DELETE FROM change_feed');sql.exec(readFileSync(`${dir}/013_link_commands.sql`,'utf8'));
  sql.exec("INSERT INTO change_feed(command_id,entity,entity_id,revision,operation,payload_json,created_at) VALUES('c_before1','link','[\"t_first1\",\"t_second\",\"blocks\"]',2,'delete','{}','2026-10-01T00:00:00Z')");expect(sql.prepare('SELECT MAX(seq) AS n FROM change_feed').get()).toMatchObject({n:43});expect(sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toMatchObject({n:1});
 }finally{sql.close();}
});
it.each(['fresh','upgrade'] as const)('enforces feed link tuple/operation constraints (%s)',mode=>{
 const {sql}=sqliteD1(mode);try{
  sql.prepare('INSERT INTO command_receipts VALUES(?,?,?,?)').run('c_tuple01','a'.repeat(64),'{}','2026-10-01T00:00:00Z');
  const insert=sql.prepare("INSERT INTO change_feed(command_id,entity,entity_id,revision,operation,payload_json,created_at) VALUES('c_tuple01','link',?,1,?,'{}','2026-10-01T00:00:00Z')");
  for(const malformed of ['bad','{}','[]','["t_first1","t_second"]','["t_first1","t_second",null]','[null,"t_second","blocks"]','["t_first1",1,"blocks"]','["t_first1","t_second","other"]','["t_first1","t_second","blocks",0]'])expect(()=>insert.run(malformed,'upsert')).toThrow();
  expect(()=>insert.run(entityStorageKey(key()),'other')).toThrow();insert.run(entityStorageKey(key()),'delete');
 }finally{sql.close();}
});
