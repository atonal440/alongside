import { expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { parseCommandEnvelope, parseChangesResult } from '@shared/wire/commands';
const config={apiBase:'http://localhost:8787',authToken:'tok'};
const now='2026-10-01T10:00:00.123Z';
const row={id:'t_first1',title:'Task',notes:null,kickoff_note:null,status:'pending',task_type:'action',project_id:null,due_date:null,due_all_day:null,recurrence:null,defer_kind:'none',defer_until:null,focused_until:null,session_log:null,duty_id:null,occurrence_at:null,available_from:null,deadline:null,created_at:now,updated_at:now};
const second={...row,id:'t_second'};
const parsed=parseCommandEnvelope({contractVersion:2,commandId:'c_batch01',actor:'user',expectedStructuralRevision:0,commands:[row,second].map((task,index)=>({kind:'task.create',id:task.id,clientRef:index?'second':'first',expectedRevision:null,expectedStructuralRevision:0,values:{title:task.title,notes:null,kickoffNote:null,taskType:'action',project:null}}))});if(!parsed.ok)throw new Error();
const result={contractVersion:2,commandId:parsed.value.commandId,payloadHash:'a'.repeat(64),serverNow:now,batch:true,applied:true,refs:{first:row.id,second:second.id},warnings:[],changes:[row,second].map(task=>({entity:'task',id:task.id,before:null,after:{revision:1,row:task}}))};
it('parses a mixed result and all scoped references through the PWA boundary',async()=>{
 const stub=installFetchStub();stub.respondWith({method:'POST',path:'/api/v2/changes'},{type:'json',status:200,body:result});try{expect(await api.applyChanges(parsed.value,config)).toEqual({kind:'ok',value:result});expect(stub.calls[0]?.body).toEqual(parsed.value);}finally{stub.restore();}
});
it.each([
 {...result,batch:undefined}, {...result,changes:[result.changes[0]]}, {...result,changes:[result.changes[0],result.changes[0]]},
 {...result,refs:{first:'t_third1'}}, {...result,refs:{constructor:row.id}},
 {...result,changes:[{entity:'task',id:row.id,before:{revision:1,row},after:{revision:2,deleted:true}},result.changes[1]]},
].map(body=>({body})))('rejects missing markers, duplicate identities and unsafe reference/deletion data',({body})=>{expect(parseChangesResult(body).ok).toBe(false);});
it.each([undefined,-1,Number.MAX_SAFE_INTEGER+1])('requires a safe envelope structural revision',expectedStructuralRevision=>{expect(parseCommandEnvelope({...parsed.value,expectedStructuralRevision}).ok).toBe(false);});
