import { expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { parseWorkspaceExport } from '@shared/wire/workspaceExport';
const config={apiBase:'http://localhost:8787',authToken:'tok'};
const now='2026-10-01T10:00:00Z';
const task={id:'t_first1',title:'Task',notes:null,kickoff_note:null,status:'pending',task_type:'action',project_id:null,due_date:null,due_all_day:null,recurrence:null,defer_kind:'none',defer_until:null,focused_until:null,session_log:null,duty_id:null,occurrence_at:null,available_from:null,deadline:null,created_at:now,updated_at:now};
const body={version:2,exported_at:now,tasks:[task],projects:[],links:[],duties:[],preferences:[{key:'sort_by',value:'manual'}],planning_settings:null,action_log:[{id:1,tool_name:'snooze_task',task_id:'t_deleted',duty_id:null,title:'Historical',detail:null,created_at:now}],command_audit:[]};
it('parses a portable v2 export with retained legacy user data',async()=>{
 const parsed=parseWorkspaceExport(body);if(!parsed.ok)throw new Error();
 const stub=installFetchStub();stub.respondWith({method:'GET',path:'/api/v2/export'},{type:'json',status:200,body});
 try{expect(await api.exportWorkspace(config)).toEqual({kind:'ok',value:parsed.value});}finally{stub.restore();}
});
it.each([
 {...body,version:1}, {...body,cursor:{epoch:0,sequence:1}}, {...body,oauth_codes:[{code:'secret'}]},
 {...body,command_receipts:[]}, {...body,tasks:[task,task]},
 {...body,tasks:[{...task,project_id:'p_missing'}]}, {...body,tasks:[{...task,duty_id:'d_missing'}]},
 {...body,tasks:[{...task,future_user_field:'Do not silently discard'}]},
 {...body,links:[{from_task_id:task.id,to_task_id:'t_missing',link_type:'blocks'}]},
 {...body,preferences:[{key:'sort_by',value:'manual'},{key:'sort_by',value:'due'}]},
 {...body,planning_settings:{timezone:'UTC',bufferMinutes:0,workingHours:[],revision:3}},
 {...body,action_log:[{...body.action_log[0],tool_name:'unknown_tool'}]},
 {...body,command_audit:[{command_id:'c_first1',actor:'user',reason:null,changes_json:'not json',created_at:now}]},
 {...body,duties:[{id:'d_first1',title:'Duty',notes:null,kickoff_note:null,task_type:'action',project_id:'p_missing',rrule:'FREQ=DAILY',dtstart:now,timezone:null,status:'active',catch_up:'next',last_spawned_at:null,next_occurrence_at:null,created_at:now,updated_at:now}]},
].map(body=>({body})))('rejects unsupported or malformed portable data without silently stripping user fields',async({body})=>{
 const stub=installFetchStub();stub.respondWith({method:'GET',path:'/api/v2/export'},{type:'json',status:200,body});
 try{expect((await api.exportWorkspace(config)).kind).toBe('contract');}finally{stub.restore();}
});
