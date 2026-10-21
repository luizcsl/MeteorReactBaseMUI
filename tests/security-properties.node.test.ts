import test from 'node:test';
import assert from 'node:assert/strict';
import {operationHandler, type Operation} from '../imports/core/server/operations';
import {tenantScope, ownerScope, scopeSelector} from '../imports/core/server/policy';
import * as s from '../imports/core/contracts/schema';
const identities = Array.from({length:32},(_,i)=>`user-${i}`);
const ctx=(userId:string)=>({userId,requestId:'property'});
test('property: all mismatched invocation identities fail before policy or handler',async()=>{
 for(let i=0;i<identities.length;i++){
  let effects=0;
  const op:Operation<string,string>={name:'probe',input:s.string(1,30),output:s.string(1,30),effect:'write',policy:async()=>{effects++},handler:async()=>{effects++;return'ok'}};
  const invoke=operationHandler(op,async()=>ctx(identities[(i+1)%identities.length]));
  await assert.rejects(invoke.call({userId:identities[i]},'value'));
  assert.equal(effects,0);
 }
});
test('property: denied policy never reaches handler',async()=>{
 for(const id of identities){let effects=0;const invoke=operationHandler({name:'denied',input:s.string(1,30),output:s.string(1,30),effect:'write',policy:async()=>{throw Error('denied')},handler:async()=>{effects++;return'ok'}},async()=>ctx(id));await assert.rejects(invoke.call({userId:id},'value'));assert.equal(effects,0);}
});
test('property: outputs cannot leak undeclared fields',async()=>{
 for(const id of identities){const invoke=operationHandler({name:'projection',input:s.string(1,30),output:s.strictObject({title:s.string(1,30)}),effect:'read',policy:async()=>{},handler:async()=>({title:'safe',secret:id})},async()=>ctx(id));await assert.rejects(invoke.call({userId:id},'value'));}
});
test('property: owner selectors bind the authenticated identity and exclude tenant rows',()=>{
 for(const id of identities)assert.deepEqual(scopeSelector(ownerScope(ctx(id))),{ownerId:id,tenantId:null});
});
test('property: membership decisions require all independent authority predicates',async()=>{
 for(const id of identities){const base={userId:id,tenantId:'tenant-a',role:'editor' as const,active:true};assert.deepEqual(await tenantScope(ctx(id),'tenant-a',['editor'],async()=>base),{kind:'tenant',tenantId:'tenant-a'});
 for(const member of [null,{...base,active:false},{...base,userId:`other-${id}`},{...base,tenantId:'tenant-b'},{...base,role:'viewer' as const}])await assert.rejects(tenantScope(ctx(id),'tenant-a',['editor'],async()=>member));
 }
});
