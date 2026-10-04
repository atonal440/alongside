import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { sqliteD1 } from './helpers/sqliteD1';
import { parseCommandEnvelope } from '@shared/wire/commands';
import { parseWorkspaceSnapshot, SyncEntitySchema } from '@shared/wire/sync';
import { parseSchema } from '@shared/parse';
import { handleApiRequest } from '../src/api';
import { handleMcpRequest } from '../src/mcp';
import { COMMAND_TOOLS } from '../src/commands';
const now='2026-10-01T10:00:00Z';
const taskInsert=(id='t_first1')=>`INSERT INTO tasks(id,title,due_all_day,created_at,updated_at) VALUES('${id}','Original',1,'${now}','${now}')`;
const projectInsert=`INSERT INTO projects(id,title,created_at,updated_at) VALUES('p_first1','Project','${now}','${now}')`;
const settingsInsert=`INSERT INTO planning_settings VALUES(1,'UTC',15,1,'${now}','${now}')`;
function envelope(id='c_first1') {
 const parsed=parseCommandEnvelope({contractVersion:2,commandId:id,actor:'user',commands:[{kind:'task.create',id:'t_first1',expectedRevision:null,expectedStructuralRevision:0,values:{title:'Reliable',notes:null,kickoffNote:null,taskType:'action',project:null}}]});
 if(!parsed.ok)throw new Error();return parsed.value;
}
function feed(sql:DatabaseSync) {
 return sql.prepare('SELECT * FROM sync_feed ORDER BY seq').all().map(row=>({...row,row:JSON.parse(row.row_json as string)}));
}
function metadata(sql:DatabaseSync) {return sql.prepare('SELECT * FROM sync_metadata').get();}
function seed(sql:DatabaseSync) {
 sql.exec(`${projectInsert}; ${taskInsert()}; ${taskInsert('t_other1')};
 UPDATE tasks SET project_id='p_first1' WHERE id='t_first1';
 INSERT INTO task_links VALUES('t_first1','t_other1','blocks');
 INSERT INTO duties(id,title,rrule,dtstart,project_id,created_at,updated_at) VALUES('d_first1','Duty','FREQ=DAILY','${now}','p_first1','${now}','${now}');
 INSERT INTO user_preferences VALUES('sort_by','readiness');
 INSERT INTO action_log(tool_name,task_id,title,created_at) VALUES('add_task','t_first1','Created','${now}');
 ${settingsInsert}; INSERT INTO planning_working_hours VALUES(1,1,'09:00','17:00');`);
}

describe.each(['fresh','upgrade'] as const)('all-writer workspace sync (%s)',mode=>{
 it('captures every current user-data family and reads rows/revisions/cursor with one query',async()=>{
  const {sql,d1,reads}=sqliteD1(mode);const db=new DB(d1);
  try {
   const reliable=await db.applyChanges(envelope());
   // A command emits the same row event as a legacy writer, plus provenance.
   expect(feed(sql).map(row=>row.entity)).toEqual(['task','command_audit']);
   expect(await db.applyChanges(envelope())).toEqual(reliable);
   expect(feed(sql)).toHaveLength(2);
   sql.exec("DELETE FROM tasks");seed(sql);
   const before=reads();const snapshot=await db.getWorkspaceSnapshot();expect(reads()-before).toBe(1);
   expect(parseWorkspaceSnapshot(snapshot).ok).toBe(true);
   expect(snapshot.cursor).toEqual({epoch:0,sequence:feed(sql).at(-1)!.seq});
   expect(new Set(snapshot.entities.map(row=>row.entity))).toEqual(new Set(['task','project','link','duty','preference','planning_settings','action_log','command_audit']));
   for(const image of feed(sql)) {
    const parsed=parseSchema(SyncEntitySchema,{entity:image.entity,key:image.entity_key,revision:image.revision,deletedAt:image.deleted_at,row:image.row});
    expect(parsed.ok,JSON.stringify(image)).toBe(true);
   }
   for(const entity of snapshot.entities) {
    const last=feed(sql).filter(row=>row.entity===entity.entity&&row.entity_key===entity.key).at(-1)!;
    const parsed=parseSchema(SyncEntitySchema,{entity:last.entity,key:last.entity_key,revision:last.revision,deletedAt:last.deleted_at,row:last.row});
    expect(parsed.ok&&parsed.value).toEqual(entity);
   }
   expect(snapshot.entities.find(row=>row.entity==='task'&&row.key==='t_first1')).toMatchObject({revision:4,row:{due_all_day:true}});
   expect(snapshot.entities.find(row=>row.entity==='planning_settings')).toMatchObject({revision:2,row:{revision:1,working_hours:[{weekday:1,start_time:'09:00',end_time:'17:00'}]}});
  }finally{sql.close();}
 });
 it('records no-op edits, FK link cascades and retained delete/recreate revisions',async()=>{
  const {sql,d1}=sqliteD1(mode);
  try {
   sql.exec(`${taskInsert()};${taskInsert('t_other1')};INSERT INTO task_links VALUES('t_first1','t_other1','related');
    UPDATE tasks SET title=title WHERE id='t_first1'; DELETE FROM tasks WHERE id='t_first1';`);
   const tombstone=await new DB(d1).getWorkspaceSnapshot();
   expect(tombstone.entities.find(row=>row.entity==='task'&&row.key==='t_first1')).toMatchObject({revision:3,row:null,deletedAt:expect.any(String)});
   expect(tombstone.entities.find(row=>row.entity==='link')).toMatchObject({revision:2,row:null});
   sql.exec(taskInsert());
   expect(feed(sql).filter(row=>row.entity==='task'&&row.entity_key==='t_first1').map(row=>[row.revision,row.operation])).toEqual([[1,'upsert'],[2,'upsert'],[3,'delete'],[4,'upsert']]);
   expect((await new DB(d1).getWorkspaceSnapshot()).entities.find(row=>row.entity==='task'&&row.key==='t_first1')).toMatchObject({revision:4,row:{id:'t_first1'}});
  }finally{sql.close();}
 });
 it('captures preference/log/audit replacement and deletion with either recursive-trigger setting',()=>{
  const {sql}=sqliteD1(mode);
  try {
   for(const recursive of ['OFF','ON']) {
    sql.exec(`PRAGMA recursive_triggers=${recursive}; INSERT OR REPLACE INTO user_preferences VALUES('sort_by','due'); INSERT OR REPLACE INTO user_preferences VALUES('sort_by','project');`);
   }
   const previous=sql.prepare("SELECT revision FROM sync_aux_versions WHERE entity='preference'").get()!.revision as number;
   sql.exec("DELETE FROM user_preferences; INSERT INTO user_preferences VALUES('sort_by','readiness')");
   expect(sql.prepare("SELECT revision FROM sync_aux_versions WHERE entity='preference'").get()).toMatchObject({revision:previous+2});
   const last=feed(sql).at(-1)!;expect(last).toMatchObject({entity:'preference',revision:previous+2,row:{key:'sort_by',value:'readiness'}});
  }finally{sql.close();}
 });
 it('projects every working-hours writer, including key edits and parent cascades',async()=>{
  const {sql,d1}=sqliteD1(mode);
  try {
   sql.exec(`${settingsInsert}; INSERT INTO planning_working_hours VALUES(1,1,'09:00','17:00'); UPDATE planning_working_hours SET weekday=2,start_time='10:00';`);
   expect(feed(sql).at(-1)!.row).toMatchObject({working_hours:[{weekday:2,start_time:'10:00',end_time:'17:00'}]});
   sql.exec('DELETE FROM planning_settings');
   const events=feed(sql);expect(events.at(-1)).toMatchObject({entity:'planning_settings',operation:'delete',row:null,revision:5});
   expect((await new DB(d1).getWorkspaceSnapshot()).entities).toEqual([expect.objectContaining({entity:'planning_settings',row:null,revision:5})]);
  }finally{sql.close();}
 });
 it('rolls back source rows, receipt, audit, revisions and feed on late feed failure',async()=>{
  const {sql,d1}=sqliteD1(mode);
  try {
   sql.exec("CREATE TRIGGER fail_audit_feed BEFORE INSERT ON sync_feed WHEN NEW.entity='command_audit' BEGIN SELECT RAISE(ABORT,'Injected feed failure'); END");
   await expect(new DB(d1).applyChanges(envelope())).rejects.toThrow();
   for(const table of ['tasks','command_receipts','command_audit','entity_versions','sync_aux_versions','sync_feed'])expect(sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toMatchObject({n:0});
   expect(metadata(sql)).toMatchObject({watermark:0,retention_floor:0});
   expect(sql.prepare('SELECT structural_revision FROM workspace_versions').get()).toMatchObject({structural_revision:0});
  }finally{sql.close();}
 });
 it.each(['watermark','allocator','auxiliary'])('rejects %s exhaustion even under OR IGNORE',kind=>{
  const {sql}=sqliteD1(mode);
  try {
   sql.exec("INSERT INTO user_preferences VALUES('sort_by','due')");
   if(kind==='watermark')sql.exec('UPDATE sync_metadata SET watermark=9007199254740991');
   if(kind==='allocator')sql.exec("UPDATE sqlite_sequence SET seq=9007199254740991 WHERE name='sync_feed'");
   if(kind==='auxiliary')sql.exec("UPDATE sync_aux_versions SET revision=9007199254740991 WHERE entity='preference'");
   const before=feed(sql);const meta=metadata(sql);
   expect(()=>sql.exec("UPDATE OR IGNORE user_preferences SET value='project'")).toThrow(/exhausted/);
   expect(sql.prepare('SELECT value FROM user_preferences').get()).toMatchObject({value:'due'});
   expect(feed(sql)).toEqual(before);expect(metadata(sql)).toEqual(meta);
  }finally{sql.close();}
 });
 it('keeps watermarks/retention monotonic while purging history and excludes operational credentials',async()=>{
  const {sql,d1}=sqliteD1(mode);
  try {
   sql.exec(`${taskInsert()}; UPDATE tasks SET title='Changed'; DELETE FROM tasks; INSERT INTO oauth_codes VALUES('private-code','client','https://example.org','secret',123);`);
   const retained=sql.prepare('SELECT * FROM entity_versions').all();
   sql.exec('DELETE FROM sync_feed WHERE seq=2');expect(metadata(sql)).toMatchObject({watermark:3,retention_floor:2});
   sql.exec('DELETE FROM sync_feed');expect(metadata(sql)).toMatchObject({watermark:3,retention_floor:3});
   expect(sql.prepare('SELECT * FROM entity_versions').all()).toEqual(retained);
   sql.exec(taskInsert());expect(feed(sql).at(-1)!.seq).toBe(4);
   for(const query of ['UPDATE sync_metadata SET watermark=1','UPDATE sync_metadata SET retention_floor=0','DELETE FROM sync_metadata','INSERT OR REPLACE INTO sync_metadata(id) VALUES(1)'])expect(()=>sql.exec(query)).toThrow();
   const snapshot=await new DB(d1).getWorkspaceSnapshot();expect(JSON.stringify(snapshot)).not.toMatch(/private-code|secret/);
   expect(snapshot.cursor).toEqual({epoch:0,sequence:4});
   expect(()=>sql.exec('UPDATE sync_feed SET row_json=row_json')).toThrow(/immutable/);
  }finally{sql.close();}
 });
 it('fails closed when metadata is missing, and preserves original rows and versions',async()=>{
  const {sql,d1}=sqliteD1(mode);
  try {
   sql.exec('DROP TRIGGER sync_metadata_retained; DELETE FROM sync_metadata');
   expect(()=>sql.exec(taskInsert())).toThrow(/metadata/);
   expect(sql.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toMatchObject({n:0});
   expect(sql.prepare('SELECT COUNT(*) AS n FROM entity_versions').get()).toMatchObject({n:0});
   await expect(new DB(d1).getWorkspaceSnapshot()).rejects.toThrow(/metadata/);
  }finally{sql.close();}
 });
});

it('bootstraps pre-migration rows at zero without rewriting data and preserves state on schema reinstallation',async()=>{
 const sql=new DatabaseSync(':memory:');
 try {
  sql.exec('PRAGMA foreign_keys=ON');const dir=fileURLToPath(new URL('../migrations/',import.meta.url));
  for(const name of readdirSync(dir).filter(name=>name.endsWith('.sql')&&name<'014').sort())sql.exec(readFileSync(`${dir}/${name}`,'utf8'));
  seed(sql);const rows=sql.prepare('SELECT * FROM tasks').all();const versions=sql.prepare('SELECT * FROM entity_versions').all();
  sql.exec(readFileSync(`${dir}/014_workspace_sync.sql`,'utf8'));
  expect(sql.prepare('SELECT * FROM tasks').all()).toEqual(rows);expect(sql.prepare('SELECT * FROM entity_versions').all()).toEqual(versions);
  expect(feed(sql)).toEqual([]);expect(sql.prepare('SELECT revision FROM sync_aux_versions').all()).toEqual([{revision:0},{revision:0},{revision:0}]);
  sql.exec("UPDATE user_preferences SET value='project'");const before=feed(sql);const meta=metadata(sql);
  sql.exec(readFileSync(fileURLToPath(new URL('../schema.sql',import.meta.url)),'utf8'));
  expect(feed(sql)).toEqual(before);expect(metadata(sql)).toEqual(meta);
 }finally{sql.close();}
});
it('exposes the same coherent snapshot through REST and the admin MCP endpoint, with strict empty input',async()=>{
 const {sql,d1}=sqliteD1();const db=new DB(d1);
 try {
  seed(sql);const expected=await db.getWorkspaceSnapshot();
  const rest=await handleApiRequest(new Request('https://x/api/v2/sync/snapshot'),new URL('https://x/api/v2/sync/snapshot'),db);
  expect(rest.status).toBe(200);expect(await rest.json()).toEqual(expected);
  const call=(args:unknown)=>handleMcpRequest(new Request('https://x/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_workspace_snapshot',arguments:args}})}),db,{DB:d1,AUTH_TOKEN:"test"},'admin');
  const mcp=await (await call({})).json() as {result:{content:{text:string}[]}};
  expect(JSON.parse(mcp.result.content[0]!.text)).toEqual(expected);
  const bad=await (await call({limit:1})).json() as {result:{isError:boolean}};expect(bad.result.isError).toBe(true);
  const query=await handleApiRequest(new Request('https://x/api/v2/sync/snapshot?limit=1'),new URL('https://x/api/v2/sync/snapshot?limit=1'),db);
  expect(query.status).toBe(400);expect(COMMAND_TOOLS.find(tool=>tool.name==='get_workspace_snapshot')?.inputSchema).toMatchObject({additionalProperties:false});
 }finally{sql.close();}
});

it('captures legacy Plan transitions and replacement imports without adding preview events',async()=>{
 const {sql,d1}=sqliteD1();const db=new DB(d1);
 try {
  sql.exec(`${projectInsert};${taskInsert()};UPDATE tasks SET project_id='p_first1'`);
  await db.focusTask('t_first1','2026-10-01T11:00:00Z');
  expect(feed(sql).at(-1)!.row).toMatchObject({focused_until:'2026-10-01T11:00:00Z'});
  await db.deleteProject('p_first1');
  expect((await db.getWorkspaceSnapshot()).entities.find(row=>row.entity==='task')).toMatchObject({row:{project_id:null}});
  const exported=await db.exportAll(true);const before=feed(sql);
  await db.importAll(exported,true);expect(feed(sql)).toEqual(before);
  await db.importAll(exported);
  const last=feed(sql).filter(row=>row.entity==='task').at(-1)!;
  expect(last.operation).toBe('upsert');expect(last.revision).toBeGreaterThan(before.filter(row=>row.entity==='task').at(-1)!.revision as number);
  expect((await db.getWorkspaceSnapshot()).entities.find(row=>row.entity==='task')).toMatchObject({revision:last.revision,row:{id:'t_first1'}});
 }finally{sql.close();}
});

it('returns large workspaces as separate bounded D1 rows with matching cursor metadata',async()=>{
 const {sql,d1,reads}=sqliteD1();
 try {
  const notes='n'.repeat(10_000);
  const insert=sql.prepare('INSERT INTO tasks(id,title,notes,created_at,updated_at) VALUES(?,?,?,?,?)');
  for(let i=0;i<250;i++)insert.run(`t_large_${String(i).padStart(5,'0')}`,'Large notes',notes,now,now);
  let rowCount=0;
  const bounded={prepare(query:string) {
   const statement=d1.prepare(query);
   return {async all() {
    const result=await statement.all();rowCount=result.results.length;
    for(const row of result.results)expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(2_000_000);
    return result;
   },first(){throw new Error('Do not aggregate a workspace into one D1 value.');}};
  }} as unknown as D1Database;
  const before=reads();const snapshot=await new DB(bounded).getWorkspaceSnapshot();
  expect(reads()-before).toBe(1);expect(rowCount).toBe(250);
  expect(snapshot.cursor).toEqual({epoch:0,sequence:250});
  expect(snapshot.entities).toHaveLength(250);expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(2_000_000);
 }finally{sql.close();}
});
it('returns a parsed metadata-only bootstrap for an empty workspace',async()=>{
 const {sql,d1}=sqliteD1();
 try {expect(await new DB(d1).getWorkspaceSnapshot()).toEqual({contractVersion:2,cursor:{epoch:0,sequence:0},structuralRevision:0,entities:[]});}
 finally{sql.close();}
});

it('bootstraps previously advertised preferences and retired log names without rewriting provenance',async()=>{
 const sql=new DatabaseSync(':memory:');
 try {
  const dir=fileURLToPath(new URL('../migrations/',import.meta.url));
  for(const name of readdirSync(dir).filter(name=>name.endsWith('.sql')&&name<'014').sort())sql.exec(readFileSync(`${dir}/${name}`,'utf8'));
  sql.exec(`INSERT INTO user_preferences VALUES('sort_by','urgency'),('session_log','manual'),('interruption_style','minimal'),('planning_prompt','manual');
   INSERT INTO action_log(tool_name,task_id,title,created_at) VALUES('snooze_task','t_deleted','Historical snooze','${now}')`);
  const beforePrefs=sql.prepare('SELECT * FROM user_preferences').all();const beforeLog=sql.prepare('SELECT * FROM action_log').all();
  sql.exec(readFileSync(`${dir}/014_workspace_sync.sql`,'utf8'));
  const d1={prepare(query:string){return{async all(){return{success:true,results:sql.prepare(query).all()};}};}} as unknown as D1Database;
  const snapshot=await new DB(d1).getWorkspaceSnapshot();
  expect(snapshot.entities.filter(row=>row.entity==='preference').map(row=>row.row)).toEqual([...beforePrefs].sort((a,b)=>(a.key as string).localeCompare(b.key as string)));
  expect(snapshot.entities.find(row=>row.entity==='action_log')).toMatchObject({revision:0,row:beforeLog[0]});
  expect(sql.prepare('SELECT * FROM user_preferences').all()).toEqual(beforePrefs);expect(sql.prepare('SELECT * FROM action_log').all()).toEqual(beforeLog);
  expect(feed(sql)).toEqual([]);
 }finally{sql.close();}
});
