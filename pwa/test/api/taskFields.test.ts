import { expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { parseCommandEnvelope } from '@shared/wire/commands';
const config={apiBase:'http://localhost:8787',authToken:'tok'};
const row={id:'t_first1',title:'Task',notes:null,kickoff_note:null,status:'pending',task_type:'action',project_id:null,due_date:null,due_all_day:null,recurrence:null,defer_kind:'none',defer_until:null,focused_until:null,session_log:null,duty_id:null,occurrence_at:null,available_from:null,deadline:null, parent_id: null, position: null,created_at:'2026-10-01T10:00:00.123Z',updated_at:'2026-10-01T10:00:00.123Z'};
it.each([
 {kind:'task.type.set',fields:{taskType:'plan'},patch:{task_type:'plan'}},
 {kind:'task.project.set',fields:{expectedStructuralRevision:5,project:{id:'p_first1',expectedRevision:3}},patch:{project_id:'p_first1'}},
 {kind:'task.legacy-schedule.set',fields:{values:{dueDate:'2026-10-05',dueAllDay:true,recurrence:'FREQ=WEEKLY'}},patch:{due_date:'2026-10-05T12:00:00Z',due_all_day:true,recurrence:'FREQ=WEEKLY'}},
])('parses $kind command/results through the PWA boundary',async({kind,fields,patch})=>{
 const input=parseCommandEnvelope({contractVersion:2,commandId:'c_fields01',actor:'user',commands:[{kind,id:row.id,expectedRevision:1,...fields}]});if(!input.ok)throw new Error();
 const result={contractVersion:2,commandId:input.value.commandId,payloadHash:'a'.repeat(64),serverNow:row.updated_at,changes:[{entity:'task',id:row.id,before:{row,revision:1},after:{row:{...row,...patch},revision:2}}],refs:{},warnings:[],applied:true};
 const stub=installFetchStub();stub.respondWith({method:'POST',path:'/api/v2/changes'},{type:'json',status:200,body:result});
 try{expect(await api.applyChanges(input.value,config)).toEqual({kind:'ok',value:result});expect(stub.calls[0]?.body).toEqual(input.value);}finally{stub.restore();}
});
it.each([
 {dueDate:null,dueAllDay:true,recurrence:null},{dueDate:null,dueAllDay:null,recurrence:'FREQ=WEEKLY'},
 {dueDate:'2026-10-05',dueAllDay:false,recurrence:'FREQ=WEEKLY'},{dueDate:'0099-12-31',dueAllDay:true,recurrence:null},
 {dueDate:'0100-01-01T00:00:00+01:00',dueAllDay:false,recurrence:null},{dueDate:'2026-10-05',recurrence:null},
])('rejects incomplete or incompatible legacy values before sending',values=>{
 expect(parseCommandEnvelope({contractVersion:2,commandId:'c_fields01',actor:'user',commands:[{kind:'task.legacy-schedule.set',id:row.id,expectedRevision:1,values}]}).ok).toBe(false);
});
