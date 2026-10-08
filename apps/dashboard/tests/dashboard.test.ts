import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { confidenceCommitment, decodeObservationTranscript, observationTranscriptHash } from '@pathnod/verifier';
import { discriminator, registryAddresses, UPGRADEABLE_LOADER, appendObservationTree } from '@pathnod/solana';
import { configFromEnv, DEVNET_GENESIS } from '../src/config.ts';
import { DashboardService, validateConfidence, boundedJSON, type Reader } from '../src/service.ts';
import { createDashboardServer } from '../src/server.ts';
// @ts-expect-error Plain browser ES module is exercised directly, not bundled with Node code.
import { LatestRequest, percentage, explorer } from '../public/state.js';
const vector=JSON.parse(readFileSync(new URL('../../../fixtures/confidence/report-v0.json',import.meta.url),'utf8'));
const env={PATHNOD_DASHBOARD_NETWORK:'devnet',PATHNOD_DASHBOARD_RPC_URL:'https://api.devnet.solana.com',
  PATHNOD_DASHBOARD_GENESIS:DEVNET_GENESIS,PATHNOD_DASHBOARD_PROGRAM_ID:vector.scope.program,
  PATHNOD_DASHBOARD_PROTOCOL_ID:vector.scope.protocolID,PATHNOD_DASHBOARD_VERIFIER_URL:'http://127.0.0.1:8787'};
const config=configFromEnv(env);
const state={independentObservers:vector.scope.transcriptOrder.length,paidSlotsUsed:1,
  observationRoot:Buffer.from(vector.scope.observationRoot,'hex'),confidenceCommitment:Buffer.from(vector.commitment,'hex'),frontier:undefined};
const context={network:'devnet' as const,genesis:DEVNET_GENESIS,program:vector.scope.program,protocolID:vector.scope.protocolID,mode:'live',queryLimit:1000,readOnly:true};
function checked(body:Record<string,any>){return validateConfidence(body,context,vector.scope.deviceID,vector.scope.epoch,vector.scope.policyVersion,state);}
test('configuration rejects other networks, remote local validators and credentials',()=>{
  assert.equal(config.network,'devnet');
  for(const changes of [{PATHNOD_DASHBOARD_NETWORK:'mainnet'}, {PATHNOD_DASHBOARD_GENESIS:'wrong'},
    {PATHNOD_DASHBOARD_RPC_URL:'https://example.com'}, {PATHNOD_DASHBOARD_VERIFIER_URL:'https://user:secret@example.com'},
    {PATHNOD_DASHBOARD_PROTOCOL_ID:'00'.repeat(32)}, {PATHNOD_DASHBOARD_NETWORK:'local-validator'}])assert.throws(()=>configFromEnv({...env,...changes}));
});
test('confidence uses the shared canonical hash, exact deployment, epoch, policy and state',()=>{
  const body={status:'published',commitment:vector.commitment,confidence:structuredClone(vector.report)};
  assert.equal(checked(body).status,'published');
  assert.equal(checked(body).score,vector.report.score);
  assert.ok(!('weightedBps' in checked(body).observers));
  assert.throws(()=>checked({...body,commitment:'11'.repeat(32)}));
  for(const change of [{program:new PublicKey(Buffer.alloc(32,8)).toBase58()},{protocolID:'11'.repeat(32)},
    {deviceID:'22'.repeat(32)},{epoch:0},{policyVersion:2},{observationRoot:'33'.repeat(32)}]){
    const report={...vector.report,scope:{...vector.report.scope,...change}};
    assert.throws(()=>checked({...body,confidence:report,commitment:confidenceCommitment(report)}));
  }
});
test('projection never forwards unknown private fields and policy key order is canonical',()=>{
  const report=structuredClone(vector.report);
  report.policy=Object.fromEntries(Object.entries(report.policy).reverse());
  report.private_transcript='must-not-reach-browser';
  const hash=confidenceCommitment(report);
  const result=validateConfidence({status:'published',commitment:hash,confidence:report},context,vector.scope.deviceID,vector.scope.epoch,vector.scope.policyVersion,{...state,confidenceCommitment:Buffer.from(hash,'hex')});
  assert.ok(!JSON.stringify(result).includes('must-not-reach-browser'));
});
test('oversized verifier responses are cancelled and rejected',async()=>{
  await assert.rejects(boundedJSON(new Response('x'.repeat(2_000_001))),/large/);
});
test('latest-request gate prevents old device/epoch responses and formatting is bounded',()=>{
  const gate=new LatestRequest(),first=gate.begin(),second=gate.begin();
  assert.equal(first.signal.aborted,true);assert.equal(gate.current(first),false);assert.equal(gate.current(second),true);
  assert.equal(percentage(3693),'36.93%');assert.throws(()=>percentage(10001));
  assert.equal(explorer('local-validator','address',vector.scope.program),null);
  assert.ok(explorer('devnet','address',vector.scope.program).endsWith('?cluster=devnet'));
});
test('service fails closed on wrong genesis before reading any accounts',async()=>{
  const reader={getGenesisHash:async()=> 'wrong',getMultipleAccountsInfo:async()=>{throw Error('must not read');}} as unknown as Reader;
  await assert.rejects(new DashboardService(config,reader).devices(0),/mismatch/);
});
function chainFixture(){
  const v=JSON.parse(readFileSync(new URL('../../../fixtures/observations/transcript-v0.json',import.meta.url),'utf8')).vectors[0];
  const t=decodeObservationTranscript(Buffer.from(v.bytes.slice(2),'hex')),hash=observationTranscriptHash(t);
  const c={...config,protocol:Buffer.from(t.protocolID)},a=registryAddresses(c.program,c.protocol);
  const owned=(data:Buffer,owner=c.program,executable=false):AccountInfo<Buffer>=>({data,owner,executable,lamports:1});
  const policy=Buffer.alloc(185);discriminator('account','ProtocolConfig').copy(policy);c.program.toBuffer().copy(policy,8);
  c.protocol.copy(policy,40);policy.writeUInt32LE(604800,72);c.program.toBuffer().copy(policy,76);policy.writeUInt32LE(1,108);a.escrow.toBuffer().copy(policy,153);
  const device=Buffer.alloc(126);discriminator('account','DeviceRegistry').copy(device);Buffer.from(t.deviceID).copy(device,8);Buffer.from(t.publicKey).copy(device,40);device[72]=1;
  const record=Buffer.alloc(214);discriminator('account','ObservationCommitment').copy(record);c.protocol.copy(record,8);Buffer.from(t.deviceID).copy(record,40);record.writeUInt32LE(t.epoch,72);Buffer.from(t.nullifier).copy(record,76);Buffer.from(t.pseudonym).copy(record,108);record[140]=1;hash.copy(record,141);Buffer.from(t.evidenceHash).copy(record,173);record[205]=1;
  record.writeBigInt64LE(1n,206);
  const epoch=Buffer.alloc(587);discriminator('account','DeviceEpoch').copy(epoch);epoch.writeUInt16LE(1,8);epoch[10]=1;appendObservationTree(Array.from({length:16},()=>Buffer.alloc(32)),0,hash).root.copy(epoch,11);
  const map=new Map([[c.program.toBase58(),owned(Buffer.alloc(0),UPGRADEABLE_LOADER,true)],[a.config.toBase58(),owned(policy)],
    [a.device(t.deviceID).toBase58(),owned(device)],[a.epoch(t.deviceID,t.epoch).toBase58(),owned(epoch)]]);
  let globalCount=1;
  const reader={getGenesisHash:async()=>c.genesis,getAccountInfo:async(key:PublicKey)=>map.get(key.toBase58())??null,
    getMultipleAccountsInfo:async(keys:PublicKey[])=>keys.map(key=>map.get(key.toBase58())??null),
    getProgramAccounts:async(_key:PublicKey,opts:{filters:{dataSize?:number}[]})=>opts.filters[0]?.dataSize===126?
      Array.from({length:globalCount},()=>({pubkey:a.device(t.deviceID),account:owned(device)})):
      [{pubkey:PublicKey.findProgramAddressSync([Buffer.from('obs'),t.nullifier],c.program)[0],account:owned(record)}]} as unknown as Reader;
  return {c,t,epoch,map,reader,setCount:(n:number)=>{globalCount=n;}};
}
test('device reads are protocol scoped, bounded, finalized and preserve reward semantics',async()=>{
  const f=chainFixture(),service=new DashboardService(f.c,f.reader);
  const list=await service.devices(0);assert.equal(list.total,1);assert.equal(list.devices[0]!.id,Buffer.from(f.t.deviceID).toString('hex'));
  assert.ok(!('registeredAt' in list.devices[0]!));
  const detail=await service.detail(list.devices[0]!.id,f.t.epoch);assert.ok(detail);assert.equal(detail.state?.paidSlots,1);assert.equal(detail.confidence.status,'stale');assert.equal(detail.observations[0]!.paid,true);
  f.epoch[10]=0;await assert.rejects(service.detail(list.devices[0]!.id,f.t.epoch),/changed during/);f.epoch[10]=1;
  f.setCount(1001);await assert.rejects(service.devices(0),/no partial/);
  const other=new DashboardService({...f.c,protocol:Buffer.alloc(32,7)},f.reader);await assert.rejects(other.devices(0),/Untrusted/);
});
test('missing and unavailable confidence do not substitute fixtures, and concurrent epoch changes fail closed',async()=>{
  const f=chainFixture(),id=Buffer.from(f.t.deviceID).toString('hex');f.epoch.fill(1,43,75);
  let upstream:typeof fetch=(async()=>new Response('{}',{status:404})) as typeof fetch;
  const service=new DashboardService(f.c,f.reader,((...args:Parameters<typeof fetch>)=>upstream(...args)) as typeof fetch);
  assert.equal((await service.detail(id,f.t.epoch))!.confidence.status,'missing');
  upstream=(async()=>new Response('{}',{status:503})) as typeof fetch;assert.equal((await service.detail(id,f.t.epoch))!.confidence.status,'unavailable');
  upstream=(async()=>new Response(JSON.stringify({status:'published',commitment:'invented'}))) as typeof fetch;
  assert.equal((await service.detail(id,f.t.epoch))!.confidence.status,'unavailable');
  upstream=(async()=>{f.epoch[43]=2;return new Response(JSON.stringify({status:'stale'}));}) as typeof fetch;
  await assert.rejects(service.detail(id,f.t.epoch),/changed during/);
});
test('HTTP is read-only, validates queries, hides upstream failures and does not expose configuration URLs',async()=>{
  const service={devices:async(offset:number)=>({...context,offset,total:0,devices:[]}),
    detail:async(id:string)=>id==='00'.repeat(32)?undefined:{...context,confidence:{status:'stale'}}} as unknown as DashboardService;
  const server=createDashboardServer(service);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  try{
    assert.equal((await fetch(base+'/api/devices',{method:'POST'})).status,405);
    for(const query of ['offset=0&offset=1','offset=-1','key=secret'])assert.equal((await fetch(base+'/api/devices?'+query)).status,400);
    assert.equal((await fetch(base+'/api/devices/'+vector.scope.deviceID+'?epoch=42&epoch=43')).status,400);
    assert.equal((await fetch(base+'/api/devices/'+'00'.repeat(32)+'?epoch=42')).status,404);
    const detail=await (await fetch(base+'/api/devices/'+vector.scope.deviceID+'?epoch=42')).json() as {confidence:{status:string}};
    assert.equal(detail.confidence.status,'stale');
    const ctx=await fetch(base+'/api/devices');assert.equal(ctx.headers.get('cache-control'),'no-store');
    assert.ok(!JSON.stringify(await ctx.json()).includes('8787'));
    assert.equal((await fetch(base+'/')).status,200);assert.equal((await fetch(base+'/../package.json')).status,404);
    assert.equal((await fetch(base+'/api/context')).status,404);
    service.devices=async()=>{throw Error('private upstream detail');};const failed=await fetch(base+'/api/devices');
    assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes('private upstream'));
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
