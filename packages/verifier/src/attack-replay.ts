import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ComputeBudgetProgram, MessageV0, VersionedTransaction } from '@solana/web3.js';
import { AppAttestGate } from './app-attest-gate.ts';
import { observationAccountingSnapshot, sameGate2Accounting, nullifierRejection } from './gate2-evidence.ts';
import { recoverGate2Replay, writeGate2Artifact, type Gate2ReplayJournal } from './gate2-recovery.ts';
import { authorizationInstruction, verifyAuthorization } from './observation-authorization.ts';
import { signatureBase58, type SolanaObservationRelayTransport } from './solana-observation-relay.ts';
import type { ObservationRelayPayload } from './observation-relay.ts';
import { DEVNET_GENESIS, externalFile, demoTarget } from './demo-safety.ts';

export class AttackReplayError extends Error {
  readonly code: 'invalid_demo_request' | 'demo_owner_required' | 'demo_busy' | 'demo_replay_unconfirmed';
  constructor(code: AttackReplayError['code']) {
    super(code);this.code=code;
  }
}
type Transport = Pick<SolanaObservationRelayTransport, 'target' | 'connection' | 'program' | 'protocol' |
  'payer' | 'verifier' | 'adapter' | 'prepare'>;
export interface AttackReplayStatus {
  transcript_hash: string;
  status: 'not_started' | 'running' | 'submitted' | 'rejected' | 'needs_inspection';
  network: 'devnet';
  transaction_signature?: string;
  error?: string;
  unchanged?: boolean;
  independent_observers?: number;
  paid_slots_used?: number;
}

export class AttackReplayDemo {
  readonly #db: DatabaseSync;
  readonly #gate: AppAttestGate;
  readonly #transport: Transport;
  readonly #directory: string;
  readonly #policyTarget: string;
  readonly #running = new Map<string, Promise<void>>();
  readonly #errors = new Set<string>();
  readonly #snapshot: typeof observationAccountingSnapshot;

  private constructor(database: string, gate: AppAttestGate, transport: Transport, directory: string,
    policyTarget: string, snapshot: typeof observationAccountingSnapshot) {
    this.#db = new DatabaseSync(database); this.#gate = gate; this.#transport = transport;
    this.#directory = directory; this.#policyTarget = policyTarget; this.#snapshot = snapshot;
    assert.equal(this.#db.prepare('SELECT target FROM observation_policy_target WHERE id=1').get()?.target, policyTarget);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS attack_demo_target_v0 (id INTEGER PRIMARY KEY CHECK(id=1), target TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attack_demo_challenges_v0 (id TEXT PRIMARY KEY, hash TEXT NOT NULL, key_id TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
    this.#db.prepare('INSERT OR IGNORE INTO attack_demo_target_v0 VALUES (1,?)').run(transport.target);
    assert.equal(this.#db.prepare('SELECT target FROM attack_demo_target_v0 WHERE id=1').get()?.target, transport.target);
  }

  static async open(database: string, gate: AppAttestGate, transport: Transport, directory: string,
    policyTarget: string, snapshot = observationAccountingSnapshot) {
    assert.ok(transport.target.startsWith(DEVNET_GENESIS + '/'), 'Attack demonstration requires official devnet');
    assert.equal(demoTarget(transport.connection.rpcEndpoint).expected,DEVNET_GENESIS);
    assert.ok(path.isAbsolute(directory));
    await mkdir(directory, {recursive:true, mode:0o700});
    const resolved = await externalFile(directory, fileURLToPath(new URL('../../..', import.meta.url)));
    assert.equal((await stat(resolved)).mode & 0o077, 0, 'Attack journal directory must have permissions 700');
    return new AttackReplayDemo(database, gate, transport, resolved, policyTarget, snapshot);
  }

  #payload(hash: string, keyID?: string): ObservationRelayPayload {
    assert.equal(this.#db.prepare('SELECT target FROM observation_policy_target WHERE id=1').get()?.target,this.#policyTarget);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new AttackReplayError('invalid_demo_request');
    const row = this.#db.prepare('SELECT payload,status FROM observation_relay_jobs WHERE transcript_hash=?').get(hash);
    if (!row || row.status !== 'confirmed') throw new AttackReplayError('invalid_demo_request');
    const payload = JSON.parse(String(row.payload)) as ObservationRelayPayload;
    if (payload.transcriptHash !== hash || payload.protocolID !== this.#transport.protocol.toString('hex') ||
      payload.verifier !== this.#transport.verifier || !verifyAuthorization(payload, payload.verifier, payload.verifierSignature))
      throw new AttackReplayError('invalid_demo_request');
    if (keyID !== undefined) {
      const scope = this.#transport.target.split('/').slice(0,3).join('/');
      const owner = this.#db.prepare(`SELECT k.key_id FROM app_attest_keys k JOIN observer_enrollments e USING(key_id)
        JOIN observation_payout_owners_v0 o USING(key_id) LEFT JOIN observer_revocations_v0 r USING(key_id)
        WHERE k.key_id=? AND e.observer_class=1 AND r.key_id IS NULL AND o.protocol=? AND o.pseudonym=?`).get(keyID, scope, payload.pseudonym);
      if (!owner || !this.#gate.getKey(keyID)) throw new AttackReplayError('demo_owner_required');
    }
    return payload;
  }

  challenge(hash: string, keyID: string) {
    this.#payload(hash, keyID);
    this.#db.prepare('DELETE FROM attack_demo_challenges_v0 WHERE expires_at<=?').run(Date.now());
    if (Number(this.#db.prepare('SELECT count(*) AS n FROM attack_demo_challenges_v0').get()!.n) >= 32)
      throw new AttackReplayError('demo_busy');
    const challenge = this.#gate.issueChallenge('assertion', keyID);
    this.#db.prepare('INSERT INTO attack_demo_challenges_v0 VALUES (?,?,?,?)').run(challenge.id, hash, keyID, challenge.expiresAt);
    return {id:challenge.id, challenge:challenge.bytes.toString('base64'), expiresAt:challenge.expiresAt, transcript_hash:hash};
  }

  async replay(hash: string, keyID: string, challengeID: string, assertion: Buffer) {
    if (assertion.length<1 || assertion.length>16384)throw new AttackReplayError('invalid_demo_request');
    const payload = this.#payload(hash, keyID);
    const challenge = this.#db.prepare('SELECT * FROM attack_demo_challenges_v0 WHERE id=?').get(challengeID);
    if (!challenge || challenge.hash !== hash || challenge.key_id !== keyID || Number(challenge.expires_at) <= Date.now())
      throw new AttackReplayError('demo_owner_required');
    if (!this.#running.has(hash) && this.#running.size >= 1) throw new AttackReplayError('demo_busy');
    this.#db.prepare('DELETE FROM attack_demo_challenges_v0 WHERE id=?').run(challengeID);
    try {this.#gate.acceptAssertion(challengeID, keyID, assertion);}
    catch {throw new AttackReplayError('demo_owner_required');}
    if (!this.#running.has(hash)) {
      this.#errors.delete(hash);
      const job = this.#run(payload).catch(() => {this.#errors.add(hash);}).finally(() => {this.#running.delete(hash);});
      this.#running.set(hash, job);
    }
    return this.status(hash);
  }

  async status(hash: string): Promise<AttackReplayStatus> {
    this.#payload(hash);
    const base = {transcript_hash:hash, network:'devnet' as const};
    const journal = await this.#load(hash);
    if (this.#errors.has(hash)) return {...base,status:'needs_inspection',error:'demo_replay_unconfirmed',
      ...(journal ? {transaction_signature:journal.signature} : {})};
    if (!journal) return {...base,status:this.#running.has(hash)?'running':'not_started'};
    if (journal.state === 'rejected' && journal.after) {
      await this.#validateWire(journal,this.#payload(hash));
      const status=(await this.#transport.connection.getSignatureStatuses([journal.signature],{searchTransactionHistory:true})).value[0];
      if(status?.confirmationStatus!=='finalized'||!nullifierRejection(status.err)||
        (status.err as {InstructionError:[number,unknown]}).InstructionError[0]!==2||!sameGate2Accounting(journal.before,journal.after))
        return {...base,status:'needs_inspection',transaction_signature:journal.signature,error:'demo_replay_unconfirmed'};
      return {...base,status:'rejected',error:'E_NULLIFIER',unchanged:true,
        transaction_signature:journal.signature,independent_observers:journal.after.independentObservers,paid_slots_used:journal.after.paidSlotsUsed};
    }
    return {...base,status:'submitted',transaction_signature:journal.signature};
  }

  #file(hash: string) {return path.join(this.#directory, hash + '.json');}
  async #load(hash: string): Promise<Gate2ReplayJournal | undefined> {
    try {
      const file=this.#file(hash), info=await stat(file);
      assert.ok(info.isFile() && (info.mode & 0o077) === 0 && info.size <= 32768);
      const journal=JSON.parse(await readFile(file,'utf8')) as Gate2ReplayJournal;
      assert.equal(journal.version,1);assert.equal(journal.hash,hash);assert.equal(journal.target,this.#transport.target);
      assert.ok(['prepared','submitted','rejected'].includes(journal.state));
      return journal;
    } catch(error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;throw error;}
  }

  async #run(payload: ObservationRelayPayload) {
    const t=this.#transport, file=this.#file(payload.transcriptHash);
    let journal=await this.#load(payload.transcriptHash);
    if (!journal) {
      const before=await this.#snapshot(t.connection,t.program,payload);
      const prepared=await t.prepare(payload);
      journal={version:1,target:t.target,hash:payload.transcriptHash,...prepared,before,state:'prepared'};
      await writeGate2Artifact(file,journal);
    }
    await this.#validateWire(journal,payload);
    await recoverGate2Replay(journal, {
      inspect:async signature=>(await t.connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0]??null,
      blockHeight:()=>t.connection.getBlockHeight('finalized'),
      send:wire=>t.connection.sendRawTransaction(wire,{skipPreflight:true,maxRetries:0}),
      save:value=>writeGate2Artifact(file,value),
      snapshot:()=>this.#snapshot(t.connection,t.program,payload),
    });
  }

  async #validateWire(journal: Gate2ReplayJournal,payload: ObservationRelayPayload) {
    const t=this.#transport, wire=Buffer.from(journal.wire,'base64'), tx=VersionedTransaction.deserialize(wire);
    assert.ok(wire.length<=1232 && tx.message instanceof MessageV0);
    assert.equal(tx.signatures.length,1);assert.equal(tx.message.header.numRequiredSignatures,1);
    assert.ok(tx.message.staticAccountKeys[0]!.equals(t.payer.publicKey));
    assert.equal(signatureBase58(tx.signatures[0]!),journal.signature);
    const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),t.payer.publicKey.toBuffer()]),format:'der',type:'spki'});
    assert.ok(verify(null,tx.message.serialize(),key,tx.signatures[0]!));
    const tables=await Promise.all(tx.message.addressTableLookups.map(async lookup=>{
      const table=(await t.connection.getAddressLookupTable(lookup.accountKey,{commitment:'finalized'})).value;
      assert.ok(table && table.key.toBase58()===t.target.split('/').at(-1) && table.state.deactivationSlot===0xffff_ffff_ffff_ffffn);return table;
    }));
    const keys=tx.message.getAccountKeys({addressLookupTableAccounts:tables});
    const expected=[ComputeBudgetProgram.setComputeUnitLimit({units:299999}),
      authorizationInstruction(payload,payload.verifier,payload.verifierSignature),t.adapter.instruction(t.program,t.payer.publicKey,payload)];
    assert.equal(tx.message.compiledInstructions.length,expected.length);
    for (const [i,ix] of expected.entries()) {
      const actual: {programIdIndex:number;accountKeyIndexes:number[];data:Uint8Array}=tx.message.compiledInstructions[i]!;
      assert.ok(keys.get(actual.programIdIndex)?.equals(ix.programId));assert.ok(Buffer.from(actual.data).equals(ix.data));
      assert.equal(actual.accountKeyIndexes.length,ix.keys.length);
      actual.accountKeyIndexes.forEach((index,j)=>{assert.ok(keys.get(index)?.equals(ix.keys[j]!.pubkey));});
    }
  }

  async close() {await Promise.all(this.#running.values());this.#db.close();}
}
