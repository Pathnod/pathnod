import assert from 'node:assert/strict';
import {createHash,createPrivateKey,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ComputeBudgetProgram,Connection,Keypair,PublicKey,SystemProgram,Transaction,TransactionInstruction} from '@solana/web3.js';
import {TOKEN_PROGRAM,UPGRADEABLE_LOADER,decodeDeviceEpoch,decodeObservationCommitment,decodeObservationVerifier,deviceId,discriminator,
  initProtocol,initializeEnrollmentAuthority,initializeObservationVerifier,publishRoot,registerDevice,registryAddresses,observationAddresses,
  appendObservationTree,DEFAULT_OBSERVATION_KEY_DIGEST} from '@pathnod/solana';
import {AppAttestGate} from '../src/app-attest-gate.ts';
import {ObserverEnrollmentService} from '../src/observer-enrollment.ts';
import {FakeEnrollmentGate} from '../tests/helpers/enrollment-gate.ts';
import {ObservationPolicyService,deviceChallengeDigest} from '../src/observation-policy.ts';
import {PinnedGroth16Verifier} from '../src/observation-groth16.ts';
import {SolanaObservationPolicySource} from '../src/observation-solana.ts';
import {ObservationSigner,authorizationInstruction,relayProofBytes} from '../src/observation-authorization.ts';
import {ObservationRelayer,type ObservationRelayPayload} from '../src/observation-relay.ts';
import {SolanaObservationRelayTransport} from '../src/solana-observation-relay.ts';
import {PathnodObservationSubmissionAdapter} from '../src/observation-adapter.ts';
import {decodeObservationTranscript,encodeObservationTranscript,observationTranscriptHash} from '../src/observation-transcript.ts';
import type {ObservationEnvelope} from '../src/observation-inbox.ts';

const root=fileURLToPath(new URL('../../..',import.meta.url));
const args=new Map<string,string>();
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i]!,value=process.argv[i+1];
  if(!['--rpc','--wallet','--program','--database','--report'].includes(key)||!value||args.has(key))throw Error('Usage: observations:verify --rpc URL --wallet KEYPAIR --program ID --database FILE --report FILE');args.set(key,value);}
const required=(key:string)=>{const value=args.get(key);if(!value)throw Error(`Missing ${key}`);return value;};
const raw=(hex:string)=>Buffer.from(hex.replace(/^0x/,''),'hex');
const hash=(...parts:Uint8Array[])=>createHash('sha256').update(Buffer.concat(parts)).digest();
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function outside(file:string){const resolved=path.resolve(file),relative=path.relative(root,resolved);assert.ok(relative.startsWith('../')||path.isAbsolute(relative),'Keep test data outside Git');return resolved;}
async function main(){
  const rpc=new URL(required('--rpc')),local=['localhost','127.0.0.1','[::1]'].includes(rpc.hostname);
  assert.ok(local||rpc.href==='https://api.devnet.solana.com/','Only local validator or official devnet');
  const dbPath=outside(required('--database')),reportPath=outside(required('--report'));
  await mkdir(path.dirname(dbPath),{recursive:true,mode:0o700});
  const connection=new Connection(rpc.href,{commitment:'confirmed',disableRetryOnRateLimit:true});
  const genesis=await connection.getGenesisHash();if(!local)assert.equal(genesis,'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  const wallet=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(required('--wallet'),'utf8'))));
  const program=new PublicKey(required('--program'));assert.notEqual(program.toBase58(),'5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd','Use a disposable deployment');
  const executable=await connection.getAccountInfo(program);
  assert.ok(executable?.executable&&executable.owner.equals(UPGRADEABLE_LOADER),'Deploy the disposable test program first');
  const payer=Keypair.generate(),other=Keypair.generate(),verifierKey=Keypair.generate();
  const signer=new ObservationSigner(verifierKey.secretKey.subarray(0,32));
  const transactions:{name:string;signature:string;bytes:number;units:number|null|undefined}[]=[];
  async function prepared(instructions:TransactionInstruction[],signers:Keypair[]=[wallet]){
    const transaction=new Transaction({feePayer:signers[0]!.publicKey,...await connection.getLatestBlockhash('confirmed')}).add(...instructions);
    transaction.sign(...signers);assert.ok(transaction.serialize().length<=1232,'Transaction size limit');return transaction;
  }
  async function send(name:string,instructions:TransactionInstruction[],signers:Keypair[]=[wallet]){
    const transaction=await prepared(instructions,signers);
    const signature=await connection.sendRawTransaction(transaction.serialize(),{skipPreflight:false,maxRetries:0,preflightCommitment:'confirmed'});
    await connection.confirmTransaction({signature,blockhash:transaction.recentBlockhash!,lastValidBlockHeight:transaction.lastValidBlockHeight!},'finalized');
    const executed=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
    assert.ok(executed?.meta);assert.equal(executed.meta.err,null);
    transactions.push({name,signature,bytes:transaction.serialize().length,units:executed.meta.computeUnitsConsumed});return signature;
  }
  const fieldFixtures=JSON.parse(await readFile(path.join(root,'fixtures/observations/transcript-v0.json'),'utf8'));
  const fixture=fieldFixtures.vectors[0];
  const proofs=JSON.parse(await readFile(path.join(root,'fixtures/observations/dev35-proofs.json'),'utf8')) as {
    publicTestVectors:boolean;vectors:{secret:string;commitment:string;public:string[];proof:ObservationEnvelope['zk']['proof'];proofBytes:string}[]};
  assert.equal(proofs.publicTestVectors,true);
  const protocol=raw(fixture.transcript.protocolID),key=raw(fixture.transcript.publicKey),device=deviceId(key);
  const addresses=registryAddresses(program,protocol);
  assert.equal(await connection.getAccountInfo(addresses.config),null,'Use a fresh program/test database');
  await send('fund_relayers',[SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:payer.publicKey,lamports:100_000_000}),SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:other.publicKey,lamports:100_000_000})]);
  let mint=new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  if(local){const created=Keypair.generate();mint=created.publicKey;await send('create_mint',[
    SystemProgram.createAccount({fromPubkey:wallet.publicKey,newAccountPubkey:mint,space:82,lamports:await connection.getMinimumBalanceForRentExemption(82),programId:TOKEN_PROGRAM}),
    new TransactionInstruction({programId:TOKEN_PROGRAM,keys:[{pubkey:mint,isSigner:false,isWritable:true}],data:Buffer.concat([Buffer.from([20,6]),wallet.publicKey.toBuffer(),Buffer.from([0])])})],[wallet,created]);}
  await send('initialize_enrollment_authority',[initializeEnrollmentAuthority(program,wallet.publicKey,wallet.publicKey)]);
  await send('initialize_observation_verifier',[initializeObservationVerifier(program,wallet.publicKey)]);
  const info=observationAddresses(program,protocol,device,42,raw(fixture.transcript.nullifier)).verifierInfo;
  assert.equal(decodeObservationVerifier((await connection.getAccountInfo(info))!.data).keyDigest,DEFAULT_OBSERVATION_KEY_DIGEST);
  const slot=await connection.getSlot('finalized'),time=await connection.getBlockTime(slot);assert.ok(time);
  // The public proofs use epoch 42; the configured duration makes it the current real-chain epoch.
  const epochSeconds=Math.floor(time/42);
  await send('init_protocol',[initProtocol(program,wallet.publicKey,mint,{protocolId:protocol,epochSeconds,verifier:verifierKey.publicKey,policyVersion:1,rewardPerSlot:0n,slotsPerEpoch:0})]);
  await send('register_device',[registerDevice(program,wallet.publicKey,protocol,{deviceId:device,key,curve:1,capabilities:2,externalAsset:null,claimedGeohash:null})]);
  const appPolicy={appID:'TESTTEAM01.xyz.pathnod.dev35.synthetic',environment:'development',allowedValidationCategories:[3],allowedBundleVersions:[]} as const;
  const gate=new AppAttestGate(dbPath,appPolicy),fake=new FakeEnrollmentGate(),enrollment=await ObserverEnrollmentService.open(dbPath,fake);
  const db=new DatabaseSync(dbPath);
  const observerKeys=proofs.vectors.map(()=>({id:randomBytes(32).toString('base64'),pair:generateKeyPairSync('ec',{namedCurve:'prime256v1'})}));
  for(let i=0;i<proofs.vectors.length;i++){
    const vector=proofs.vectors[i]!,observer=observerKeys[i]!,commitment=BigInt(vector.commitment).toString(16).padStart(64,'0');
    const challenge=enrollment.issueEnrollmentChallenge('0x'+commitment,observer.id);
    const path=enrollment.enroll(challenge.id,'0x'+commitment,observer.id,Buffer.from([42]));
    assert.equal(BigInt(path.root).toString(),vector.public[0]);
    db.prepare("INSERT INTO app_attest_keys VALUES (?, ?, ?, 'development', 0, NULL, NULL)").run(observer.id,observer.pair.publicKey.export({format:'pem',type:'spki'}).toString(),appPolicy.appID);
    await send(`publish_root_${i}`,[publishRoot(program,wallet.publicKey,raw(path.root),i+1)]);
  }
  const vkPath=path.join(root,'fixtures/observations/dev35-verification-key.json'),vkBytes=await readFile(vkPath);
  const proofVerifier=new PinnedGroth16Verifier(vkPath,createHash('sha256').update(vkBytes).digest('hex'));
  const source=await SolanaObservationPolicySource.open(rpc.href,program.toBase58(),protocol.toString('hex'),-90,1,genesis,proofVerifier.keyDigest);
  const service=new ObservationPolicyService(dbPath,appPolicy,source,proofVerifier,{relay:{signer}});
  const adapter=new PathnodObservationSubmissionAdapter(proofVerifier.keyDigest);
  const transport=await SolanaObservationRelayTransport.open(rpc.href,program.toBase58(),protocol.toString('hex'),payer,signer.publicKey,adapter,genesis);
  let worker=new ObservationRelayer(dbPath,source.target,signer.publicKey,transport);
  const devicePrivate=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),createHash('sha256').update('Pathnod/DEV31/public-device-seed/0').digest()]),format:'der',type:'pkcs8'});
  const cbor=(value:string|Buffer|Map<string,Buffer>):Buffer=>{
    const head=(major:number,n:number)=>n<24?Buffer.from([major*32+n]):Buffer.from([major*32+24,n]);
    if(typeof value==='string'){const bytes=Buffer.from(value);return Buffer.concat([head(3,bytes.length),bytes]);}
    if(Buffer.isBuffer(value))return Buffer.concat([head(2,value.length),value]);
    return Buffer.concat([head(5,value.size),...[...value].flatMap(([k,v])=>[cbor(k),cbor(v)])]);};
  const bodies:ObservationEnvelope[]=[],payloads:ObservationRelayPayload[]=[];
  let frontier:Buffer[]=Array.from({length:16},()=>Buffer.alloc(32));let expectedRoot:Buffer=Buffer.alloc(32);
  async function reject(name:string,instructions:TransactionInstruction[],code:number){
    const transaction=await prepared(instructions,[payer]);const simulation=await connection.simulateTransaction(transaction);
    const error=simulation.value.err as {InstructionError?:[number,{Custom?:number}]}|null;
    assert.equal(error?.InstructionError?.[1]?.Custom,code,`${name}: ${JSON.stringify(simulation.value.logs)}`);
    console.log(`Rejected ${name}: ${code}`);
  }
  try{
    for(let i=0;i<proofs.vectors.length;i++){
      const vector=proofs.vectors[i]!,observer=observerKeys[i]!,t=decodeObservationTranscript(raw(fixture.bytes));
      t.observationTimeMilliseconds=BigInt(Date.now());t.pseudonym=Buffer.from(BigInt(vector.public[5]!).toString(16).padStart(64,'0'),'hex');
      t.nullifier=Buffer.from(BigInt(vector.public[4]!).toString(16).padStart(64,'0'),'hex');
      const evidence=i===1?Buffer.from('public DEV-35 service evidence'):undefined;t.evidenceHash=evidence?hash(evidence):Buffer.alloc(32);
      t.challenges.forEach((entry,j)=>{entry.nonce=createHash('sha256').update(`Pathnod/DEV35/test/${i}/${j}`).digest();entry.deviceCounter=i*3+j+1;
        entry.signature=sign(null,deviceChallengeDigest(t,entry),devicePrivate);});
      const encoded=encodeObservationTranscript(t),transcriptHash=observationTranscriptHash(t),counter=Buffer.alloc(4);counter.writeUInt32BE(1);
      const auth=Buffer.concat([hash(Buffer.from(appPolicy.appID)),Buffer.from([0]),counter]);
      const assertion=cbor(new Map([['signature',sign('sha256',hash(auth,transcriptHash),observer.pair.privateKey)],['authenticatorData',auth]]));
      const body:ObservationEnvelope={transcript:encoded.toString('base64'),assertion:assertion.toString('base64'),key_id:observer.id,zk:{proof:vector.proof,public:vector.public},...(evidence?{evidence:evidence.toString('base64')}:{})};
      const receipt=await service.receive(body);assert.equal(receipt.policy_validated,true);bodies.push(body);
      const row=db.prepare('SELECT payload FROM observation_relay_jobs WHERE transcript_hash=?').get(receipt.transcript_hash)!;
      const payload=JSON.parse(String(row.payload)) as ObservationRelayPayload;payloads.push(payload);
      const valid=[ComputeBudgetProgram.setComputeUnitLimit({units:299999}),authorizationInstruction(payload,payload.verifier,payload.verifierSignature),adapter.instruction(program,payer.publicKey,payload)];
      if(i===0){
        const changedHash={...payload,transcriptHash:'aa'.repeat(32)};
        await reject('altered transcript hash',[valid[0]!,valid[1]!,adapter.instruction(program,payer.publicKey,changedHash)],6112);
        await reject('missing Ed25519 instruction',[valid[0]!,valid[2]!],6112);
        await reject('wrong previous instruction',[valid[1]!,valid[0]!,valid[2]!],6112);
        const badProof=Buffer.from(payload.proofBytes,'hex');badProof.fill(0,192,256);
        await reject('corrupted Groth16 C',[valid[0]!,valid[1]!,adapter.instruction(program,payer.publicKey,{...payload,proofBytes:badProof.toString('hex')})],6000);
        const badEvidence={...payload,evidenceHash:'11'.repeat(32)};
        await reject('unsigned evidence hash',[valid[0]!,valid[1]!,adapter.instruction(program,payer.publicKey,badEvidence)],6112);
        const simulated=await connection.simulateTransaction(await prepared(valid,[payer]));
        assert.equal(simulated.value.err,null,JSON.stringify(simulated.value.logs));assert.ok((simulated.value.unitsConsumed??300000)<300000);
        console.log(`First complete observation: ${(await prepared(valid,[payer])).serialize().length} bytes, ${simulated.value.unitsConsumed} CU`);
        const lost={...transport,target:transport.target,eligible:transport.eligible.bind(transport),prepare:transport.prepare.bind(transport),inspect:transport.inspect.bind(transport),expired:transport.expired.bind(transport),confirmExisting:transport.confirmExisting.bind(transport),
          send:async(transaction:Parameters<typeof transport.send>[0])=>{await transport.send(transaction);throw Error('Injected lost RPC response after send');}};
        await worker.close();worker=new ObservationRelayer(dbPath,source.target,signer.publicKey,lost);
        await worker.tick();assert.equal(worker.status(receipt.transcript_hash)?.status,'submitted');await worker.close();
        worker=new ObservationRelayer(dbPath,source.target,signer.publicKey,transport);
      }else{
        // An independent relayer submits the same authorized job; this worker must reconcile the real commitment.
        await send('external_submit',[ComputeBudgetProgram.setComputeUnitLimit({units:299999}),valid[1]!,adapter.instruction(program,other.publicKey,payload)],[other]);
      }
      for(let attempt=0;attempt<40;attempt++){await sleep(1000);await worker.tick();if(worker.status(receipt.transcript_hash)?.status==='confirmed')break;}
      assert.equal(worker.status(receipt.transcript_hash)?.status,'confirmed');assert.equal(worker.status(receipt.transcript_hash)?.on_chain,true);
      const record=await connection.getAccountInfo(observationAddresses(program,protocol,device,42,raw(payload.nullifier)).commitment,'finalized');
      assert.ok(record);assert.ok(record.owner.equals(program));assert.equal(decodeObservationCommitment(record.data).transcriptHash.toString('hex'),payload.transcriptHash);
      const state=decodeDeviceEpoch((await connection.getAccountInfo(addresses.epoch(device,42),'finalized'))!.data);
      const next=appendObservationTree(frontier,i,raw(payload.transcriptHash));frontier=next.frontier;expectedRoot=next.root;
      assert.equal(state.independentObservers,i+1);assert.equal(state.paidSlotsUsed,0);assert.ok(state.observationRoot.equals(expectedRoot));
      await reject('duplicate nullifier',valid,6001);
      const unchanged=decodeDeviceEpoch((await connection.getAccountInfo(addresses.epoch(device,42),'finalized'))!.data);
      assert.equal(unchanged.independentObservers,i+1);assert.ok(unchanged.observationRoot.equals(expectedRoot));
      assert.deepEqual(await service.receive(body),receipt);assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM observation_relay_jobs').get()!.n),i+1);
    }
    const signature=worker.status(payloads[0]!.transcriptHash)?.signature;
    if(typeof signature==='string'){const executed=await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
      assert.ok(executed?.meta);assert.equal(executed.meta.err,null);assert.ok((executed.meta.computeUnitsConsumed??300000)<300000);
      transactions.push({name:'worker_submit',signature,bytes:1207,units:executed.meta.computeUnitsConsumed});}
    const report={publicSyntheticTests:true,genesis,program:program.toBase58(),protocol:protocol.toString('hex'),device:device.toString('hex'),verificationKeyDigest:proofVerifier.keyDigest,
      observers:2,independentObservers:2,paidSlotsUsed:0,packetBytes:1207,transactions,lostResponseRestart:true,externalSubmissionReconciled:true,duplicatesRejected:true,signatureV1Evidence:true};
    await mkdir(path.dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
  }finally{await worker.close();service.close();db.close();enrollment.close();gate.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
