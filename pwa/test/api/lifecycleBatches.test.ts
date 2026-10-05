import { expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { parseCommandEnvelope, parseChangesResult } from '@shared/wire/commands';
const config={apiBase:'http://localhost:8787',authToken:'tok'};
const now='2026-10-01T10:00:00.123Z';
const task={id:'t_first1',title:'Task',notes:null,kickoff_note:null,status:'pending',task_type:'action',project_id:'p_first1',due_date:null,due_all_day:null,recurrence:null,defer_kind:'none',defer_until:null,focused_until:null,session_log:null,duty_id:null,occurrence_at:null,available_from:null,deadline:null,created_at:now,updated_at:now};
const project={id:'p_first1',title:'Project',notes:null,kickoff_note:null,status:'active',created_at:now,updated_at:now};
const root={entity:'project',id:project.id,before:{row:project,revision:1},after:{deleted:true,revision:2}};
const member={entity:'task',id:task.id,before:{row:task,revision:1},after:{row:{...task,project_id:null},revision:2}};
const other={entity:'task',id:'t_second',before:{row:{...task,id:'t_second',project_id:null},revision:1},after:{row:{...task,id:'t_second',project_id:null,task_type:'plan'},revision:2}};
const result={contractVersion:2,commandId:'c_life001',payloadHash:'a'.repeat(64),serverNow:now,batch:true,changeGroups:[2,1],applied:true,refs:{},warnings:[],changes:[root,member,other]};
it('parses compound group boundaries and full preserved member images through PWA',async()=>{
 const input=parseCommandEnvelope({contractVersion:2,commandId:result.commandId,actor:'user',expectedStructuralRevision:4,commands:[{kind:'project.delete',id:project.id,expectedRevision:1,expectedStructuralRevision:4},{kind:'task.type.set',id:'t_second',expectedRevision:1,taskType:'plan'}]});if(!input.ok)throw new Error();
 const stub=installFetchStub();stub.respondWith({method:'POST',path:'/api/v2/changes'},{type:'json',status:200,body:result});try{expect(await api.applyChanges(input.value,config)).toEqual({kind:'ok',value:result});}finally{stub.restore();}
});
it.each([
 {...result,changeGroups:undefined}, {...result,changeGroups:[3,1]}, {...result,changeGroups:[1,2]}, {...result,changeGroups:[0,3]},
 {...result,changeGroups:[3]}, {...result,batch:undefined}, {...result,changeGroups:[1.5,1.5]},
 ...[{title:'Changed'},{status:'done'},{project_id:project.id},{updated_at:'2026-10-02T10:00:00.123Z'}].map(patch=>({...result,changes:[root,{...member,after:{...member.after,row:{...member.after.row,...patch}}},other]})),
].map(body=>({body})))('rejects malformed groups and altered compound effect fields',({body})=>{expect(parseChangesResult(body).ok).toBe(false);});
it('requires grouped provenance for completion images while preserving old simple receipts',()=>{
 const recurring={...task,recurrence:'FREQ=WEEKLY',due_date:'2026-10-05T12:00:00Z',due_all_day:true};
 const completed={entity:'task',id:task.id,before:{row:recurring,revision:1},after:{row:{...recurring,status:'done'},revision:2}};
 const successor={entity:'task',id:'t_next001',before:null,after:{row:{...recurring,id:'t_next001',due_date:'2026-10-12T12:00:00Z'},revision:1}};
 expect(parseChangesResult({...result,changeGroups:[2,1],changes:[completed,successor,other],refs:{next:'t_next001'}}).ok).toBe(true);
 expect(parseChangesResult({...result,changeGroups:undefined,changes:[completed,successor,other],refs:{next:'t_next001'}}).ok).toBe(false);
 expect(parseChangesResult({...result,changeGroups:undefined,changes:[{...other,id:'t_third1',before:{...other.before,row:{...other.before.row,id:'t_third1'}},after:{...other.after,row:{...other.after.row,id:'t_third1'}}},other]}).ok).toBe(true);
});
it('keeps creation and successor refs unique within the command envelope',()=>{
 expect(parseCommandEnvelope({contractVersion:2,commandId:result.commandId,actor:'user',expectedStructuralRevision:4,commands:[{kind:'task.complete',id:task.id,expectedRevision:1,expectedStructuralRevision:4,successor:{id:'t_next001',clientRef:'same'}},{kind:'task.create',id:'t_third1',clientRef:'same',expectedRevision:null,expectedStructuralRevision:4,values:{title:'New',notes:null,kickoffNote:null,taskType:'action',project:null}}]}).ok).toBe(false);
});
