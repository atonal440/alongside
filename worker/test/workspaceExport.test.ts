import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { sqliteD1 } from './helpers/sqliteD1';
import { parseCommandEnvelope } from '@shared/wire/commands';
import { parseWorkspaceExport } from '@shared/wire/workspaceExport';
import { workspaceExport } from '../src/domain/workspaceExport';
import { handleApiRequest } from '../src/api';
import { handleMcpRequest } from '../src/mcp';
const now='2026-10-01T10:00:00Z';

describe.each(['fresh','upgrade'] as const)('portable workspace export (%s)',mode=>{
 it('exports every current user-data family and historical values from one read without writes',async()=>{
  const {sql,d1,reads,batches}=sqliteD1(mode);const db=new DB(d1);
  try {
   const command=parseCommandEnvelope({contractVersion:2,commandId:'c_export1',actor:'user',commands:[{kind:'task.create',id:'t_first1',expectedRevision:null,expectedStructuralRevision:0,values:{title:'Exported',notes:'Notes',kickoffNote:null,taskType:'action',project:null}}]});if(!command.ok)throw new Error();await db.applyChanges(command.value);
   sql.exec(`INSERT INTO projects(id,title,created_at,updated_at) VALUES('p_first1','Project','${now}','${now}');
    INSERT INTO duties(id,title,rrule,dtstart,project_id,created_at,updated_at) VALUES('d_first1','Duty','FREQ=DAILY','${now}','p_first1','${now}','${now}');
    UPDATE tasks SET project_id='p_first1',duty_id='d_first1',occurrence_at='${now}' WHERE id='t_first1';
    INSERT INTO tasks(id,title,created_at,updated_at) VALUES('t_other1','Other','${now}','${now}');
    INSERT INTO task_links VALUES('t_first1','t_other1','blocks');
    INSERT INTO tasks(id,title,created_at,updated_at) VALUES('t_deleted','Deleted','${now}','${now}'); DELETE FROM tasks WHERE id='t_deleted';
    INSERT INTO user_preferences VALUES('sort_by','manual');
    INSERT INTO action_log(tool_name,task_id,title,created_at) VALUES('snooze_task','t_deleted','Historical log','${now}');
    INSERT INTO planning_settings VALUES(1,'UTC',15,1,'${now}','${now}'); INSERT INTO planning_working_hours VALUES(1,1,'09:00','17:00');
    INSERT INTO oauth_codes VALUES('private-code','client','https://example.org','private-secret',123);`);
   const before=sql.prepare('SELECT * FROM sync_metadata').get();const beforeReads=reads();const beforeBatches=[...batches];
   const exported=await db.exportWorkspace();expect(reads()-beforeReads).toBe(1);expect(batches).toEqual(beforeBatches);expect(sql.prepare('SELECT * FROM sync_metadata').get()).toEqual(before);
   expect(parseWorkspaceExport(exported).ok).toBe(true);expect(exported).toMatchObject({version:2,exported_at:expect.any(String),tasks:[{id:'t_first1',title:'Exported',duty_id:'d_first1'},{id:'t_other1'}],projects:[{id:'p_first1'}],links:[{from_task_id:'t_first1',to_task_id:'t_other1'}],duties:[{id:'d_first1'}],preferences:[{key:'sort_by',value:'manual'}],action_log:[{tool_name:'snooze_task',task_id:'t_deleted'}],command_audit:[{command_id:'c_export1'}],planning_settings:{timezone:'UTC',bufferMinutes:15,workingHours:[{weekday:1,start:'09:00',end:'17:00'}]}});
   expect(Object.keys(exported).sort()).toEqual(['version','exported_at','tasks','projects','links','duties','preferences','action_log','command_audit','planning_settings'].sort());
   expect(Object.keys(exported.planning_settings!).sort()).toEqual(['timezone','bufferMinutes','workingHours'].sort());
   expect(JSON.stringify(exported)).not.toMatch(/private-code|private-secret|payload_hash|result_json|deletedAt|structuralRevision|retention_floor/);
   // The pure formatter retains portable timestamps and never emits tombstones.
   const expected=workspaceExport(await db.getWorkspaceSnapshot(),now);expect(expected.exported_at).toBe('2026-10-01T10:00:00.000Z');expect(expected.tasks).toHaveLength(2);
  }finally{sql.close();}
 });
 it('returns an explicit empty portable document while legacy v1 export remains available',async()=>{
  const {sql,d1}=sqliteD1(mode);const db=new DB(d1);
  try {
   const exported=await db.exportWorkspace();expect(exported).toMatchObject({version:2,tasks:[],projects:[],links:[],duties:[],preferences:[],planning_settings:null,action_log:[],command_audit:[]});
   expect(await db.exportAll()).toMatchObject({version:1,tasks:[],projects:[],links:[],preferences:{}});
  }finally{sql.close();}
 });
});
it('exposes the portable export through REST and the admin MCP endpoint with strict empty input and equivalent content',async()=>{
 const {sql,d1}=sqliteD1();const db=new DB(d1);
 try {
  sql.exec(`INSERT INTO tasks(id,title,created_at,updated_at) VALUES('t_first1','Exported','${now}','${now}')`);
  const request=new Request('https://x/api/v2/export');const response=await handleApiRequest(request,new URL(request.url),db);expect(response.status).toBe(200);const rest=await response.json() as Record<string,unknown>;
  const rpc=async(args:unknown)=>{const request=new Request('https://x/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'export_workspace',arguments:args}})});return(await handleMcpRequest(request,db,{DB:d1,AUTH_TOKEN:'tok'},'admin')).json() as Promise<{result:{structuredContent:Record<string,unknown>,isError?:boolean}}>};
  const mcp=(await rpc({})).result.structuredContent;const {exported_at:_restTime,...restData}=rest;const {exported_at:_mcpTime,...mcpData}=mcp;expect(mcpData).toEqual(restData);expect(parseWorkspaceExport(mcp).ok).toBe(true);
  expect((await rpc({includeCredentials:true})).result.isError).toBe(true);
  const bad=new Request('https://x/api/v2/export?includeCredentials=true');expect((await handleApiRequest(bad,new URL(bad.url),db)).status).toBe(400);
 }finally{sql.close();}
});
