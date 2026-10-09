import { createHash } from 'node:crypto';
import { PublicKey, type Connection, type AccountInfo } from '@solana/web3.js';
import { decodeProtocol, decodeDevice, decodeDeviceEpoch, decodeObservationCommitment,
  registryAddresses, observationAddresses, discriminator, UPGRADEABLE_LOADER } from '@pathnod/solana';
import { confidenceCommitment, canonicalConfidenceBytes, CONFIDENCE_POLICY_V0 } from '@pathnod/verifier';
import type { DashboardConfig } from './config.ts';

export type Reader = Pick<Connection, 'getGenesisHash' | 'getAccountInfo' | 'getMultipleAccountsInfo' | 'getProgramAccounts'>;
export class DashboardService {
  readonly config: DashboardConfig;
  readonly reader: Reader;
  readonly fetcher: typeof fetch;
  constructor(config: DashboardConfig, reader: Reader, fetcher: typeof fetch = fetch) {
    this.config=config;this.reader=reader;this.fetcher=fetcher;
  }
  context() { return { network: this.config.network, genesis: this.config.genesis,
    program: this.config.program.toBase58(), protocolID: this.config.protocol.toString('hex'),
    mode: 'live', queryLimit: 1000, readOnly: true }; }
  async target() {
    if (await this.reader.getGenesisHash() !== this.config.genesis) throw Error('Deployment mismatch');
    const a = registryAddresses(this.config.program,this.config.protocol);
    const rows = await this.reader.getMultipleAccountsInfo([this.config.program,a.config],'finalized');
    const deployed = rows[0];
    if (!deployed?.executable || !deployed.owner.equals(UPGRADEABLE_LOADER)) throw Error('Untrusted deployment');
    const policy = decodeProtocol(this.trusted(rows[1]));
    if (!policy.protocolId.equals(this.config.protocol) || !policy.escrow.equals(a.escrow)) throw Error('Protocol mismatch');
    return policy;
  }
  trusted(row: AccountInfo<Buffer> | null | undefined) {
    if (!row || row.executable || !row.owner.equals(this.config.program)) throw Error('Untrusted account');
    return row.data;
  }
  device(data: Buffer, address: PublicKey) {
    const d = decodeDevice(data);
    if (!registryAddresses(this.config.program,this.config.protocol).device(d.deviceId).equals(address) ||
        !createHash('sha256').update('Pathnod/device/v0').update(d.key).digest().equals(d.deviceId) || d.curve !== 1) return undefined;
    return { id: d.deviceId.toString('hex'), key: d.key.toString('hex'), address: address.toBase58(),
      capabilities: d.capabilities, declaredLocation: d.claimedGeohash };
  }
  async devices(offset: number) {
    const policy = await this.target();
    // DeviceRegistry has no protocol field: select by exact protocol-scoped PDA.
    const rows = await this.reader.getProgramAccounts(this.config.program,{commitment:'finalized',filters:[{dataSize:126}]});
    if (rows.length > 1000) throw Error('Global device scan exceeds 1000 records; no partial list returned');
    const devices = rows.filter(r=>r.account.data.subarray(0,8).equals(discriminator('account','DeviceRegistry')))
      .map(r=>this.device(this.trusted(r.account),r.pubkey)).filter(d=>d!==undefined).sort((a,b)=>a.id.localeCompare(b.id));
    return { ...this.context(), policyVersion: policy.policyVersion, currentEpoch: Math.floor(Date.now()/1000/policy.epochSeconds),
      total: devices.length, offset, limit: 25, devices: devices.slice(offset,offset+25) };
  }
  async detail(id: string, epoch: number) {
    const policy = await this.target();
    const a = observationAddresses(this.config.program,this.config.protocol,Buffer.from(id,'hex'),epoch,Buffer.alloc(32));
    const [deviceAccount,stateAccount] = await this.reader.getMultipleAccountsInfo([a.deviceAccount,a.deviceEpoch],'finalized');
    const initialEpochBytes=stateAccount ? Buffer.from(stateAccount.data) : null;
    if (deviceAccount === null) return undefined;
    const device = this.device(this.trusted(deviceAccount),a.deviceAccount);
    if (!device) throw Error('Invalid registered device');
    const state = stateAccount === null ? undefined : decodeDeviceEpoch(this.trusted(stateAccount));
    const rows = await this.reader.getProgramAccounts(this.config.program,{commitment:'finalized',filters:[
      {dataSize:214},{memcmp:{offset:8,bytes:new PublicKey(this.config.protocol).toBase58()}},
      {memcmp:{offset:40,bytes:new PublicKey(Buffer.from(id,'hex')).toBase58()}}]});
    if (rows.length>1000) throw Error('Device history exceeds 1000 records; no partial history returned');
    const observations = rows.map(row=>{
      const r=decodeObservationCommitment(this.trusted(row.account));
      if (!r.protocolID.equals(this.config.protocol) || r.deviceID.toString('hex')!==id ||
          !observationAddresses(this.config.program,this.config.protocol,r.deviceID,r.epoch,r.nullifier).commitment.equals(row.pubkey)) throw Error('Observation binding mismatch');
      return {epoch:r.epoch,hash:r.transcriptHash.toString('hex'),address:row.pubkey.toBase58(),paid:r.slotPaid,observerClass:r.observerClass};
    }).filter(r=>r.epoch===epoch).sort((a,b)=>a.hash.localeCompare(b.hash));
    if (observations.length !== (state?.independentObservers ?? 0) ||
        observations.filter(r=>r.paid).length !== (state?.paidSlotsUsed ?? 0)) throw Error('Epoch changed during read; retry');
    let confidence: Record<string,unknown>;
    if (!state || state.confidenceCommitment.every(b=>b===0)) confidence={status: state ? 'stale':'missing'};
    else {
      try {
        const url=new URL(this.config.verifier.href);url.pathname=url.pathname.replace(/\/$/,'')+`/devices/${id}/confidence`;url.searchParams.set('epoch',String(epoch));
        const response=await this.fetcher(url,{redirect:'error',signal:AbortSignal.timeout(10000)});
        if(response.status===404) confidence={status:'missing'};
        else if(!response.ok) confidence={status:'unavailable'};
        else {
          const body=await boundedJSON(response);
          if(body.status==='stale') confidence={status:'stale'};
          else confidence=validateConfidence(body,this.context(),id,epoch,policy.policyVersion,state);
        }
      } catch { confidence={status:'unavailable'}; }
    }
    const finalPolicy=await this.target();
    const finalEpoch=await this.reader.getAccountInfo(a.deviceEpoch,'finalized');
    if(finalPolicy.policyVersion!==policy.policyVersion||
        (initialEpochBytes===null ? finalEpoch!==null : !finalEpoch||!this.trusted(finalEpoch).equals(initialEpochBytes)))throw Error('State changed during read; retry');
    return { ...this.context(),device,epoch,policyVersion:policy.policyVersion,
      state:state ? {observers:state.independentObservers,paidSlots:state.paidSlotsUsed,root:state.observationRoot.toString('hex'),commitment:state.confidenceCommitment.toString('hex')} : null,
      observations,confidence };
  }
}
export async function boundedJSON(response: Response): Promise<Record<string,any>> {
  if(!response.body)throw Error('Missing response body');
  const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
  try { while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2_000_000)throw Error('Response too large');chunks.push(value);} }
  finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function validateConfidence(body:Record<string,any>,context:ReturnType<DashboardService['context']>,device:string,epoch:number,policy:number,state:ReturnType<typeof decodeDeviceEpoch>) {
  const r=body.confidence,s=r?.scope;
  if(body.status!=='published'||body.commitment!==state.confidenceCommitment.toString('hex')||confidenceCommitment(r)!==body.commitment||
      s?.program!==context.program||s.protocolID!==context.protocolID||s.deviceID!==device||s.epoch!==epoch||s.policyVersion!==policy||
      s.observationRoot!==state.observationRoot.toString('hex')||s.transcriptOrder?.length!==state.independentObservers||
      !canonicalConfidenceBytes(r.policy).equals(canonicalConfidenceBytes(CONFIDENCE_POLICY_V0))||!Number.isSafeInteger(s.evaluatedAtMilliseconds)||
      !['LOW','VERIFIED'].includes(r.status)||!Number.isInteger(r.score)||r.score<0||r.score>10000)throw Error('Invalid confidence report');
  const names=['hardware_confidence','temporal_freshness','witness_diversity','spatial_consistency','behavior_diversity','service_evidence'];
  if(!names.every(n=>Number.isInteger(r.facets?.[n])&&r.facets[n]>=0&&r.facets[n]<=10000))throw Error('Invalid facets');
  if(!Number.isInteger(r.observers?.groups)||r.observers.groups<1||r.observers.groups>state.independentObservers||r.observers.raw!==state.independentObservers||
      r.observers.weightedBps!==r.observers.groups*2000||typeof r.coverage?.reenrollmentRiskAvailable!=='boolean'||r.coverage.crossDeployerHistory!=='unavailable')throw Error('Invalid coverage');
  // Project aggregate fields explicitly: no unknown upstream fields or raw inputs reach the browser.
  return {status:'published',commitment:body.commitment,score:r.score,label:r.status,facets:Object.fromEntries(names.map(n=>[n,r.facets[n]])),
    evaluatedAt:s.evaluatedAtMilliseconds,policyVersion:policy,observers:{raw:r.observers.raw,groups:r.observers.groups},
    coverage:{reenrollmentRiskAvailable:r.coverage.reenrollmentRiskAvailable,crossDeployerHistory:'unavailable'},
    signature:typeof body.transaction_signature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(body.transaction_signature)?body.transaction_signature:null};
}
