import { expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { parseWorkspaceDelta, parseWorkspaceDeltaInput } from '@shared/wire/sync';
const config={apiBase:'http://localhost:8787',authToken:'tok'};
const now='2026-10-01T10:00:00Z';
const row={id:'t_first1',title:'Task',notes:null,kickoff_note:null,status:'pending',task_type:'action',project_id:null,due_date:null,due_all_day:null,recurrence:null,defer_kind:'none',defer_until:null,focused_until:null,session_log:null,duty_id:null,occurrence_at:null,available_from:null,deadline:null, parent_id: null, position: null,created_at:now,updated_at:now};
const image={entity:'task',key:row.id,revision:2,deletedAt:null,row};
const body={contractVersion:2,from:{epoch:2,sequence:1},cursor:{epoch:2,sequence:2},watermark:{epoch:2,sequence:3},hasMore:true,changes:[{sequence:2,entity:image}]};
const parsedInput=parseWorkspaceDeltaInput({cursor:body.from,limit:1});if(!parsedInput.ok)throw new Error();const input=parsedInput.value;
it('parses branded page cursors/images and sends the initial pull input',async()=>{
 const expected=parseWorkspaceDelta(body);if(!expected.ok)throw new Error();
 const stub=installFetchStub();stub.respondWith({method:'POST',path:'/api/v2/sync/delta'},{type:'json',status:200,body});
 try{expect(await api.workspaceDelta(input,config)).toEqual({kind:'ok',value:expected.value});expect(stub.calls[0]?.body).toEqual(input);}finally{stub.restore();}
});
it('accepts partial graph pages and validates a final deletion page with its fixed watermark',async()=>{
 const request=parseWorkspaceDeltaInput({cursor:body.cursor,watermark:body.watermark,limit:1});if(!request.ok)throw new Error();
 const final={...body,from:body.cursor,cursor:body.watermark,hasMore:false,changes:[{sequence:3,entity:{...image,revision:3,deletedAt:'2026-10-01T11:00:00.123Z',row:null}}]};
 const stub=installFetchStub();stub.respondWith({method:'POST',path:'/api/v2/sync/delta'},{type:'json',status:200,body:final});
 try{expect((await api.workspaceDelta(request.value,config)).kind).toBe('ok');expect(stub.calls[0]?.body).toEqual(request.value);}finally{stub.restore();}
 // Complete live reference checks happen after staging the entire pull.
 expect(parseWorkspaceDelta({...body,changes:[{sequence:2,entity:{...image,row:{...row,project_id:'p_later1'}}}]}).ok).toBe(true);
});
it.each([
 {...body,cursor:{epoch:3,sequence:2}}, {...body,watermark:{epoch:3,sequence:3}},
 {...body,from:{epoch:2,sequence:3}}, {...body,cursor:{epoch:2,sequence:4}},
 {...body,changes:[]}, {...body,hasMore:false},
 {...body,changes:[{sequence:1,entity:image}]}, {...body,changes:[{sequence:3,entity:image}]},
 {...body,changes:[{sequence:2,entity:image},{sequence:2,entity:{...image,key:'t_other1',row:{...row,id:'t_other1'}}}]},
 {...body,cursor:{epoch:2,sequence:3},watermark:{epoch:2,sequence:4},changes:[{sequence:2,entity:image},{sequence:3,entity:image}]},
 {...body,changes:[{sequence:2,entity:{...image,row:{...row,due_all_day:1}}}]},
 {...body,changes:[{sequence:2,entity:{...image,key:'t_other1'}}]},
 {...body,watermark:{epoch:2,sequence:9007199254740992}},
 // Individually valid result with a different requested range must still fail.
 {...body,from:{epoch:2,sequence:0}},
 {...body,cursor:{epoch:2,sequence:3},watermark:{epoch:2,sequence:4},changes:[{sequence:2,entity:image},{sequence:3,entity:{...image,revision:3}}]},
].map(body=>({body})))('rejects malformed images, cursor relationships and request mismatches',async({body})=>{
 const stub=installFetchStub();stub.respondWith({method:'POST',path:'/api/v2/sync/delta'},{type:'json',status:200,body});
 try{expect((await api.workspaceDelta(input,config)).kind).toBe('contract');}finally{stub.restore();}
});
it('rejects a changed watermark on a continuation even when the page itself is valid',async()=>{
 const continuation=parseWorkspaceDeltaInput({cursor:body.from,watermark:body.watermark,limit:1});if(!continuation.ok)throw new Error();
 const stub=installFetchStub();stub.respondWith({method:'POST',path:'/api/v2/sync/delta'},{type:'json',status:200,body:{...body,watermark:{epoch:2,sequence:4}}});
 try{expect((await api.workspaceDelta(continuation.value,config)).kind).toBe('contract');}finally{stub.restore();}
});
it('preserves explicit reset diagnostics as a parsed 409 response',async()=>{
 const error={contractVersion:2,error:{code:'sync_reset_required',path:['cursor'],message:'Reset required',retryable:false,recoveryHint:'Fetch a snapshot and retain intent.',syncReset:{reason:'epoch_changed',currentCursor:{epoch:3,sequence:10},retentionFloor:5}}};
 const stub=installFetchStub();stub.respondWith({method:'POST',path:'/api/v2/sync/delta'},{type:'json',status:409,body:error});
 try{expect(await api.workspaceDelta(input,config)).toMatchObject({kind:'http',status:409,body:{contractError:error.error}});}finally{stub.restore();}
});
it('rejects a reset response that omits its required diagnostics',async()=>{
 const error={contractVersion:2,error:{code:'sync_reset_required',path:['cursor'],message:'Reset required',retryable:false,recoveryHint:'Fetch a snapshot.'}};
 const stub=installFetchStub();stub.respondWith({method:'POST',path:'/api/v2/sync/delta'},{type:'json',status:409,body:error});
 try{expect((await api.workspaceDelta(input,config)).kind).toBe('contract');}finally{stub.restore();}
});
it('supports an empty final page and strictly increasing revisions for repeated identities',()=>{
 expect(parseWorkspaceDelta({...body,cursor:body.watermark,hasMore:false,changes:[]}).ok).toBe(true);
 expect(parseWorkspaceDelta({...body,cursor:body.watermark,hasMore:false,changes:[{sequence:2,entity:image},{sequence:3,entity:{...image,revision:3}}]}).ok).toBe(true);
});
