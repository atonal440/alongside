import { expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { parseCommandEnvelope, parseChangesResult } from '@shared/wire/commands';
const config={apiBase:'http://localhost:8787',authToken:'tok'};
const now='2026-10-01T10:00:00.123Z';
const task={id:'t_first1',title:'Task',notes:null,kickoff_note:null,status:'pending',task_type:'action',project_id:'p_first1',due_date:null,due_all_day:null,recurrence:null,defer_kind:'none',defer_until:null,focused_until:null,session_log:null,duty_id:null,occurrence_at:null,available_from:null,deadline:null, parent_id: null, position: null,created_at:now,updated_at:now};
const project={id:'p_first1',title:'Project',notes:null,kickoff_note:null,status:'active',created_at:now,updated_at:now};
const link={from_task_id:task.id,to_task_id:'t_second',link_type:'blocks'};
const base={contractVersion:2,commandId:'c_delete1',payloadHash:'a'.repeat(64),serverNow:now,applied:true,warnings:[],refs:{}};
const taskChange={entity:'task',id:task.id,before:{row:task,revision:1},after:{deleted:true,revision:2}};
const projectChange={entity:'project',id:project.id,before:{row:project,revision:1},after:{deleted:true,revision:2}};
const linkChange={entity:'link',id:JSON.stringify([link.from_task_id,link.to_task_id,link.link_type]),before:{row:link,revision:2},after:{deleted:true,revision:3}};
const memberChange={entity:'task',id:task.id,before:{row:task,revision:1},after:{row:{...task,project_id:null},revision:2}};
it.each([
 {kind:'task.delete',id:task.id,changes:[taskChange,linkChange]},
 {kind:'project.delete',id:project.id,changes:[projectChange,memberChange]},
])('parses $kind and derived effects through the PWA boundary',async({kind,id,changes})=>{
 const input=parseCommandEnvelope({contractVersion:2,commandId:base.commandId,actor:'user',commands:[{kind,id,expectedRevision:1,expectedStructuralRevision:4}]});if(!input.ok)throw new Error();
 const result={...base,changes};const stub=installFetchStub();stub.respondWith({method:'POST',path:'/api/v2/changes'},{type:'json',status:200,body:result});
 try{expect(await api.applyChanges(input.value,config)).toEqual({kind:'ok',value:result});expect(stub.calls[0]?.body).toEqual(input.value);}finally{stub.restore();}
});
it.each([
 [{...taskChange,before:null}], [{...taskChange,after:{deleted:true,revision:3}}], [{...taskChange,id:'t_second'}],
 [taskChange,{...linkChange,before:{...linkChange.before,row:{...link,from_task_id:'t_third1'}},id:JSON.stringify(['t_third1','t_second','blocks'])}],
 [projectChange,{...memberChange,after:{...memberChange.after,row:task}}],
 [projectChange,{...memberChange,before:{...memberChange.before,row:{...task,project_id:null}}}],
 [taskChange,memberChange], [projectChange,linkChange],
 ...[{title:'Changed'},{status:'done'},{due_date:'2026-10-02T12:00:00Z'},{updated_at:'2026-10-02T10:00:00.123Z'}].map(patch=>[projectChange,{...memberChange,after:{...memberChange.after,row:{...memberChange.after.row,...patch}}}]),
].map(changes=>({changes})))('rejects invalid deletion identities, revision steps and cascade membership',({changes})=>{expect(parseChangesResult({...base,changes}).ok).toBe(false);});
it.each([{expectedRevision:null},{expectedStructuralRevision:undefined},{values:{}}])('rejects missing guards and arbitrary deletion fields',patch=>{expect(parseCommandEnvelope({contractVersion:2,commandId:base.commandId,actor:'user',commands:[{kind:'task.delete',id:task.id,expectedRevision:1,expectedStructuralRevision:4,...patch}]}).ok).toBe(false);});
it('retains a parsed exact capacity diagnostic through the PWA boundary',async()=>{
 const input=parseCommandEnvelope({contractVersion:2,commandId:base.commandId,actor:'user',commands:[{kind:'project.delete',id:project.id,expectedRevision:1,expectedStructuralRevision:4}]});if(!input.ok)throw new Error();
 const error={code:'capacity_exceeded',path:['commands'],message:'Atomic deletion requires 103 statements',retryable:false,recoveryHint:'Reduce scope explicitly',requiredStatements:103,limit:100};
 const stub=installFetchStub();stub.respondWith({method:'POST',path:'/api/v2/changes'},{type:'json',status:413,body:{contractVersion:2,error}});
 try{expect(await api.applyChanges(input.value,config)).toMatchObject({kind:'http',status:413,body:{contractError:error}});}finally{stub.restore();}
});
