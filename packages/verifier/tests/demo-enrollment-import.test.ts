import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, chmod, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppAttestGate } from '../src/app-attest-gate.ts';
import { ObserverEnrollmentService } from '../src/observer-enrollment.ts';
import { ObservationPolicyService } from '../src/observation-policy.ts';
import { ObservationRelayer, initializeObservationRelay, type ObservationRelayTransport } from '../src/observation-relay.ts';
import { ObserverRootPublisher, type RootPublicationTransport } from '../src/root-publication.ts';
import { createEnrollmentServer } from '../src/enrollment-http.ts';
import { demoRuntimeDatabase, importDemoEnrollment } from '../src/demo-enrollment-import.ts';
import { digest, hardwareInfo } from '../src/demo-safety.ts';

const policy={appID:'U5MCCC24G5.xyz.pathnod.appattestspike',environment:'development',
  allowedValidationCategories:[3],allowedBundleVersions:[]} as const;
const repo=path.resolve(import.meta.dirname,'../../..');
const unused=async():Promise<never>=>{throw Error('No chain transactions allowed in import test');};

test('DEV-37 imports an old-bound enrollment snapshot and starts fresh HTTP/policy/relay/publisher services',async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),'pathnod-demo-import-'));
  const source=path.join(folder,'source.sqlite'),runtime=demoRuntimeDatabase(folder);
  try {
    const gate=new AppAttestGate(source,policy);
    const keyID=Buffer.alloc(32,7).toString('base64');
    const publicKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({format:'pem',type:'spki'}).toString();
    const input=new DatabaseSync(source);
    input.prepare('INSERT INTO app_attest_keys VALUES (?,?,?,?,?,?,?)').run(keyID,publicKey,policy.appID,'development',41,3,'1');
    // Explicit synthetic verified-record fixture; no runtime attestation bypass.
    const enrollment=await ObserverEnrollmentService.open(source,{
      getKey:id=>gate.getKey(id),issueChallenge:(purpose,id)=>gate.issueChallenge(purpose,id),
      acceptAssertion:()=>gate.getKey(keyID)!,acceptAttestation:()=>gate.getKey(keyID)!,
    });
    const commitment='0x'+'1'.padStart(64,'0');
    const challenge=enrollment.issueEnrollmentChallenge(commitment,keyID);
    enrollment.enroll(challenge.id,commitment,keyID,Buffer.alloc(0));
    const oldPolicy=new ObservationPolicyService(source,policy,{target:'old-policy',snapshot:unused},{verify:async()=>false});
    initializeObservationRelay(input,'old-policy','old-verifier');
    input.prepare('INSERT INTO observation_relay_transport VALUES (1,?)').run('old-transport');
    input.exec("CREATE TABLE observer_publication_target (singleton INTEGER PRIMARY KEY,target TEXT NOT NULL); INSERT INTO observer_publication_target VALUES (1,'old-publisher')");
    input.prepare('INSERT INTO observer_revocations_v0 VALUES (?,?)').run(keyID,1234);
    input.prepare('INSERT INTO observation_device_counters_v0 VALUES (?,?)').run('device-id',99);
    input.prepare('INSERT INTO observation_validations_v0 VALUES (?,?,?,?)').run('old-transcript','old-envelope','old-nullifier',1234);
    const expectedRoot=enrollment.root();
    const retained=['app_attest_keys','observer_enrollments','observer_merkle_nodes','observer_roots',
      'observer_enrollment_events','observer_revocations_v0','observation_device_counters_v0'];
    const records=retained.map(table=>input.prepare(`SELECT * FROM ${table}`).all());
    oldPolicy.close();enrollment.close();gate.close();input.close();
    await chmod(source,0o600);
    const before=await readFile(source);
    // Recover a previously prepared manifest through the actual CLI path, with
    // no build artifacts or wallet available: this must never touch the chain.
    const info=Buffer.alloc(70);info[1]=1;info.fill(9,2,34);info.writeUInt32BE(2,34);
    const infoFile=path.join(folder,'info.bin');await writeFile(infoFile,info,{mode:0o600});
    const config={version:1,freshRun:'existing-demo',stateDirectory:folder,rpc:'https://api.devnet.solana.com',mode:'hardware',
      enrollmentDatabase:source,deviceInfo:infoFile,wallet:'/unavailable-wallet',wasm:'/unavailable-wasm',
      zkey:'/unavailable-zkey',verificationKey:'/unavailable-vk'};
    const raw=JSON.stringify(config)+'\n',configFile=path.join(folder,'config.json');
    await writeFile(configFile,raw,{mode:0o600});
    await writeFile(path.join(folder,'manifest.json'),JSON.stringify({version:1,configDigest:digest(raw),
      device:hardwareInfo(info),root:{root:expectedRoot.root.slice(2),leafCount:1}}),{mode:0o600});
    const command=spawnSync(process.execPath,[path.join(repo,'packages/verifier/scripts/dev37-demo.ts'),
      '--config',configFile,'--import-enrollment'],{encoding:'utf8',timeout:15000});
    assert.equal(command.status,0,command.stderr);assert.match(command.stdout,/no chain writes/);
    await assert.rejects(()=>stat(path.join(folder,'state.json')),{code:'ENOENT'});
    assert.equal((await stat(runtime)).mode&0o077,0);
    assert.deepEqual(await readFile(source),before,'source database is not mutated');
    const imported=new DatabaseSync(runtime);
    retained.forEach((table,i)=>assert.deepEqual(imported.prepare(`SELECT * FROM ${table}`).all(),records[i]));
    assert.equal(imported.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('observation_policy_target','observation_relay_target','observer_publication_target','observation_relay_transport','observation_validations_v0','app_attest_challenges','observer_challenges')").get()!.n,0);
    imported.close();
    const newGate=new AppAttestGate(runtime,policy);
    const newEnrollment=await ObserverEnrollmentService.open(runtime,newGate);
    const newPolicy=new ObservationPolicyService(runtime,policy,{target:'fresh-policy',snapshot:unused},{verify:async()=>false});
    const relayTransport:ObservationRelayTransport={target:'fresh-transport',eligible:unused,prepare:unused,send:unused,inspect:unused,expired:unused};
    const relayer=new ObservationRelayer(runtime,'fresh-policy','fresh-verifier',relayTransport);
    const rootTransport:RootPublicationTransport={target:'fresh-publisher',program:'fresh-program',cluster:'devnet',
      inspect:unused,prepare:unused,send:unused,expired:unused,address:()=> 'test-only'};
    const publisher=new ObserverRootPublisher(runtime,newEnrollment,rootTransport);
    const server=createEnrollmentServer(newEnrollment,publisher,undefined,undefined,newPolicy);
    try {
      assert.equal(newGate.getKey(keyID)!.counter,41);
      assert.deepEqual(newEnrollment.root(),expectedRoot);
      await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
      const address=server.address();assert.ok(address&&typeof address!=='string');
      const response=await fetch(`http://127.0.0.1:${address.port}/health`);
      assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'ok'});
      const db=new DatabaseSync(runtime);
      assert.equal(db.prepare('SELECT revoked_at FROM observer_revocations_v0 WHERE key_id=?').get(keyID)!.revoked_at,1234);
      db.prepare('UPDATE app_attest_keys SET counter=42 WHERE key_id=?').run(keyID);db.close();
      await assert.rejects(()=>importDemoEnrollment(source,runtime,repo),{code:'EEXIST'});
      assert.equal(newGate.getKey(keyID)!.counter,42,'resume must not roll back assertion counters');
      const repeated=spawnSync(process.execPath,[path.join(repo,'packages/verifier/scripts/dev37-demo.ts'),
        '--config',configFile,'--import-enrollment'],{encoding:'utf8',timeout:15000});
      assert.notEqual(repeated.status,0);assert.match(repeated.stderr,/EEXIST/);
      assert.equal(newGate.getKey(keyID)!.counter,42);
      assert.deepEqual(await readFile(source),before);
    } finally {
      if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      await publisher.close();await relayer.close();newPolicy.close();newEnrollment.close();newGate.close();
    }
  } finally {await rm(folder,{recursive:true,force:true});}
});

test('DEV-37 fixture runtime starts empty and never imports a synthetic Apple enrollment',async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),'pathnod-demo-import-empty-'));
  try {
    const runtime=demoRuntimeDatabase(folder);await importDemoEnrollment(undefined,runtime,repo);
    const db=new DatabaseSync(runtime);
    try {for(const table of ['app_attest_keys','observer_enrollments','observer_revocations_v0'])assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,0);}
    finally {db.close();}
  } finally {await rm(folder,{recursive:true,force:true});}
});
