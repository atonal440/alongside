import { expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { parseCommandEnvelope } from '@shared/wire/commands';
const config = { apiBase:'http://localhost:8787',authToken:'tok' };
const parsed = parseCommandEnvelope({ contractVersion:2,commandId:'c_complete1',actor:'user',commands:[{kind:'task.complete',id:'t_first1',expectedRevision:1,expectedStructuralRevision:1,successor:{id:'t_successor',clientRef:'next'}}] });
if (!parsed.ok) throw new Error();const input = parsed.value;
const row = {id:'t_first1',title:'Task',notes:null,kickoff_note:null,status:'pending',task_type:'action',project_id:null,due_date:'2026-10-05T12:00:00Z',due_all_day:true,recurrence:'FREQ=WEEKLY',defer_kind:'none',defer_until:null,focused_until:null,session_log:null,duty_id:null,occurrence_at:null,available_from:null,deadline:null, parent_id: null, position: null,created_at:'2026-10-01T10:00:00.123Z',updated_at:'2026-10-01T10:00:00.123Z'};
const completed = {entity:'task',id:row.id,before:{row,revision:1},after:{row:{...row,status:'done'},revision:2}};
const next = {entity:'task',id:'t_successor',before:null,after:{row:{...row,id:'t_successor',due_date:'2026-10-12T12:00:00Z'},revision:1}};
const result = {contractVersion:2,commandId:input.commandId,payloadHash:'a'.repeat(64),serverNow:row.updated_at,changes:[completed,next],refs:{next:next.id},warnings:[],applied:true};
it('parses compound completion results and successor reference without discarding either image', async () => {
  const stub=installFetchStub();stub.respondWith({method:'POST',path:'/api/v2/changes'},{type:'json',status:200,body:result});
  try {expect(await api.applyChanges(input,config)).toEqual({kind:'ok',value:result});expect(stub.calls[0]?.body).toEqual(input);}
  finally {stub.restore();}
});
it.each([
  {...result,changes:[{...completed,before:{...completed.before,row:{...row,id:'t_other1'}}},next]},
  {...result,changes:[completed,{...next,after:{...next.after,row:{...next.after.row,id:'t_other1'}}}]},
  {...result,changes:[completed,{...next,after:{...next.after,revision:2}}]},
  {...result,changes:[{...completed,after:{...completed.after,revision:3}},next]},
  {...result,changes:[completed,{...next,id:row.id,after:{...next.after,row}}]},
  {...result,changes:[completed,next,next]}, {...result,refs:{next:row.id}}, {...result,refs:{constructor:next.id}},
  {...result,changes:[{...completed,after:{...completed.after,row}},next]},
  {...result,changes:[completed,{...next,before:completed.before,after:{...next.after,revision:2}}]},
])('rejects malformed compound identity/revision/ref/transition data',async body=>{
  const stub=installFetchStub();stub.respondWith({method:'POST',path:'/api/v2/changes'},{type:'json',status:200,body});
  try {expect((await api.applyChanges(input,config)).kind).toBe('contract');}finally{stub.restore();}
});
it('parses both completion images in a side-effect-free preview',async()=>{
  const {applied:_applied,...values}=result;const preview={...values,dryRun:true,requiredStatements:10};
  const stub=installFetchStub();stub.respondWith({method:'POST',path:'/api/v2/changes/preview'},{type:'json',status:200,body:preview});
  try {expect(await api.previewChanges(input,config)).toEqual({kind:'ok',value:preview});}finally{stub.restore();}
});
