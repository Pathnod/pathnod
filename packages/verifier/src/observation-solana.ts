import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { UPGRADEABLE_LOADER, activeRoots, decodeEnrollment, decodeProtocol, decodeDevice, decodeObservationVerifier, registryAddresses } from "@pathnod/solana";
import { ObservationPolicyError, type ObservationPolicySource } from "./observation-policy.ts";
import type { ObservationTranscript } from "./observation-transcript.ts";

export interface ObservationAccountReader {
  read(addresses: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]>;
}
/** Config, device, active root ring and nullifier are read from one finalized RPC bank. */
export class SolanaObservationPolicySource implements ObservationPolicySource {
  readonly target: string;
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
    return new SolanaObservationPolicySource({ read: addresses => connection.getMultipleAccountsInfo(addresses, "finalized") },
      program, Buffer.from(protocolHex, "hex"), genesis, minimumRSSI, policyVersion, keyDigest);
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
