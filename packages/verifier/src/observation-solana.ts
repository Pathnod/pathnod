import { Connection, PublicKey, Transaction, Ed25519Program, type AccountInfo } from "@solana/web3.js";
import { UPGRADEABLE_LOADER, activeRoots, decodeEnrollment, decodeProtocol, decodeDevice, decodeObservationVerifier, registryAddresses,
  paymentAddresses, decodePayout, decodePaymentSettings, formatUSDC, TOKEN_PROGRAM, DEVNET_USDC, claimPayout, claimDigest, type ClaimAuthorization } from "@pathnod/solana";
import { ObservationPolicyError, type ObservationPolicySource } from "./observation-policy.ts";
import type { ObservationTranscript } from "./observation-transcript.ts";
import { finalizedObservationStatus } from './observation-status.ts';
import { observationAddresses, decodeDeviceEpoch } from '@pathnod/solana';

export interface ObservationAccountReader {
  read(addresses: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]>;
  blockhash?(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
}
/** Config, device, active root ring and nullifier are read from one finalized RPC bank. */
export class SolanaObservationPolicySource implements ObservationPolicySource {
  readonly target: string;
  readonly paymentScope: string;
  readonly #reader: ObservationAccountReader;
  readonly #program: PublicKey;
  readonly #protocol: Buffer;
  readonly #minimumRSSI: number;
  readonly #policyVersion: number;
  readonly #keyDigest: string | undefined;
  constructor(reader: ObservationAccountReader, program: PublicKey, protocol: Buffer, target: string,
    minimumRSSI = -90, policyVersion = 1, keyDigest?: string) {
    if (program.equals(PublicKey.default) || protocol.length !== 32 || protocol.every(b => b === 0) ||
      !target || !Number.isInteger(minimumRSSI) || minimumRSSI < -127 || minimumRSSI > 0 ||
      !Number.isInteger(policyVersion) || policyVersion < 1) throw Error("Invalid observation chain configuration");
    this.#reader = reader; this.#program = program; this.#protocol = Buffer.from(protocol);
    this.#minimumRSSI = minimumRSSI; this.#policyVersion = policyVersion;
    if (keyDigest !== undefined && !/^[a-f0-9]{64}$/.test(keyDigest)) throw Error('Invalid pinned observation circuit');
    this.#keyDigest = keyDigest;
    this.target = `${target}/${program.toBase58()}/${protocol.toString("hex")}/${policyVersion}/${minimumRSSI}`;
    this.paymentScope = `${target}/${program.toBase58()}/${protocol.toString("hex")}`;
  }
  static async open(rpcURL: string, programID: string, protocolHex: string, minimumRSSI = -90,
    policyVersion = 1, expectedGenesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", keyDigest?: string) {
    const url = new URL(rpcURL);
    if (url.username || url.password || url.hash || !["http:", "https:"].includes(url.protocol) ||
      (url.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) ||
      !/^[a-f0-9]{64}$/.test(protocolHex)) throw Error("Invalid observation RPC target");
    const connection = new Connection(url.href, { commitment: "finalized", disableRetryOnRateLimit: true,
      fetch: (input, init) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }) });
    const program = new PublicKey(programID);
    const genesis = await connection.getGenesisHash();
    if (genesis !== expectedGenesis) throw Error("Unexpected observation cluster genesis");
    const executable = await connection.getAccountInfo(program, "finalized");
    if (!executable?.executable || !executable.owner.equals(UPGRADEABLE_LOADER)) throw Error("Invalid observation program");
    return new SolanaObservationPolicySource({ read: addresses => connection.getMultipleAccountsInfo(addresses, "finalized"),
      blockhash: () => connection.getLatestBlockhash('finalized') },
      program, Buffer.from(protocolHex, "hex"), genesis, minimumRSSI, policyVersion, keyDigest);
  }
  async #paymentState(pseudonym: string) {
    if (!/^[a-f0-9]{64}$/.test(pseudonym)) throw Error('Invalid pseudonym');
    const p = paymentAddresses(this.#program,this.#protocol,Buffer.from(pseudonym,'hex'));
    const [configAccount,payoutAccount,settingsAccount] = await this.#reader.read([
      registryAddresses(this.#program,this.#protocol).config,p.payout,p.settings]);
    const trusted = (a: AccountInfo<Buffer> | null | undefined) => {
      if (!a || a.executable || !a.owner.equals(this.#program)) throw Error('Untrusted payment account'); return a.data;
    };
    const config = decodeProtocol(trusted(configAccount)), settings = decodePaymentSettings(trusted(settingsAccount));
    if (!config.protocolId.equals(this.#protocol) || !config.escrow.equals(registryAddresses(this.#program,this.#protocol).escrow)
        || !config.rewardMint.equals(settings.mint) || !settings.mint.equals(DEVNET_USDC)) throw Error('Payment target mismatch');
    const payout = payoutAccount === null ? undefined : decodePayout(trusted(payoutAccount));
    if (payout && (!payout.protocol.equals(this.#protocol) || payout.pseudonym.toString('hex') !== pseudonym ||
        !payout.mint.equals(settings.mint))) throw Error('Payout binding mismatch');
    return { p,config,settings,payout };
  }
  observationStatus(payload: import('./observation-relay.ts').ObservationRelayPayload) {
    return finalizedObservationStatus(this.#reader, this.#program, this.#protocol, payload,
      this.paymentScope.split('/')[0] === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' ? 'devnet' : 'local-validator');
  }
  async confidenceState(device: string, epoch: number) {
    const addresses=observationAddresses(this.#program,this.#protocol,Buffer.from(device,'hex'),epoch,Buffer.alloc(32));
    const [config,record]=await this.#reader.read([addresses.config,addresses.deviceEpoch]);
    if(!config||config.executable||!config.owner.equals(this.#program))throw Error('Untrusted confidence config');
    const policy=decodeProtocol(config.data);if(!policy.protocolId.equals(this.#protocol))throw Error('Confidence protocol mismatch');
    if(record===null)return undefined;
    if(!record||record.executable||!record.owner.equals(this.#program))throw Error('Untrusted confidence epoch');
    const state=decodeDeviceEpoch(record.data);
    return {program:this.#program.toBase58(),protocolID:this.#protocol.toString('hex'),policyVersion:policy.policyVersion,
      observationRoot:state.observationRoot.toString('hex'),observerCount:state.independentObservers,commitment:state.confidenceCommitment.toString('hex')};
  }
  async payout(pseudonym: string) {
    const { p,config,settings,payout } = await this.#paymentState(pseudonym);
    return { status: payout ? 'finalized' : 'pending', network: 'devnet', program: this.#program.toBase58(),
      protocol: this.#protocol.toString('hex'), pseudonym, payout: p.payout.toBase58(), mint: settings.mint.toBase58(),
      policy_version: config.policyVersion, fee_bps: settings.feeBps, withdrawal_key: payout?.withdrawalKey.toBase58() ?? PublicKey.default.toBase58(),
      gross: formatUSDC(payout?.gross ?? 0n), fees: formatUSDC(payout?.fees ?? 0n),
      available: formatUSDC(payout?.available ?? 0n), withdrawn: formatUSDC(payout?.withdrawn ?? 0n),
      nonce: String(payout?.nonce ?? 0n) };
  }
  async claim(pseudonym: string, withdrawalKey: string, destination: string, expiresAt?: string): Promise<ClaimAuthorization> {
    const { p,config,payout } = await this.#paymentState(pseudonym);
    if (config.policyVersion !== this.#policyVersion) throw Error('Restart/migrate verifier for the current payment policy');
    const key = new PublicKey(withdrawalKey), to = new PublicKey(destination);
    if (!payout || payout.available === 0n || key.equals(PublicKey.default) || to.equals(p.vault) ||
        !payout.withdrawalKey.equals(PublicKey.default) && !payout.withdrawalKey.equals(key)) throw Error('Invalid withdrawal key/balance');
    const [account] = await this.#reader.read([to]);
    if (!account || account.executable || !account.owner.equals(TOKEN_PROGRAM) || account.data.length !== 165 ||
        !new PublicKey(account.data.subarray(0,32)).equals(payout.mint) ||
        !new PublicKey(account.data.subarray(32,64)).equals(key) || account.data[108] !== 1) throw Error('Invalid destination');
    const now = Math.floor(Date.now()/1000);
    const expiry = expiresAt ?? String(now+240);
    if (!/^[1-9][0-9]{0,10}$/.test(expiry) || BigInt(expiry) < BigInt(now) || BigInt(expiry) > BigInt(now+300)) throw Error('Invalid claim expiry');
    return { program: this.#program.toBase58(),payout: p.payout.toBase58(),mint: payout.mint.toBase58(),
      withdrawalKey: key.toBase58(),destination: to.toBase58(),amount: String(payout.available),nonce: String(payout.nonce),
      expiresAt: expiry,policyVersion: config.policyVersion };
  }
  async prepareClaim(authorization: ClaimAuthorization, verifier: string, signature: string) {
    if (!this.#reader.blockhash || authorization.program !== this.#program.toBase58()) throw Error('Claims unavailable');
    const [account] = await this.#reader.read([new PublicKey(authorization.payout)]);
    if (!account || account.executable || !account.owner.equals(this.#program)) throw Error('Untrusted payout');
    const payout = decodePayout(account.data);
    if (!payout.protocol.equals(this.#protocol) || !paymentAddresses(this.#program,this.#protocol,payout.pseudonym).payout.equals(new PublicKey(authorization.payout))) throw Error('Claim binding mismatch');
    const latest = await this.#reader.blockhash();
    const tx = new Transaction({ feePayer:new PublicKey(authorization.withdrawalKey), ...latest });
    tx.add(Ed25519Program.createInstructionWithPublicKey({ publicKey:new PublicKey(verifier).toBuffer(),
      signature:Buffer.from(signature,'hex'), message:claimDigest(authorization) }),
      claimPayout(this.#program,this.#protocol,payout.pseudonym,new PublicKey(authorization.mint),
        new PublicKey(authorization.withdrawalKey),new PublicKey(authorization.destination),BigInt(authorization.amount),
        BigInt(authorization.nonce),BigInt(authorization.expiresAt)));
    return { message:tx.serializeMessage().toString('base64'), ...latest };
  }
  async snapshot(t: ObservationTranscript) {
    // Caller-supplied protocol mismatch is permanent, unlike unavailable/untrusted RPC state.
    if (!this.#protocol.equals(t.protocolID)) throw new ObservationPolicyError("E_DEVICE_UNKNOWN");
    const addresses = registryAddresses(this.#program, this.#protocol);
    const nullifier = PublicKey.findProgramAddressSync([Buffer.from("obs"), t.nullifier], this.#program)[0];
    const requested = [addresses.config, addresses.device(t.deviceID), addresses.enrollment, nullifier];
    if (this.#keyDigest) requested.push(PublicKey.findProgramAddressSync([Buffer.from('observation-verifier')], this.#program)[0]);
    const accounts = await this.#reader.read(requested);
    if (accounts.length !== requested.length) throw Error("Incomplete observation RPC response");
    const data = (account: AccountInfo<Buffer> | null | undefined): Buffer => {
      if (!account || account.executable || !account.owner.equals(this.#program)) throw Error("Untrusted observation account");
      return account.data;
    };
    if (this.#keyDigest && decodeObservationVerifier(data(accounts[4])).keyDigest !== this.#keyDigest) throw Error('Observation circuit key mismatch');
    const config = decodeProtocol(data(accounts[0]));
    if (!config.protocolId.equals(this.#protocol) || config.epochSeconds === 0 || config.policyVersion !== this.#policyVersion ||
      config.authority.equals(PublicKey.default) || config.verifier.equals(PublicKey.default) || !config.escrow.equals(addresses.escrow)) {
      throw Error("Observation protocol policy mismatch");
    }
    const enrollment = decodeEnrollment(data(accounts[2]));
    if (enrollment.authority.equals(PublicKey.default)) throw Error("Invalid root authority");
    const device = accounts[1] === null ? undefined : decodeDevice(data(accounts[1]));
    if (device && (!device.deviceId.equals(t.deviceID) || device.registeredAt <= 0n)) throw Error("Device account mismatch");
    // ANY existing PDA blocks acceptance, including an unexpected account layout/owner.
    return { device, epochSeconds: config.epochSeconds, minimumRSSI: this.#minimumRSSI,
      verifier: config.verifier.toBase58(), policyVersion: config.policyVersion,
      roots: activeRoots(enrollment).map(root => BigInt("0x" + root.toString("hex")).toString()), nullifierUsed: accounts[3] !== null };
  }
}
