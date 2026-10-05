import { expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { parseWorkspaceRestoreInput } from '@shared/wire/workspaceRestore';
const config={apiBase:'http://localhost:8787',authToken:'tok'};
const now='2026-10-01T10:00:00Z';
const task={id:'t_first1',title:'Task',notes:null,kickoff_note:null,status:'pending',task_type:'action',project_id:null,due_date:null,due_all_day:null,recurrence:null,defer_kind:'none',defer_until:null,focused_until:null,session_log:null,duty_id:null,occurrence_at:null,available_from:null,deadline:null, parent_id: null, position: null,created_at:now,updated_at:now};
const document={version:2,exported_at:now,tasks:[task],projects:[],links:[],duties:[],preferences:[],planning_settings:null,action_log:[],command_audit:[]};
const zero={tasks:0,projects:0,links:0,duties:0,preferences:0,planning_settings:0,action_log:0};
const request=(mode:'preflight'|'apply')=>{const parsed=parseWorkspaceRestoreInput({contractVersion:2,mode,expectedCursor:{epoch:0,sequence:4},document});if(!parsed.ok)throw new Error('bad input');return parsed.value;};
const result=(overrides:Record<string,unknown>={})=>({contractVersion:2,mode:'preflight',applied:false,previousCursor:{epoch:0,sequence:4},resultingCursor:null,replaces:{...zero,tasks:3},restores:{...zero,tasks:1},notRestored:{command_audit:0},requiredStatements:12,limit:100,nextEpoch:1,...overrides});
const send=async(mode:'preflight'|'apply',body:unknown)=>{const stub=installFetchStub();stub.respondWith({method:'POST',path:'/api/v2/restore'},{type:'json',status:200,body});try{return await api.restoreWorkspace(request(mode),config);}finally{stub.restore();}};
it('parses preflight and apply results that echo the request',async()=>{
 expect((await send('preflight',result())).kind).toBe('ok');
 expect((await send('apply',result({mode:'apply',applied:true,resultingCursor:{epoch:1,sequence:4}}))).kind).toBe('ok');
});
it.each([
 {name:'wrong mode',sent:'preflight' as const,body:result({mode:'apply',applied:true,resultingCursor:{epoch:1,sequence:4}})},
 {name:'other cursor',body:result({previousCursor:{epoch:0,sequence:5}})},
 {name:'other counts',body:result({restores:{...zero,tasks:2}})},
 {name:'hidden audit count',body:result({notRestored:{command_audit:1}})},
 {name:'applied without cursor',body:result({applied:true})},
 {name:'epoch skipped',body:result({nextEpoch:3})},
 {name:'new epoch mismatch',body:result({mode:'apply',applied:true,resultingCursor:{epoch:0,sequence:4}})},
 {name:'resume point skips restore events',body:result({mode:'apply',applied:true,resultingCursor:{epoch:1,sequence:19}})},
 {name:'over capacity',body:result({requiredStatements:101})},
 {name:'unknown field',body:{...result(),secret:'x'}},
])('rejects $name',async({body,...rest})=>{
 expect((await send('sent' in rest?rest.sent:(body.mode==='apply'?'apply':'preflight'),body)).kind).toBe('contract');
});
it('rejects requests with an unknown mode or extra fields before they can be sent',()=>{
 expect(parseWorkspaceRestoreInput({contractVersion:2,mode:'wipe',expectedCursor:{epoch:0,sequence:0},document}).ok).toBe(false);
 expect(parseWorkspaceRestoreInput({contractVersion:2,mode:'apply',expectedCursor:{epoch:0,sequence:0},document,force:true}).ok).toBe(false);
});
