import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { AppAttestGate } from '../src/app-attest-gate.ts';
import { AttackReplayDemo, AttackReplayError } from '../src/attack-replay.ts';
import { ObservationSigner, authorizationInstruction } from '../src/observation-authorization.ts';
import { signatureBase58, type SolanaObservationRelayTransport } from '../src/solana-observation-relay.ts';
import type { ObservationRelayPayload } from '../src/observation-relay.ts';
import type { Gate2Snapshot } from '../src/gate2-evidence.ts';
import { DEVNET_GENESIS } from '../src/demo-safety.ts';
import { createEnrollmentServer } from '../src/enrollment-http.ts';
import type { ObserverEnrollmentService } from '../src/observer-enrollment.ts';

function cbor(bytes: Buffer): Buffer { return Buffer.concat([Buffer.from([0x58,bytes.length]),bytes]); }
function text(value: string): Buffer { const bytes=Buffer.from(value); return Buffer.concat([Buffer.from([0x60|bytes.length]),bytes]); }
async function fixture() {
  const directory=await mkdtemp(path.join(tmpdir(),'pathnod-dev42-replay-')),database=path.join(directory,'test.sqlite');
  const policy={appID:'U5MCCC24G5.xyz.pathnod.test',environment:'development' as const,allowedValidationCategories:[3],allowedBundleVersions:['1']};
  const gate=new AppAttestGate(database,policy),db=new DatabaseSync(database);
  const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),keyID=randomBytes(32).toString('base64');
  const payer=Keypair.generate(),program=Keypair.generate().publicKey,protocol=Buffer.alloc(32,7);
  const signer=new ObservationSigner(randomBytes(32)),scope=`${DEVNET_GENESIS}/${program.toBase58()}/${protocol.toString('hex')}`;
  const payload: ObservationRelayPayload={protocolID:protocol.toString('hex'),deviceID:'08'.repeat(32),epoch:42,
    transcriptHash:'11'.repeat(32),nullifier:'00'.repeat(31)+'03',pseudonym:'00'.repeat(31)+'02',observerClass:1,
    evidenceHash:'00'.repeat(32),proofBytes:'00'.repeat(480),policyVersion:1,verifier:signer.publicKey,verifierSignature:''};
  payload.verifierSignature=signer.sign(payload);
  // Synthetic enrolled key/accepted payload and injected RPC; runtime still requires real enrollment and chain accounts.
  db.prepare("INSERT INTO app_attest_keys VALUES (?,?,?,'development',0,NULL,NULL)")
    .run(keyID,key.publicKey.export({type:'spki',format:'pem'}).toString(),policy.appID);
  db.exec(`CREATE TABLE observer_enrollments (key_id TEXT PRIMARY KEY,observer_class INTEGER);
    CREATE TABLE observer_revocations_v0 (key_id TEXT PRIMARY KEY);
    CREATE TABLE observation_payout_owners_v0 (key_id TEXT,protocol TEXT,pseudonym TEXT);
    CREATE TABLE observation_relay_jobs (transcript_hash TEXT,status TEXT,payload TEXT);
    CREATE TABLE observation_policy_target (id INTEGER PRIMARY KEY,target TEXT);`);
  db.prepare('INSERT INTO observer_enrollments VALUES (?,1)').run(keyID);
  db.prepare('INSERT INTO observation_payout_owners_v0 VALUES (?,?,?)').run(keyID,scope,payload.pseudonym);
  db.prepare('INSERT INTO observation_relay_jobs VALUES (?,\'confirmed\',?)').run(payload.transcriptHash,JSON.stringify(payload));
  db.prepare('INSERT INTO observation_policy_target VALUES (1,?)').run('test-only/attack-policy');
  const accounting: Gate2Snapshot={commitment:program.toBase58(),independentObservers:3,paidSlotsUsed:3,observationRoot:'22'.repeat(32),
    slotPaid:true,gross:'50000',fees:'10000',available:'40000',withdrawn:'0',payoutNonce:'0',escrow:'0',feeVault:'30000',payoutVault:'40000'};
  let status: {confirmationStatus:'finalized';err:unknown}|null=null,prepared=0,sent=0,lostResponse=false,height=90;
  const bodies: Buffer[]=[];
  const adapter={contract:'test-only/replay-wire',instruction:(program: PublicKey,payer: PublicKey,payload: ObservationRelayPayload)=>
    new TransactionInstruction({programId:program,keys:[{pubkey:payer,isSigner:true,isWritable:true}],data:Buffer.from(payload.proofBytes,'hex')})};
  const connection={rpcEndpoint:'https://api.devnet.solana.com/',getSignatureStatuses:async()=>({value:[status]}),getBlockHeight:async()=>height,
    sendRawTransaction:async(wire:Buffer)=>{sent++;bodies.push(Buffer.from(wire));const tx=VersionedTransaction.deserialize(wire);
      status={confirmationStatus:'finalized',err:{InstructionError:[2,{Custom:6001}]}};
      if(lostResponse){lostResponse=false;throw Error('Lost RPC response after broadcast');}return signatureBase58(tx.signatures[0]!);},
  } as unknown as Connection;
  const transport={target:`${scope}/${signer.publicKey}/${payer.publicKey.toBase58()}/test-only-replay`,connection,program,protocol,payer,verifier:signer.publicKey,adapter,
    prepare:async(p:ObservationRelayPayload)=>{prepared++;
      const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:299999}),authorizationInstruction(p,p.verifier,p.verifierSignature),adapter.instruction(program,payer.publicKey,p)];
      const tx=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:PublicKey.default.toBase58(),instructions}).compileToV0Message());
      tx.sign([payer]);return {wire:Buffer.from(tx.serialize()).toString('base64'),signature:signatureBase58(tx.signatures[0]!),lastValidBlockHeight:100};},
  } as Pick<SolanaObservationRelayTransport,'target'|'connection'|'program'|'protocol'|'payer'|'verifier'|'adapter'|'prepare'>;
  const state=path.join(directory,'journals');
  let demo=await AttackReplayDemo.open(database,gate,transport,state,'test-only/attack-policy',async()=>({...accounting}));
  const assertion=(challenge:ReturnType<AttackReplayDemo['challenge']>,counter:number)=>{
    const count=Buffer.alloc(4);count.writeUInt32BE(counter);
    const auth=Buffer.concat([createHash('sha256').update(policy.appID).digest(),Buffer.from([0]),count]);
    const clientHash=createHash('sha256').update(Buffer.from(challenge.challenge,'base64')).digest();
    const digest=createHash('sha256').update(auth).update(clientHash).digest();
    return Buffer.concat([Buffer.from([0xa2]),text('signature'),cbor(sign('sha256',digest,key.privateKey)),text('authenticatorData'),cbor(auth)]);
  };
  return {directory,state,database,db,gate,keyID,payload,transport,accounting,bodies,assertion,
    get demo(){return demo;},get sent(){return sent;},get prepared(){return prepared;},
    loseResponse(){lostResponse=true;},expire(){height=101;},success(){status={confirmationStatus:'finalized',err:null};},
    async restart(){await demo.close();demo=await AttackReplayDemo.open(database,gate,transport,state,'test-only/attack-policy',async()=>({...accounting}));},
    async replay(counter:number){const challenge=demo.challenge(payload.transcriptHash,keyID);await demo.replay(payload.transcriptHash,keyID,challenge.id,assertion(challenge,counter));},
    async finish(){for(let i=0;i<200;i++){const value=await demo.status(payload.transcriptHash);
      if(value.status==='rejected'||value.status==='needs_inspection')return;
      await new Promise(r=>setTimeout(r,5));}throw Error('Replay did not settle');},
    async close(){await demo.close();gate.close();db.close();await rm(directory,{recursive:true,force:true});}};
}

test('DEV-42 replays one exact signed transaction, checks finalized E_NULLIFIER and preserves multi-observer accounting',async()=>{
  const f=await fixture();try {
    await f.replay(1);await f.finish();
    const state=await f.demo.status(f.payload.transcriptHash);
    assert.equal(state.status,'rejected');assert.equal(state.error,'E_NULLIFIER');assert.equal(state.unchanged,true);
    assert.equal(state.independent_observers,3);assert.equal(state.paid_slots_used,3);
    assert.equal(f.prepared,1);assert.equal(f.sent,1);
    const journal=JSON.parse(await readFile(path.join(f.state,f.payload.transcriptHash+'.json'),'utf8'));
    assert.deepEqual(journal.before,journal.after);assert.equal(journal.state,'rejected');
    assert.deepEqual(Buffer.from(journal.wire,'base64'),f.bodies[0]);
  }finally{await f.close();}
});

test('DEV-42 recovers a lost broadcast response after restart without replacing or sending another transaction',async()=>{
  const f=await fixture();try {
    f.loseResponse();await f.replay(1);await f.finish();
    assert.equal((await f.demo.status(f.payload.transcriptHash)).status,'needs_inspection');
    await f.restart();await f.replay(2);await f.finish();
    assert.equal((await f.demo.status(f.payload.transcriptHash)).status,'rejected');
    assert.equal(f.prepared,1);assert.equal(f.sent,1);
  }finally{await f.close();}
});

test('DEV-42 refuses revoked/foreign owners and mismatched challenges before spending a transaction fee',async()=>{
  const f=await fixture();try {
    assert.throws(()=>f.demo.challenge(f.payload.transcriptHash,'wrong-key'),AttackReplayError);
    const challenge=f.demo.challenge(f.payload.transcriptHash,f.keyID);
    await assert.rejects(f.demo.replay('33'.repeat(32),f.keyID,challenge.id,f.assertion(challenge,1)),AttackReplayError);
    const altered=f.assertion(challenge,1);altered[20]!^=1;
    await assert.rejects(f.demo.replay(f.payload.transcriptHash,f.keyID,challenge.id,altered),AttackReplayError);
    f.db.prepare('INSERT INTO observer_revocations_v0 VALUES (?)').run(f.keyID);
    assert.throws(()=>f.demo.challenge(f.payload.transcriptHash,f.keyID),AttackReplayError);
    assert.equal(f.sent,0);assert.equal(f.prepared,0);
  }finally{await f.close();}
});

test('DEV-42 preserves an expired ambiguous journal without sending or preparing a replacement',async()=>{
  const f=await fixture();try {
    f.expire();await f.replay(1);await f.finish();
    assert.equal((await f.demo.status(f.payload.transcriptHash)).status,'needs_inspection');
    await f.restart();await f.replay(2);await f.finish();assert.equal(f.prepared,1);assert.equal(f.sent,0);
  }finally{await f.close();}
});

test('DEV-42 never reports success or changed accounting as a successful attack rejection',async()=>{
  const f=await fixture();try {
    f.accounting.available='39999';
    f.loseResponse();await f.replay(1);await f.finish();
    f.accounting.available='40000';await f.restart();await f.replay(2);await f.finish();
    assert.equal((await f.demo.status(f.payload.transcriptHash)).status,'needs_inspection');
    f.success();await f.restart();await f.replay(3);await f.finish();
    assert.equal((await f.demo.status(f.payload.transcriptHash)).status,'needs_inspection');
  }finally{await f.close();}
});

test('DEV-42 rejects a tampered saved wire before rebroadcast and never exposes it in status',async()=>{
  const f=await fixture();try {
    f.expire();await f.replay(1);await f.finish();
    const file=path.join(f.state,f.payload.transcriptHash+'.json'),journal=JSON.parse(await readFile(file,'utf8'));
    const wire=Buffer.from(journal.wire,'base64');wire[2]!^=1;journal.wire=wire.toString('base64');await writeFile(file,JSON.stringify(journal),{mode:0o600});
    await f.restart();await f.replay(2);await f.finish();
    const state=await f.demo.status(f.payload.transcriptHash);assert.equal(state.status,'needs_inspection');
    assert.equal(f.sent,0);assert.ok(!JSON.stringify(state).includes('wire'));assert.ok(!JSON.stringify(state).includes(f.keyID));
  }finally{await f.close();}
});

test('DEV-42 HTTP attack controls are absent by default and do not expose replay routes',async()=>{
  const server=createEnrollmentServer({} as ObserverEnrollmentService);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}`;
  try {
    const capability=await fetch(base+'/demo/attacks');assert.equal(capability.status,200);
    assert.deepEqual(await capability.json(),{enabled:false,network:'devnet'});
    const replay=await fetch(base+'/demo/attacks/replay',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(replay.status,404);assert.deepEqual(await replay.json(),{error:'demo_disabled'});
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('DEV-42 HTTP authenticates the owner, validates request fields and serves a finalized rejection',async()=>{
  const f=await fixture(),server=createEnrollmentServer({} as ObserverEnrollmentService,undefined,undefined,undefined,undefined,f.demo);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const post=(route:string,body:object)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try {
    assert.equal((await post('/demo/attacks/challenge',{transcript_hash:f.payload.transcriptHash,key_id:'wrong'})).status,403);
    assert.equal((await post('/demo/attacks/challenge',{transcript_hash:f.payload.transcriptHash,key_id:f.keyID,extra:true})).status,400);
    const response=await post('/demo/attacks/challenge',{transcript_hash:f.payload.transcriptHash,key_id:f.keyID});assert.equal(response.status,200);
    const challenge=await response.json() as ReturnType<AttackReplayDemo['challenge']>;
    const replay=await post('/demo/attacks/replay',{transcript_hash:f.payload.transcriptHash,key_id:f.keyID,
      challenge_id:challenge.id,assertion:f.assertion(challenge,1).toString('base64')});assert.equal(replay.status,202);
    await f.finish();
    const status=await fetch(base+'/demo/attacks/replay/'+f.payload.transcriptHash);assert.equal(status.status,200);
    const result=await status.json() as Record<string,unknown>;assert.equal(result.status,'rejected');assert.equal(result.error,'E_NULLIFIER');
    assert.equal(result.unchanged,true);assert.equal(f.sent,1);
    const consumed=await post('/demo/attacks/replay',{transcript_hash:f.payload.transcriptHash,key_id:f.keyID,
      challenge_id:challenge.id,assertion:f.assertion(challenge,2).toString('base64')});assert.equal(consumed.status,403);assert.equal(f.sent,1);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});
