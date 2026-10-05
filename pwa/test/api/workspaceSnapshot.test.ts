import { expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { parseWorkspaceSnapshot } from '@shared/wire/sync';
const config={apiBase:'http://localhost:8787',authToken:'tok'};
const now='2026-10-01T10:00:00Z';
const task={id:'t_first1',title:'Task',notes:null,kickoff_note:null,status:'pending',task_type:'action',project_id:null,due_date:null,due_all_day:null,recurrence:null,defer_kind:'none',defer_until:null,focused_until:null,session_log:null,duty_id:null,occurrence_at:null,available_from:null,deadline:null,created_at:now,updated_at:now};
const duty={id:'d_first1',title:'Duty',notes:null,kickoff_note:null,task_type:'action',project_id:null,rrule:'FREQ=DAILY',dtstart:now,timezone:null,status:'active',catch_up:'next',last_spawned_at:null,next_occurrence_at:null,created_at:now,updated_at:now};
const image={entity:'task',key:task.id,revision:4,deletedAt:null,row:task};
const body={contractVersion:2,cursor:{epoch:2,sequence:100},structuralRevision:4,entities:[image]};
it('parses snapshot rows, branded cursor and retained tombstones through the PWA boundary',async()=>{
 const raw={...body,entities:[image,{...image,key:'t_deleted',revision:6,deletedAt:'2026-10-01T11:00:00.123Z',row:null}]};
 const parsed=parseWorkspaceSnapshot(raw);if(!parsed.ok)throw new Error();
 const stub=installFetchStub();stub.respondWith({method:'GET',path:'/api/v2/sync/snapshot'},{type:'json',status:200,body:raw});
 try{expect(await api.workspaceSnapshot(config)).toEqual({kind:'ok',value:parsed.value});}finally{stub.restore();}
});
it('accepts all additional current family codecs and historical references',()=>{
 expect(parseWorkspaceSnapshot({...body,entities:[image,
  {entity:'duty',key:duty.id,revision:0,deletedAt:null,row:duty},
  {entity:'preference',key:'sort_by',revision:1,deletedAt:null,row:{key:'sort_by',value:'due'}},
  {entity:'planning_settings',key:'workspace',revision:4,deletedAt:null,row:{id:1,timezone:'UTC',buffer_minutes:15,revision:2,created_at:now,updated_at:now,working_hours:[{weekday:1,start_time:'09:00',end_time:'17:00'}]}},
  {entity:'action_log',key:'3',revision:0,deletedAt:null,row:{id:3,tool_name:'add_task',task_id:'t_deleted',duty_id:null,title:'History',detail:null,created_at:now}},
  {entity:'command_audit',key:'c_first1',revision:1,deletedAt:null,row:{command_id:'c_first1',actor:'user',reason:null,changes_json:'[]',created_at:now}},
 ]}).ok).toBe(true);
});
const malformed=[
 {...body,cursor:{epoch:-1,sequence:100}}, {...body,cursor:{epoch:2,sequence:9007199254740992}},
 {...body,entities:[image,image]}, {...body,entities:[{...image,key:'t_other1'}]},
 {...body,entities:[{...image,revision:1.5}]}, {...body,entities:[{...image,row:null}]},
 {...body,entities:[{...image,deletedAt:now}]}, {...body,entities:[{...image,row:{...task,due_all_day:1}}]},
 {...body,entities:[{...image,row:{...task,project_id:'p_missing'}}]},
 {...body,entities:[{...image,row:{...task,duty_id:'d_missing'}}]},
 {...body,entities:[{entity:'link',key:JSON.stringify([task.id,'t_other1','blocks']),revision:1,deletedAt:null,row:{from_task_id:task.id,to_task_id:'t_other1',link_type:'blocks'}}]},
 {...body,entities:[{entity:'link',key:'["t_first1", "t_other1", "blocks"]',revision:2,deletedAt:now,row:null}]},
 {...body,entities:[{entity:'preference',key:'sort_by',revision:1,deletedAt:null,row:{key:'sort_by',value:'invalid'}}]},
 {...body,entities:[{entity:'preference',key:'sort_by',revision:1,deletedAt:null,row:{key:'planning_prompt',value:'auto'}}]},
 ...[{rrule:'FREQ=SECONDLY'},{dtstart:'2026-10-01'},{timezone:'Invalid/Zone'},{status:'invalid'},{project_id:'p_missing'}].map(patch=>({...body,entities:[{entity:'duty',key:duty.id,revision:1,deletedAt:null,row:{...duty,...patch}}]})),
 {...body,entities:[{entity:'planning_settings',key:'workspace',revision:1,deletedAt:null,row:{id:1,timezone:'UTC',buffer_minutes:0,revision:1,created_at:now,updated_at:now,working_hours:[{weekday:1,start_time:'09:00',end_time:'17:00'},{weekday:1,start_time:'10:00',end_time:'18:00'}]}}]},
 {...body,entities:[{entity:'command_audit',key:'c_first1',revision:1,deletedAt:null,row:{command_id:'c_first1',actor:'user',reason:null,changes_json:'[{"bad":true}]',created_at:now}}]},
 {...body,entities:[{entity:'action_log',key:'0',revision:1,deletedAt:null,row:{id:0,tool_name:'add_task',task_id:null,duty_id:null,title:'History',detail:null,created_at:now}}]},
 {...body,entities:[{entity:'oauth_codes',key:'secret',revision:1,deletedAt:null,row:{code:'secret'}}]},
 {...body,oauth_codes:['secret']},
];
it.each(malformed.map(body=>({body})))('rejects malformed versions, identities, family rows and live references',async({body})=>{
 const stub=installFetchStub();stub.respondWith({method:'GET',path:'/api/v2/sync/snapshot'},{type:'json',status:200,body});
 try{expect((await api.workspaceSnapshot(config)).kind).toBe('contract');}finally{stub.restore();}
});

it.each([
 {key:'sort_by',value:'urgency'}, {key:'sort_by',value:'manual'},
 {key:'session_log',value:'manual'}, {key:'interruption_style',value:'minimal'}, {key:'planning_prompt',value:'manual'},
])('preserves previously advertised preference $key=$value at the PWA read boundary',async row=>{
 const raw={...body,entities:[{entity:'preference',key:row.key,revision:0,deletedAt:null,row}]};
 const stub=installFetchStub();stub.respondWith({method:'GET',path:'/api/v2/sync/snapshot'},{type:'json',status:200,body:raw});
 try{expect(await api.workspaceSnapshot(config)).toEqual({kind:'ok',value:raw});}finally{stub.restore();}
});
it('preserves the retired snooze tool name in historical action logs',async()=>{
 const raw={...body,entities:[{entity:'action_log',key:'3',revision:0,deletedAt:null,row:{id:3,tool_name:'snooze_task',task_id:'t_deleted',duty_id:null,title:'Historical snooze',detail:null,created_at:now}}]};
 const stub=installFetchStub();stub.respondWith({method:'GET',path:'/api/v2/sync/snapshot'},{type:'json',status:200,body:raw});
 try{expect(await api.workspaceSnapshot(config)).toEqual({kind:'ok',value:raw});}finally{stub.restore();}
});
it.each(['task.complete','task.legacy-schedule.set','link.add','project.content.set'])('accepts command kind %s as an action-log name',async toolName=>{
 const raw={...body,entities:[{entity:'action_log',key:'4',revision:0,deletedAt:null,row:{id:4,tool_name:toolName,task_id:null,duty_id:null,title:'Command',detail:null,created_at:now}}]};
 const stub=installFetchStub();stub.respondWith({method:'GET',path:'/api/v2/sync/snapshot'},{type:'json',status:200,body:raw});
 try{expect(await api.workspaceSnapshot(config)).toEqual({kind:'ok',value:raw});}finally{stub.restore();}
});
it('still rejects an unknown action-log name',async()=>{
 const raw={...body,entities:[{entity:'action_log',key:'4',revision:0,deletedAt:null,row:{id:4,tool_name:'task.explode',task_id:null,duty_id:null,title:'Bad',detail:null,created_at:now}}]};
 const stub=installFetchStub();stub.respondWith({method:'GET',path:'/api/v2/sync/snapshot'},{type:'json',status:200,body:raw});
 try{expect((await api.workspaceSnapshot(config)).kind).not.toBe('ok');}finally{stub.restore();}
});
