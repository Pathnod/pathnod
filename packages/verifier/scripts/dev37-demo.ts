/** DEV-37. All generated files are private, external to Git; reports whitelist public data. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, mkdir, cp, open, unlink, realpath, stat, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildPoseidon } from 'circomlibjs';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram,
  AddressLookupTableProgram } from '@solana/web3.js';
import { DEVNET_USDC, TOKEN_PROGRAM, UPGRADEABLE_LOADER, registryAddresses, paymentAddresses,
  initializeEnrollmentAuthority, initializeObservationVerifier, initializePayments, initProtocol,
  registerDevice, publishRoot, decodeProtocol, decodeDevice, decodeEnrollment, decodeRoot,
  decodePaymentSettings, decodeObservationVerifier, activeRoots, verificationKeyDigest } from '@pathnod/solana';
import { signatureBase58 } from '../src/solana-observation-relay.ts';
import { demoTarget, digest, within, externalFile, privateFile, hardwareInfo, canonicalRoot,
  pendingDecision } from '../src/demo-safety.ts';
import { demoRuntimeDatabase, importDemoEnrollment } from '../src/demo-enrollment-import.ts';

const repo = await realpath(fileURLToPath(new URL('../../..',import.meta.url)));
const sleep = (ms: number) => new Promise(resolve=>setTimeout(resolve,ms));
type Config = { version: 1; freshRun: string; stateDirectory: string; wallet: string;
  rpc: string; genesis?: string; localValidator?: boolean; mode: 'fixture' | 'hardware';
  wasm: string; zkey: string; verificationKey: string; deviceInfo?: string; enrollmentDatabase?: string };
type Journal = { signature: string; wire: string; lastValidBlockHeight: number; finalized: boolean };
type Manifest = { version: 1; configDigest: string; program: string; wallet: string; protocol: string;
  device: { key: string; device: string; capabilities: number }; root: { root: string; leafCount: number };
  artifacts: Record<string,string>; keyDigest: string; binaryHash: string; programCapacity: number; tools: Record<string,string> };
type State = { version: 1; startedAt: number; elapsedMs: number; transactions: Record<string,Journal>; complete: boolean;
  lookup?: string; lookupSlot?: number; deploymentAttempted?: boolean; deploymentSignature?: string };

async function json(file: string) { return JSON.parse(await readFile(file,'utf8')); }
async function atomic(file: string, value: unknown) {
  const handle=await open(file+'.next','w',0o600);
  try {await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
  await rename(file+'.next',file);
}
async function command(executable: string, args: string[], cwd = repo, live = false): Promise<string> {
  return new Promise((resolve,reject)=>{
    const child = spawn(executable,args,{cwd,stdio:['ignore','pipe','pipe']});
    let output = '';
    const consume = (data: Buffer) => { output += data.toString(); if (live) process.stdout.write(data); };
    child.stdout.on('data',consume); child.stderr.on('data',consume);
    child.on('error',()=>reject(Error(`Missing prerequisite: ${executable}`)));
    child.on('exit',code=>code===0 ? resolve(output.trim()) : reject(Error(`${executable} failed; see private run logs / command output`)));
  });
}
async function tools() {
  const versions = { node:process.versions.node, pnpm:await command('pnpm',['--version']),
    rust:await command('rustc',['--version']), solana:await command('solana',['--version']),
    anchor:await command('anchor',['--version']), sbf:await command('cargo-build-sbf',['--version']) };
  assert.equal(versions.node,'24.21.0','Install pinned Node 24.21.0 before demo');
  assert.equal(versions.pnpm,'11.27.1','Install pinned pnpm');
  assert.match(versions.rust,/^rustc 1\.95\.0 /); assert.match(versions.solana,/^solana-cli 4\.2\.2 /);
  assert.match(versions.anchor,/^anchor-cli 1\.2\.0/);
  return versions;
}
async function key(file: string) {
  try { return Keypair.fromSecretKey(Uint8Array.from(await json(await privateFile(file,repo)))); }
  catch { throw Error('Invalid private keypair file; require a Solana JSON array outside Git with mode 600'); }
}
async function rootAndDevice(c: Config): Promise<Pick<Manifest,'root' | 'device'>> {
  if (c.mode === 'fixture') {
    assert.equal(c.deviceInfo,undefined,'Fixture mode cannot consume hardware inputs');
    assert.equal(c.enrollmentDatabase,undefined,'Fixture mode cannot consume real enrollment');
    const fixture = await json(path.join(repo,'fixtures/observations/transcript-v0.json'));
    const t = fixture.vectors[0].transcript;
    const key = Buffer.from(t.publicKey.slice(2),'hex'), info=Buffer.alloc(70);
    info[1]=1;key.copy(info,2);info.writeUInt32BE(2,34);
    return { device:hardwareInfo(info),root:canonicalRoot(BigInt(fixture.vectors[0].enrollment.root).toString(16).padStart(64,'0'),1) };
  }
  assert.ok(c.deviceInfo && c.enrollmentDatabase,'Hardware mode requires actual INFO and a verified enrollment database; no fixture fallback');
  const device = hardwareInfo(await readFile(await externalFile(c.deviceInfo,repo)));
  const db = new DatabaseSync(await privateFile(c.enrollmentDatabase,repo),{readOnly:true});
  try {
    db.exec('BEGIN'); // root, leaf records and attestation associations share one snapshot
    // Recorded verification is an operator trust input; recompute the full tree without exporting identifiers.
    const rows = db.prepare('SELECT commitment, observer_class AS class, leaf_index AS idx, leaf, key_id AS keyID FROM observer_enrollments ORDER BY leaf_index').all();
    const snapshot = db.prepare('SELECT root, leaf_count AS count FROM observer_roots ORDER BY revision DESC LIMIT 1').get();
    assert.ok(snapshot && rows.length>0 && snapshot.count===rows.length,'No complete recorded enrollment snapshot');
    const p = await buildPoseidon(), hash=(values: bigint[])=>p.F.toObject(p(values)) as bigint;
    let nodes: bigint[]=[];
    for (const [i,row] of rows.entries()) {
      assert.equal(row.idx,i);assert.ok([1,2,3].includes(Number(row.class)));
      assert.ok(db.prepare('SELECT key_id FROM app_attest_keys WHERE key_id=?').get(row.keyID!),'Enrollment has no recorded attestation key');
      const leaf=hash([BigInt(String(row.commitment)),BigInt(Number(row.class))]);assert.equal('0x'+leaf.toString(16).padStart(64,'0'),row.leaf);
      nodes.push(leaf);
    }
    let zero=0n;
    for(let level=0;level<20;level++) { const next: bigint[]=[];for(let i=0;i<nodes.length;i+=2)next.push(hash([nodes[i]!,nodes[i+1]??zero]));nodes=next;zero=hash([zero,zero]); }
    assert.equal('0x'+nodes[0]!.toString(16).padStart(64,'0'),snapshot.root,'Recorded tree root mismatch');
    return {device,root:canonicalRoot(String(snapshot.root).replace(/^0x/,''),rows.length)};
  } finally {if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}
async function prepareRuntime(c: Config, folder: string, inputs: Pick<Manifest,'root'|'device'>) {
  assert.deepEqual(await rootAndDevice(c),inputs,'Source enrollment root/identity differs from prepared deployment');
  const runtimeDatabase=demoRuntimeDatabase(folder);
  await importDemoEnrollment(c.mode==='hardware'?c.enrollmentDatabase:undefined,runtimeDatabase,repo);
  if(c.mode==='hardware')assert.deepEqual(await rootAndDevice({...c,enrollmentDatabase:runtimeDatabase}),inputs,
    'Enrollment snapshot changed during preparation; no deployment performed');
}
async function prepare(c: Config, folder: string, configDigest: string) {
  const manifestFile=path.join(folder,'manifest.json');
  try { await stat(manifestFile);throw Error('Prepared run already exists; use make demo, or choose a new freshRun and empty stateDirectory'); }
  catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  // A failed preparation can contain keys: never overwrite them implicitly either.
  try {await stat(path.join(folder,'program.json'));throw Error('Incomplete preparation exists; use a new empty state directory, preserve the old keys');}
  catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const versions=await tools(), wallet=await key(c.wallet), inputs=await rootAndDevice(c);
  await prepareRuntime(c,folder,inputs);
  const artifacts: Record<string,string>={};
  for (const [name,file] of Object.entries({wasm:c.wasm,zkey:c.zkey,verificationKey:c.verificationKey})) {
    artifacts[name]=digest(await readFile(await externalFile(file,repo)));
  }
  const vk=await json(c.verificationKey), keyDigest=verificationKeyDigest(vk);
  const build=path.join(folder,'build');
  // No mutation of source checkout, shared program ID, or existing target/deploy artifacts.
  await mkdir(build,{recursive:true,mode:0o700});
  for(const file of ['Cargo.toml','Cargo.lock','rust-toolchain.toml','programs','tools/poseidon-vectors-rust']) {
    await cp(path.join(repo,file),path.join(build,file),{recursive:true,filter:source=>!source.split(path.sep).includes('target')});
  }
  const program=Keypair.generate();await atomic(path.join(folder,'program.json'),Array.from(program.secretKey));
  await atomic(path.join(folder,'buffer.json'),Array.from(Keypair.generate().secretKey));
  await atomic(path.join(folder,'verifier.json'),Array.from(Keypair.generate().secretKey));
  const lib=path.join(build,'programs/pathnod/src/lib.rs');
  const source=await readFile(lib,'utf8');assert.equal([...source.matchAll(/declare_id!\("[^"]+"\);/g)].length,1,'Expected exactly one program ID declaration');
  await writeFile(lib,source.replace(/declare_id!\("[^"]+"\);/,`declare_id!("${program.publicKey.toBase58()}");`));
  await command(process.execPath,[path.join(repo,'packages/solana/scripts/dev35-trusted-key.mjs'),c.verificationKey,path.join(build,'programs/pathnod/src/trusted_vk.rs')],repo,true);
  // Export the zkey VK and execute the WASM with known witness inputs before deployment.
  const snarkjs=path.join(repo,'packages/circuits/node_modules/.bin/snarkjs');
  const exported=path.join(folder,'exported-vk.json');
  await command(snarkjs,['zkey','export','verificationkey',c.zkey,exported]);
  assert.equal(verificationKeyDigest(await json(exported)),keyDigest,'zkey and VK mismatch');
  const witnesses=path.join(folder,'artifact-witnesses.json');
  await command(process.execPath,[path.join(repo,'packages/circuits/scripts/dev35-witnesses.mjs'),witnesses]);
  const vector=(await json(witnesses)).vectors[0];const input=path.join(folder,'artifact-input.json'),proof=path.join(folder,'artifact-proof.json'),signals=path.join(folder,'artifact-public.json');
  await atomic(input,vector.inputs);
  await command(snarkjs,['groth16','fullprove',input,c.wasm,c.zkey,proof,signals]);
  assert.deepEqual(await json(signals),vector.public,'WASM public-input contract mismatch');
  const verified=await command(snarkjs,['groth16','verify',c.verificationKey,signals,proof]);assert.match(verified,/OK!/);
  await command('cargo-build-sbf',['--manifest-path',path.join(build,'programs/pathnod/Cargo.toml'),'--sbf-out-dir',path.join(folder,'deploy'),'--tools-version','v1.57','--arch','v3','--','--locked'],build,true);
  const binary=await readFile(path.join(folder,'deploy/pathnod.so')),binaryHash=digest(binary);
  const protocol=Buffer.from(digest(`Pathnod/demo/v0/${c.freshRun}/${program.publicKey.toBase58()}`),'hex').toString('hex');
  const manifest: Manifest={version:1,configDigest,program:program.publicKey.toBase58(),wallet:wallet.publicKey.toBase58(),protocol,
    ...inputs,artifacts,keyDigest,binaryHash,programCapacity:binary.length,tools:versions};
  await atomic(manifestFile,manifest);
  console.log('Preparation complete. Run make demo with the same DEMO_CONFIG; no chain writes performed.');
}

async function run(c: Config, folder: string, fingerprint: string, check: boolean) {
  const started=Date.now();let manifest: Manifest;
  try {manifest=await json(path.join(folder,'manifest.json'));}
  catch {throw Error('Missing/invalid prepared manifest: run make demo-prepare with this DEMO_CONFIG first');}
  assert.equal(manifest.version,1);assert.equal(manifest.configDigest,fingerprint,'Configuration changed; do not reuse existing deployment state');
  assert.deepEqual(await tools(),manifest.tools,'Toolchain differs from prepared run');
  const wallet=await key(c.wallet);assert.equal(wallet.publicKey.toBase58(),manifest.wallet);
  const programKey=await key(path.join(folder,'program.json')), verifier=await key(path.join(folder,'verifier.json'));
  assert.equal(programKey.publicKey.toBase58(),manifest.program);
  assert.equal(digest(await readFile(path.join(folder,'deploy/pathnod.so'))),manifest.binaryHash,'Prepared program changed');
  for(const [name,file] of Object.entries({wasm:c.wasm,zkey:c.zkey,verificationKey:c.verificationKey})) {
    assert.equal(digest(await readFile(await externalFile(file,repo))),manifest.artifacts[name],`Artifact changed: ${name}`);
  }
  const runtimeDatabase=await privateFile(demoRuntimeDatabase(folder),repo).catch(error=>{
    if((error as NodeJS.ErrnoException).code==='ENOENT')throw Error('Runtime database missing: run make demo-import-enrollment with the same DEMO_CONFIG; no redeployment required');
    throw error;
  });
  assert.deepEqual(await rootAndDevice(c.mode==='hardware'?{...c,enrollmentDatabase:runtimeDatabase}:c),
    {device:manifest.device,root:manifest.root},'Hardware/runtime enrollment input changed');
  const {rpc,local,expected}=demoTarget(c.rpc,c.localValidator,c.genesis);
  let last=0;
  const connection=new Connection(rpc.href,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:async(input,init)=>{
    await sleep(Math.max(0,750-(Date.now()-last)));last=Date.now();
    const response=await fetch(input,{...init,redirect:'error',signal:AbortSignal.timeout(15000)});
    if(response.status===429) throw Error('RPC rate limit; resume later with the same DEMO_CONFIG');return response;
  }});
  assert.equal(await connection.getGenesisHash(),expected,'Unexpected cluster: refusing transactions');
  const program=programKey.publicKey, protocol=Buffer.from(manifest.protocol,'hex'), registry=registryAddresses(program,protocol);
  const payments=paymentAddresses(program,protocol,Buffer.alloc(32)), mint=DEVNET_USDC;
  const mintAccount=await connection.getAccountInfo(mint);assert.ok(mintAccount?.owner.equals(TOKEN_PROGRAM)&&mintAccount.data[44]===6,'Devnet USDC mint unavailable');
  const ata=PublicKey.findProgramAddressSync([wallet.publicKey.toBuffer(),TOKEN_PROGRAM.toBuffer(),mint.toBuffer()],new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0];
  const stateFile=path.join(folder,'state.json');let state: State;
  try {state=await json(stateFile);assert.equal(state.version,1);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={version:1,startedAt:started,elapsedMs:0,transactions:{},complete:false};}
  const previouslyComplete=state.complete;
  const reward=50_000n,funding=150_000n;
  // Fixed-size disposable demos do not need the CLI's default 2x future-upgrade headroom.
  const capacity=manifest.programCapacity??(await stat(path.join(folder,'deploy/pathnod.so'))).size*2;
  const deployed=await connection.getAccountInfo(program);
  const escrow=await connection.getAccountInfo(registry.escrow);
  if(!state.complete) {
    const rent=await connection.getMinimumBalanceForRentExemption(capacity+45);
    const bufferRent=await connection.getMinimumBalanceForRentExemption((await stat(path.join(folder,'deploy/pathnod.so'))).size+37);
    const buffer=await key(path.join(folder,'buffer.json')),existingBuffer=await connection.getAccountInfo(buffer.publicKey);
    if(existingBuffer)assert.ok(existingBuffer.owner.equals(UPGRADEABLE_LOADER)&&existingBuffer.data.readUInt32LE(0)===1&&existingBuffer.data[4]===1&&existingBuffer.data.subarray(5,37).equals(wallet.publicKey.toBuffer()),'Untrusted deployment buffer');
    const needed=deployed ? 50_000_000 : rent+Math.max(0,bufferRent-(existingBuffer?.lamports??0))+100_000_000;
    assert.ok(await connection.getBalance(wallet.publicKey)>=needed,`Insufficient devnet SOL: need at least ${needed/1e9}; fund the explicitly configured wallet`);
    const token=await connection.getAccountInfo(ata);
    const needUSDC=escrow ? funding-escrow.data.readBigUInt64LE(64) : funding;
    assert.ok(needUSDC<=0n || token?.owner.equals(TOKEN_PROGRAM) && token.data.length===165 && token.data[108]===1 &&
      token.data.subarray(0,32).equals(mint.toBuffer()) && token.data.subarray(32,64).equals(wallet.publicKey.toBuffer()) &&
      token.data.readBigUInt64LE(64)>=needUSDC,'Fund the configured wallet with at least 0.15 devnet USDC; faucets are not automatic');
  }
  if(check){console.log(`Preflight OK; program ${manifest.program}; no transactions sent.`);return;}
  const save=()=>atomic(stateFile,state);
  async function owned(address: PublicKey, owner=program) {
    const account=await connection.getAccountInfo(address);assert.ok(account && !account.executable && account.owner.equals(owner),`Untrusted account ${address.toBase58()}`);return account.data;
  }
  async function send(name: string, instruction: TransactionInstruction | TransactionInstruction[]) {
    let record=state.transactions[name];
    if(record?.finalized)return;
    if(record) {
      const status=(await connection.getSignatureStatuses([record.signature],{searchTransactionHistory:true})).value[0]??null;
      const decision=pendingDecision(status,await connection.getBlockHeight('finalized'),record.lastValidBlockHeight);
      if(decision==='failed')throw Error(`Transaction ${name} failed; inspect its recorded signature`);
      if(decision==='unknown')throw Error(`Transaction ${name} not finalized; resume later, do not replace it`);
      if(decision==='finalized'){record.finalized=true;await save();return;}
      // On expiry require a separate resume after state inspection; never silently resubmit value transfers.
      if(decision==='expired')throw Error(`Expired ambiguous ${name}; inspect signature and account state before an explicit recovery`);
    } else {
      const tx=new Transaction({feePayer:wallet.publicKey,...await connection.getLatestBlockhash('finalized')}).add(...(Array.isArray(instruction)?instruction:[instruction]));
      tx.sign(wallet);assert.ok(tx.signature);
      record={signature:signatureBase58(tx.signature),wire:tx.serialize().toString('base64'),lastValidBlockHeight:tx.lastValidBlockHeight!,finalized:false};
      state.transactions[name]=record;await save(); // durable signature and exact bytes BEFORE network send
    }
    await connection.sendRawTransaction(Buffer.from(record.wire,'base64'),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:5});
    // HTTP confirmation also works when a local validator has no reachable pubsub port.
    let finalized=false;
    for(let attempt=0;attempt<60;attempt++) {
      const status=(await connection.getSignatureStatuses([record.signature],{searchTransactionHistory:true})).value[0];
      assert.ok(!status?.err,`Failed ${name}; inspect its saved signature`);
      if(status?.confirmationStatus==='finalized'){finalized=true;break;}
      await sleep(1000);
    }
    assert.ok(finalized,`Pending ${name}; resume with the same configuration`);
    record.finalized=true;await save();console.log(`${name}: finalized`);
  }
  async function deployVerified() {
    const account=await connection.getAccountInfo(program);
    // The CLI may return at confirmed commitment; do not deploy again while that program is finalizing.
    const confirmed=account??await connection.getAccountInfo(program,'confirmed');
    if(!confirmed && !state.deploymentSignature) {
      state.deploymentAttempted=true;await save();
      // Fixed program and buffer keypairs survive interruption. CLI's buffer upload retries are idempotent.
      const output=await command('solana',['program','deploy',path.join(folder,'deploy/pathnod.so'),'--program-id',path.join(folder,'program.json'),
        '--buffer',path.join(folder,'buffer.json'),'--keypair',c.wallet,'--url',c.rpc,'--max-len',String(capacity),local?'--use-rpc':'--use-tpu-client','--max-sign-attempts','2','--output','json'],repo,true);
      await writeFile(path.join(folder,'deployment-output.log'),output,{mode:0o600});
      const result=JSON.parse(output.slice(output.indexOf('{'),output.lastIndexOf('}')+1));
      assert.equal(result.programId,manifest.program);
      if(typeof result.signature==='string'){state.deploymentSignature=result.signature;await save();}
    }
    let live=await connection.getAccountInfo(program);
    for(let attempt=0;!live&&attempt<60;attempt++){await sleep(1000);live=await connection.getAccountInfo(program);}
    assert.ok(live?.executable&&live.owner.equals(UPGRADEABLE_LOADER),'Deployment not finalized; resume the same run, never create another program');
    const data=await owned(new PublicKey(live.data.subarray(4,36)),UPGRADEABLE_LOADER);
    assert.equal(data.readUInt32LE(0),3);assert.equal(data[12],1);assert.ok(data.subarray(13,45).equals(wallet.publicKey.toBuffer()),'Wrong upgrade authority');
    const binary=await readFile(path.join(folder,'deploy/pathnod.so'));
    assert.ok(data.subarray(45,45+binary.length).equals(binary)&&data.subarray(45+binary.length).every(b=>b===0),'Deployed artifact mismatch; will not overwrite it');
    // Recover a deployment whose CLI response was lost, without redeploying the program.
    if(!state.deploymentSignature) {
      const signatures=await connection.getSignaturesForAddress(program,{limit:20},'finalized');
      const successful=signatures.find(s=>s.err===null);assert.ok(successful,'Cannot recover finalized deployment signature');
      state.deploymentSignature=successful.signature;await save();
    }
  }
  try {
    await deployVerified();
    if(!await connection.getAccountInfo(registry.enrollment))await send('enrollment',initializeEnrollmentAuthority(program,wallet.publicKey,wallet.publicKey));
    assert.ok(decodeEnrollment(await owned(registry.enrollment)).authority.equals(wallet.publicKey));
    const info=PublicKey.findProgramAddressSync([Buffer.from('observation-verifier')],program)[0];
    if(!await connection.getAccountInfo(info))await send('verifier_metadata',initializeObservationVerifier(program,wallet.publicKey));
    assert.equal(decodeObservationVerifier(await owned(info)).keyDigest,manifest.keyDigest);
    if(!await connection.getAccountInfo(payments.settings))await send('payments',initializePayments(program,wallet.publicKey,mint,wallet.publicKey));
    const settings=decodePaymentSettings(await owned(payments.settings));assert.equal(settings.feeBps,2000);
    assert.ok(settings.authority.equals(wallet.publicKey)&&settings.treasury.equals(wallet.publicKey)&&settings.mint.equals(mint));
    if(!await connection.getAccountInfo(registry.config))await send('protocol',initProtocol(program,wallet.publicKey,mint,{protocolId:protocol,
      epochSeconds:604800,verifier:verifier.publicKey,policyVersion:1,rewardPerSlot:reward,slotsPerEpoch:3}));
    const config=decodeProtocol(await owned(registry.config));
    assert.ok(config.authority.equals(wallet.publicKey)&&config.protocolId.equals(protocol)&&config.escrow.equals(registry.escrow)&&config.rewardMint.equals(mint)&&config.verifier.equals(verifier.publicKey));
    assert.equal(config.policyVersion,1);assert.equal(config.rewardPerSlot,reward);assert.equal(config.slotsPerEpoch,3);assert.equal(config.epochSeconds,604800);
    for(const [address,authority] of [[registry.escrow,registry.config],[payments.feeVault,wallet.publicKey]]) {
      const token=await owned(address!,TOKEN_PROGRAM);assert.equal(token.length,165);assert.ok(token.subarray(0,32).equals(mint.toBuffer())&&token.subarray(32,64).equals(authority!.toBuffer()));
      assert.equal(token[108],1);assert.equal(token.readUInt32LE(72),0);assert.equal(token.readUInt32LE(129),0);
    }
    const balance=(await owned(registry.escrow,TOKEN_PROGRAM)).readBigUInt64LE(64);
    if(balance<funding) {
      assert.equal(balance,0n,'Unexpected partial escrow funding: refusing automatic top-up');
      const amount=Buffer.alloc(8);amount.writeBigUInt64LE(funding);
      await send('fund_escrow',new TransactionInstruction({programId:TOKEN_PROGRAM,keys:[{pubkey:ata,isSigner:false,isWritable:true},
        {pubkey:registry.escrow,isSigner:false,isWritable:true},{pubkey:wallet.publicKey,isSigner:true,isWritable:false}],data:Buffer.concat([Buffer.from([3]),amount])}));
    }
    assert.equal((await owned(registry.escrow,TOKEN_PROGRAM)).readBigUInt64LE(64),funding,'Escrow is not ready');
    const device=Buffer.from(manifest.device.device,'hex');
    if(!await connection.getAccountInfo(registry.device(device)))await send('device',registerDevice(program,wallet.publicKey,protocol,
      {deviceId:device,key:Buffer.from(manifest.device.key,'hex'),curve:1,capabilities:manifest.device.capabilities,externalAsset:null,claimedGeohash:null}));
    const record=decodeDevice(await owned(registry.device(device)));assert.equal(record.deviceId.toString('hex'),manifest.device.device);
    assert.equal(record.key.toString('hex'),manifest.device.key);assert.equal(record.curve,1);assert.equal(record.capabilities,manifest.device.capabilities);
    assert.ok(record.registeredAt>0n&&!record.linked&&record.externalAsset===null&&record.claimedGeohash===null);
    const root=Buffer.from(manifest.root.root,'hex');
    if(!await connection.getAccountInfo(registry.root(root)))await send('root',publishRoot(program,wallet.publicKey,root,manifest.root.leafCount));
    const published=decodeRoot(await owned(registry.root(root)));assert.ok(published.root.equals(root)&&published.authority.equals(wallet.publicKey)&&published.publishedAt>0n);assert.equal(published.leafCount,manifest.root.leafCount);
    assert.ok(activeRoots(decodeEnrollment(await owned(registry.enrollment))).some(r=>r.equals(root)),'Root is not active');
    if(!state.lookup) {
      state.lookupSlot=await connection.getSlot('finalized');
      const [create,address]=AddressLookupTableProgram.createLookupTable({authority:wallet.publicKey,payer:wallet.publicKey,recentSlot:state.lookupSlot});
      state.lookup=address.toBase58();await save();await send('lookup_create',create);
    }
    // Reuse journaled create instruction when interruption occurs between state save and send.
    const lookupAddress=new PublicKey(state.lookup);
    if(!await connection.getAccountInfo(lookupAddress)) {
      assert.ok(state.lookupSlot!==undefined,'Missing lookup creation slot');
      const [create,address]=AddressLookupTableProgram.createLookupTable({authority:wallet.publicKey,payer:wallet.publicKey,recentSlot:state.lookupSlot});
      assert.ok(address.equals(lookupAddress));await send('lookup_create',create);
    }
    const wanted=[registry.config,registry.escrow,registry.enrollment,registry.device(device),registry.root(root),info,payments.settings,payments.feeVault,mint,TOKEN_PROGRAM,SystemProgram.programId,new PublicKey('Sysvar1nstructions1111111111111111111111111')];
    const table=(await connection.getAddressLookupTable(lookupAddress,{commitment:'finalized'})).value;assert.ok(table&&table.state.authority?.equals(wallet.publicKey)&&table.state.deactivationSlot===0xffff_ffff_ffff_ffffn);
    const missing=wanted.filter(k=>!table.state.addresses.some(a=>a.equals(k)));
    if(missing.length)await send('lookup_extend',AddressLookupTableProgram.extendLookupTable({lookupTable:lookupAddress,authority:wallet.publicKey,payer:wallet.publicKey,addresses:missing}));
    const finalTable=(await connection.getAddressLookupTable(lookupAddress,{commitment:'finalized'})).value;assert.ok(finalTable&&wanted.every(k=>finalTable.state.addresses.some(a=>a.equals(k))));
    // A chain write can finalize between interruption and journal acknowledgement.
    for(const r of Object.values(state.transactions))if(!r.finalized) {
      const status=(await connection.getSignatureStatuses([r.signature],{searchTransactionHistory:true})).value[0];
      assert.ok(status?.confirmationStatus==='finalized'&&status.err===null,'Account state verified but a recorded signature is not finalized');r.finalized=true;
    }
    state.complete=true;
    console.log('PASS: finalized demo setup. Public report and private configuration are outside Git.');
  } finally {
    state.elapsedMs+=Date.now()-started;await save();
    const publicReport={version:1,developmentOnly:true,cluster:local?'local-validator':'devnet',genesis:expected,
      program:manifest.program,protocol:manifest.protocol,device:manifest.device.device,
      addresses:{registry:registry.config.toBase58(),device:registry.device(Buffer.from(manifest.device.device,'hex')).toBase58(),escrow:registry.escrow.toBase58(),enrollment:registry.enrollment.toBase58(),
        verifierMetadata:PublicKey.findProgramAddressSync([Buffer.from('observation-verifier')],program)[0].toBase58(),root:registry.root(Buffer.from(manifest.root.root,'hex')).toBase58(),feeVault:payments.feeVault.toBase58(),lookup:state.lookup??null},
      root:manifest.root,rewardMint:mint.toBase58(),policy:{version:1,grossBaseUnits:'50000',feeBps:2000,slotsPerEpoch:3,escrowBaseUnits:'150000'},
      artifacts:manifest.artifacts,binaryHash:manifest.binaryHash,programCapacityBytes:capacity,circuitKeyDigest:manifest.keyDigest,
      toolchain:{...manifest.tools,buildPlatformTools:'v1.57',architecture:'v3'},
      durationSeconds:(Date.now()-state.startedAt)/1000,activeRunSeconds:state.elapsedMs/1000,
      underTenMinutes:state.complete&&Date.now()-state.startedAt<600000,complete:state.complete,
      deployment:state.deploymentSignature ? {signature:state.deploymentSignature,explorer:local?null:`https://explorer.solana.com/tx/${state.deploymentSignature}?cluster=devnet`} : null,
      simulated:c.mode==='fixture'?['ESP32 identity','observer enrollment']:[],artifactCheck:'synthetic witness used only to check prover/verifier compatibility',
      remaining:['Real iPhone App Attest and BLE observation','Complete withdrawal flow (DEV-38)','Manual Apple provisioning and ESP32 flashing'],
      completedSetupSteps:Object.entries(state.transactions).filter(([,r])=>r.finalized).map(([name])=>name),
      remainingSetupSteps:state.complete?[]:['Inspect unfinished steps in the transaction journal and resume the same configuration'],
      transactions:Object.fromEntries(Object.entries(state.transactions).map(([name,r])=>[name,{signature:r.signature,finalized:r.finalized,explorer:local?null:`https://explorer.solana.com/tx/${r.signature}?cluster=devnet` }]))};
    // Verification-only reruns must not rewrite the original setup-duration evidence.
    if(!previouslyComplete)await atomic(path.join(folder,'report.json'),publicReport);
    await atomic(path.join(folder,'verifier-config.json'),{PATHNOD_OBSERVATION_RPC_URL:c.rpc,PATHNOD_OBSERVATION_GENESIS:expected,PATHNOD_OBSERVATION_PROGRAM_ID:manifest.program,
      PATHNOD_OBSERVATION_PROTOCOL_ID:manifest.protocol,PATHNOD_OBSERVATION_POLICY_VERSION:'1',PATHNOD_OBSERVATION_VK:c.verificationKey,PATHNOD_OBSERVATION_VK_SHA256:manifest.artifacts.verificationKey,
      PATHNOD_OBSERVATION_VERIFIER_SIGNER:path.join(folder,'verifier.json'),PATHNOD_OBSERVATION_RELAYER_PAYER:c.wallet,PATHNOD_OBSERVATION_LOOKUP_TABLE:state.lookup,
      PATHNOD_ROOT_RPC_URL:c.rpc,PATHNOD_ROOT_PROGRAM_ID:manifest.program,PATHNOD_ROOT_SIGNER:c.wallet,
      PATHNOD_ELIGIBILITY_RPC_URL:c.rpc,PATHNOD_ELIGIBILITY_PROGRAM_ID:manifest.program,PATHNOD_ELIGIBILITY_PROTOCOL_ID:manifest.protocol,
      PATHNOD_ELIGIBILITY_REWARD_MINT:mint.toBase58(),PATHNOD_ENROLLMENT_DB:runtimeDatabase,
      requiredManual:['PATHNOD_APP_ATTEST_APP_ID','PATHNOD_APP_ATTEST_ENVIRONMENT','PATHNOD_APP_ATTEST_CATEGORIES','iPhone reachable HTTPS verifier URL'],
      ios:{program:manifest.program,protocol:manifest.protocol,proverWASM:c.wasm,proverZkey:c.zkey}});
  }
}
async function main() {
  const args=process.argv.slice(2).filter(a=>a!=='--');
  assert.ok(args[0]==='--config'&&args[1]&&args.length<=3&&(!args[2]||['--prepare','--check','--import-enrollment'].includes(args[2])),
    'Usage: --config /external/config.json [--prepare|--check|--import-enrollment]');
  const configPath=await externalFile(args[1]!,repo), raw=await readFile(configPath), c=JSON.parse(raw.toString()) as Config;
  assert.ok(c.version===1&&/^[a-z0-9][a-z0-9-]{2,63}$/.test(c.freshRun)&&['fixture','hardware'].includes(c.mode),'Set an explicit unique freshRun and mode');
  demoTarget(c.rpc,c.localValidator,c.genesis);
  assert.ok(path.isAbsolute(c.stateDirectory));await mkdir(c.stateDirectory,{recursive:true,mode:0o700});
  const folder=await externalFile(c.stateDirectory,repo);assert.ok(!within(folder,repo)&&folder!==path.parse(folder).root,'Use a dedicated external state directory');
  assert.equal((await stat(folder)).mode&0o077,0,'State directory permissions must be 700');
  const lock=path.join(folder,'run.lock');const handle=await open(lock,'wx',0o600).catch(()=>{throw Error('Demo state is locked; stop the other run, or inspect/remove its stale run.lock explicitly');});
  try {
    await handle.writeFile(String(process.pid));
    if(args[2]==='--prepare') {
      const unrelated=(await readdir(folder)).filter(name=>name!=='run.lock'&&path.join(folder,name)!==configPath);
      assert.equal(unrelated.length,0,'Use a dedicated empty preparation directory; existing files will not be overwritten');
      await prepare(c,folder,digest(raw));
    } else if(args[2]==='--import-enrollment') {
      const manifest:Manifest=await json(path.join(folder,'manifest.json'));
      assert.equal(manifest.version,1);assert.equal(manifest.configDigest,digest(raw),'Use the original prepared configuration');
      await prepareRuntime(c,folder,{device:manifest.device,root:manifest.root});
      console.log('Private runtime import complete; source preserved, no chain writes. Run make demo with the same DEMO_CONFIG.');
    } else await run(c,folder,digest(raw),args[2]==='--check');
  } finally {await handle.close();await unlink(lock);}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Demo failed');process.exitCode=1;});
