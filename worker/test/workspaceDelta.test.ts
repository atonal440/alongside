import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { sqliteD1 } from './helpers/sqliteD1';
import { parseWorkspaceDelta, parseWorkspaceDeltaInput, type WorkspaceDeltaInput } from '@shared/wire/sync';
import { parseFoundationErrorEnvelope } from '@shared/wire/planning';
import { handleApiRequest } from '../src/api';
const now='2026-10-01T10:00:00Z';
const insert=(id='t_first1')=>`INSERT INTO tasks(id,title,created_at,updated_at) VALUES('${id}','Initial','${now}','${now}')`;
function input(raw:unknown):WorkspaceDeltaInput {const parsed=parseWorkspaceDeltaInput(raw);if(!parsed.ok)throw new Error(JSON.stringify(parsed.error));return parsed.value;}

describe.each(['fresh','upgrade'] as const)('fixed-watermark delta (%s)',mode=>{
 it('paginates historical images against one fixed watermark while mid-pull writes wait',async()=>{
  const {sql,d1,reads}=sqliteD1(mode);const db=new DB(d1);
  try {
   sql.exec(insert());const bootstrap=await db.getWorkspaceSnapshot();
   sql.exec("UPDATE tasks SET title='First'; UPDATE tasks SET title='Second'; INSERT INTO user_preferences VALUES('sort_by','due')");
   const before=reads();const first=await db.getWorkspaceDelta(input({cursor:bootstrap.cursor,limit:1}));expect(reads()-before).toBe(1);
   expect(first).toMatchObject({from:bootstrap.cursor,cursor:{epoch:0,sequence:2},watermark:{epoch:0,sequence:4},hasMore:true,changes:[{sequence:2,entity:{revision:2,row:{title:'First'}}}]});
   sql.exec("UPDATE tasks SET title='Mid-pull'; INSERT INTO user_preferences VALUES('planning_prompt','always')");
   const second=await db.getWorkspaceDelta(input({cursor:first.cursor,watermark:first.watermark,limit:1}));
   expect(second.watermark).toEqual(first.watermark);expect(second.changes[0]!.entity.row).toMatchObject({title:'Second'});expect(second.hasMore).toBe(true);
   const final=await db.getWorkspaceDelta(input({cursor:second.cursor,watermark:first.watermark,limit:1}));
   expect(final).toMatchObject({cursor:first.watermark,watermark:first.watermark,hasMore:false,changes:[{sequence:4,entity:{entity:'preference'}}]});
   const next=await db.getWorkspaceDelta(input({cursor:final.cursor}));
   expect(next).toMatchObject({hasMore:false,watermark:{epoch:0,sequence:6},changes:[{sequence:5,entity:{row:{title:'Mid-pull'}}},{sequence:6,entity:{entity:'preference'}}]});
   for(const page of [first,second,final,next])expect(parseWorkspaceDelta(page).ok).toBe(true);
  }finally{sql.close();}
 });
 it('returns empty/equal cursor pages, deletion images and no post-watermark resurrection',async()=>{
  const {sql,d1}=sqliteD1(mode);const db=new DB(d1);
  try {
   const empty=await db.getWorkspaceSnapshot();expect(await db.getWorkspaceDelta(input({cursor:empty.cursor}))).toEqual({contractVersion:2,from:empty.cursor,cursor:empty.cursor,watermark:empty.cursor,hasMore:false,changes:[]});
   sql.exec(`${insert()};${insert('t_other1')};INSERT INTO task_links VALUES('t_first1','t_other1','blocks')`);
   const bootstrap=await db.getWorkspaceSnapshot();sql.exec("DELETE FROM tasks WHERE id='t_first1'");
   const first=await db.getWorkspaceDelta(input({cursor:bootstrap.cursor,limit:1}));
   expect(first.changes[0]!.entity).toMatchObject({entity:'link',row:null,deletedAt:expect.any(String)});
   sql.exec(insert());
   const second=await db.getWorkspaceDelta(input({cursor:first.cursor,watermark:first.watermark,limit:1}));
   expect(second.changes[0]!.entity).toMatchObject({entity:'task',row:null,revision:2});expect(second.hasMore).toBe(false);
   const next=await db.getWorkspaceDelta(input({cursor:second.cursor}));expect(next.changes[0]!.entity).toMatchObject({entity:'task',revision:3,row:{title:'Initial'}});
  }finally{sql.close();}
 });
 it.each(['epoch_changed','history_expired','cursor_ahead','watermark_ahead'])('returns explicit %s reset diagnostics without writes',async reason=>{
  const {sql,d1}=sqliteD1(mode);const db=new DB(d1);
  try {
   sql.exec(`${insert()}; UPDATE tasks SET title='New'`);
   const supplied=input({cursor:{epoch:reason==='epoch_changed'?1:0,sequence:reason==='cursor_ahead'?3:0},...(reason==='watermark_ahead'?{watermark:{epoch:0,sequence:3}}:{})});
   if(reason==='history_expired')sql.exec('DELETE FROM sync_feed WHERE seq=1');
   const before=sql.prepare('SELECT * FROM sync_metadata').all();
   let failure:unknown;try{await db.getWorkspaceDelta(supplied);}catch(error){failure=error;}
   expect(failure).toMatchObject({status:409,detail:{code:'sync_reset_required',retryable:false,syncReset:{reason,currentCursor:{epoch:0,sequence:2},retentionFloor:reason==='history_expired'?1:0}}});
   const detail=(failure as {detail:unknown}).detail;expect(parseFoundationErrorEnvelope({contractVersion:2,error:detail}).ok).toBe(true);
   expect(sql.prepare('SELECT * FROM sync_metadata').all()).toEqual(before);
  }finally{sql.close();}
 });
 it('resets an in-flight continuation when retention or restore epoch changes',async()=>{
  const {sql,d1}=sqliteD1(mode);const db=new DB(d1);
  try {
   sql.exec(`${insert()};UPDATE tasks SET title='Second';UPDATE tasks SET title='Third'`);
   const first=await db.getWorkspaceDelta(input({cursor:{epoch:0,sequence:0},limit:1}));
   sql.exec('DELETE FROM sync_feed WHERE seq=2');
   await expect(db.getWorkspaceDelta(input({cursor:first.cursor,watermark:first.watermark}))).rejects.toMatchObject({detail:{syncReset:{reason:'history_expired'}}});
   const restored=await db.getWorkspaceSnapshot();sql.exec('UPDATE sync_metadata SET epoch=epoch+1');
   await expect(db.getWorkspaceDelta(input({cursor:restored.cursor}))).rejects.toMatchObject({detail:{syncReset:{reason:'epoch_changed'}}});
   const fresh=await db.getWorkspaceSnapshot();sql.exec("UPDATE tasks SET title='After restore'");
   expect((await db.getWorkspaceDelta(input({cursor:fresh.cursor}))).changes).toMatchObject([{entity:{row:{title:'After restore'}}}]);
  }finally{sql.close();}
 });
 it('accepts a cursor at the retention floor and skips allocator gaps safely',async()=>{
  const {sql,d1}=sqliteD1(mode);const db=new DB(d1);
  try {
   sql.exec(`${insert()}; UPDATE tasks SET title='New'; DELETE FROM sync_feed WHERE seq=1; UPDATE sqlite_sequence SET seq=8 WHERE name='sync_feed'; UPDATE tasks SET title='After gap'`);
   const page=await db.getWorkspaceDelta(input({cursor:{epoch:0,sequence:1},limit:1}));expect(page.hasMore).toBe(true);expect(page.cursor.sequence).toBe(2);
   const last=await db.getWorkspaceDelta(input({cursor:page.cursor,watermark:page.watermark}));expect(last.cursor.sequence).toBe(9);expect(last.changes.map(row=>row.sequence)).toEqual([9]);
  }finally{sql.close();}
 });
});
it('returns large pages as separate D1 rows instead of one aggregated value',async()=>{
 const {sql,d1}=sqliteD1();
 try {
  const insert=sql.prepare('INSERT INTO tasks(id,title,notes,created_at,updated_at) VALUES(?,?,?,?,?)');
  for(let i=0;i<250;i++)insert.run(`t_large_${String(i).padStart(5,'0')}`,'Notes','n'.repeat(10_000),now,now);
  let rows=0;const bounded={prepare(query:string){const statement=d1.prepare(query);return{bind(...args:unknown[]){statement.bind(...args);return this;},async all(){const result=await statement.all();rows=result.results.length;for(const row of result.results)expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(2_000_000);return result;},first(){throw new Error('Do not aggregate delta pages into a D1 value.');}};}} as unknown as D1Database;
  const page=await new DB(bounded).getWorkspaceDelta(input({cursor:{epoch:0,sequence:0},limit:500}));
  expect(rows).toBe(250);expect(page.changes).toHaveLength(250);expect(page.hasMore).toBe(false);expect(Buffer.byteLength(JSON.stringify(page))).toBeGreaterThan(2_000_000);
 }finally{sql.close();}
});
it('keeps REST inputs, pagination and reset errors strict',async()=>{
 const {sql,d1}=sqliteD1();const db=new DB(d1);
 try {
  sql.exec(insert());const args={cursor:{epoch:0,sequence:0},limit:1};const expected=await db.getWorkspaceDelta(input(args));
  const restCall=async(body:unknown)=>{const request=new Request('https://x/api/v2/sync/delta',{method:'POST',body:JSON.stringify(body)});return handleApiRequest(request,new URL(request.url),db);};
  const rest=await restCall(args);expect(rest.status).toBe(200);expect(await rest.json()).toEqual(expected);
  for(const body of [{cursor:{epoch:0,sequence:-1}},{cursor:args.cursor,limit:0},{cursor:args.cursor,limit:501},{cursor:args.cursor,watermark:{epoch:1,sequence:1}},{cursor:{epoch:0,sequence:1},watermark:args.cursor},{cursor:args.cursor,extra:true}]) {
   expect((await restCall(body)).status).toBe(400);
  }
  const stale={cursor:{epoch:1,sequence:0}};const reset=await restCall(stale);expect(reset.status).toBe(409);const error=await reset.json();expect(parseFoundationErrorEnvelope(error).ok).toBe(true);
 }finally{sql.close();}
});

it('reconciles all current and retained legacy families from staged pages into the matching snapshot',async()=>{
 const {sql,d1}=sqliteD1();const db=new DB(d1);
 try {
  const bootstrap=await db.getWorkspaceSnapshot();
  sql.exec(`INSERT INTO projects(id,title,created_at,updated_at) VALUES('p_first1','Project','${now}','${now}');
   ${insert()};${insert('t_other1')};UPDATE tasks SET project_id='p_first1' WHERE id='t_first1';
   INSERT INTO task_links VALUES('t_first1','t_other1','related');
   INSERT INTO duties(id,title,rrule,dtstart,created_at,updated_at) VALUES('d_first1','Duty','FREQ=DAILY','${now}','${now}','${now}');
   INSERT INTO user_preferences VALUES('sort_by','manual');
   INSERT INTO action_log(tool_name,task_id,title,created_at) VALUES('snooze_task','t_deleted','Historical snooze','${now}');
   INSERT INTO planning_settings VALUES(1,'UTC',0,1,'${now}','${now}');
   INSERT INTO planning_working_hours VALUES(1,1,'09:00','17:00');`);
  // Include reliable provenance as well as the legacy sources.
  const {parseCommandEnvelope}=await import('@shared/wire/commands');
  const command=parseCommandEnvelope({contractVersion:2,commandId:'c_delta001',actor:'user',commands:[{kind:'task.type.set',id:'t_first1',expectedRevision:2,taskType:'plan'}]});if(!command.ok)throw new Error();await db.applyChanges(command.value);
  let page=await db.getWorkspaceDelta(input({cursor:bootstrap.cursor,limit:3}));const staged=new Map<string,unknown>();
  for(;;){for(const change of page.changes)staged.set(`${change.entity.entity}:${change.entity.key}`,change.entity);if(!page.hasMore)break;page=await db.getWorkspaceDelta(input({cursor:page.cursor,watermark:page.watermark,limit:3}));}
  const snapshot=await db.getWorkspaceSnapshot();expect(page.cursor).toEqual(snapshot.cursor);
  expect([...staged].sort(([a],[b])=>a.localeCompare(b)).map(([,row])=>row)).toEqual([...snapshot.entities].sort((a,b)=>`${a.entity}:${a.key}`.localeCompare(`${b.entity}:${b.key}`)));
 }finally{sql.close();}
});
