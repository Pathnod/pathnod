import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  DEVNET_USDC, UPGRADEABLE_LOADER, decodeDevice, decodeDeviceEpoch, decodeProtocol, deviceId, registryAddresses,
} from "@pathnod/solana";

export type EligibilityErrorCode = "invalid_input" | "invalid_config" | "invalid_target" |
  "protocol_unknown" | "account_mismatch" | "rpc_unavailable";

export class EligibilityError extends Error {
  readonly code: EligibilityErrorCode;
  constructor(code: EligibilityErrorCode) { super(`Device eligibility failed: ${code}`); this.code = code; }
}

export interface DeviceSlots {
  readonly registered: boolean;
  readonly protocol_id: string;
  readonly open_slots: number;
  readonly reward: string;
  readonly policy_version: number;
}

export interface EligibilityAccountReader {
  read(addresses: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]>;
}

function id(value: unknown): Buffer {
  if (typeof value !== "string" || !/^(?:0x)?[0-9a-f]{64}$/i.test(value)) throw new EligibilityError("invalid_input");
  return Buffer.from(value.replace(/^0x/i, ""), "hex");
}

function epochNumber(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,9})$/.test(value)) throw new EligibilityError("invalid_input");
  const epoch = Number(value);
  if (epoch > 0xffff_ffff) throw new EligibilityError("invalid_input");
  return epoch;
}

function decimalReward(value: bigint): string {
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${value / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

export class DeviceEligibilityService {
  readonly #reader: EligibilityAccountReader;
  readonly #program: PublicKey;
  readonly #protocol: Buffer;
  readonly #rewardMint: PublicKey;

  constructor(reader: EligibilityAccountReader, program: PublicKey, protocolID: string, rewardMint = DEVNET_USDC) {
    try {
      this.#protocol = id(protocolID);
      if (this.#protocol.every(byte => byte === 0) || program.equals(PublicKey.default) || rewardMint.equals(PublicKey.default)) throw Error();
    } catch { throw new EligibilityError("invalid_config"); }
    this.#reader = reader;
    this.#program = program;
    this.#rewardMint = rewardMint;
  }

  static async open(rpcURL: string, programID: string, protocolID: string, rewardMintID?: string): Promise<DeviceEligibilityService> {
    let rpc: URL, program: PublicKey, mint: PublicKey;
    try {
      rpc = new URL(rpcURL); program = new PublicKey(programID);
      mint = rewardMintID === undefined ? DEVNET_USDC : new PublicKey(rewardMintID);
    } catch { throw new EligibilityError("invalid_config"); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname);
    if ((!local && rpc.protocol !== "https:") || (local && !["http:", "https:"].includes(rpc.protocol))) {
      throw new EligibilityError("invalid_target");
    }
    const connection = new Connection(rpc.href, {
      commitment: "confirmed", disableRetryOnRateLimit: true,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
    });
    const service = new DeviceEligibilityService({ read: async addresses => {
      const result = await connection.getMultipleAccountsInfoAndContext(addresses, { commitment: "confirmed" });
      return result.value;
    } }, program, protocolID, mint);
    try {
      const genesis = await connection.getGenesisHash();
      if (!local && genesis !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw new EligibilityError("invalid_target");
      const account = await connection.getAccountInfo(program, "confirmed");
      if (!account?.executable || !account.owner.equals(UPGRADEABLE_LOADER)) throw new EligibilityError("invalid_target");
      return service;
    } catch (error) {
      if (error instanceof EligibilityError) throw error;
      throw new EligibilityError("rpc_unavailable");
    }
  }

  async slots(deviceID: unknown, epochValue: unknown, protocolID?: unknown): Promise<DeviceSlots> {
    const device = id(deviceID), epoch = epochNumber(epochValue);
    const protocol = protocolID === undefined ? this.#protocol : id(protocolID);
    if (protocol.every(byte => byte === 0)) throw new EligibilityError("invalid_input");
    const addresses = registryAddresses(this.#program, protocol);
    let accounts: (AccountInfo<Buffer> | null)[];
    try { accounts = await this.#reader.read([addresses.config, addresses.device(device), addresses.epoch(device, epoch)]); }
    catch { throw new EligibilityError("rpc_unavailable"); }
    if (accounts.length !== 3) throw new EligibilityError("rpc_unavailable");
    const [configAccount, deviceAccount, epochAccount] = accounts;
    if (configAccount === null) throw new EligibilityError("protocol_unknown");
    try {
      const data = (account: AccountInfo<Buffer> | null | undefined) => {
        if (!account || !account.owner.equals(this.#program) || account.executable) throw Error();
        return account.data;
      };
      const config = decodeProtocol(data(configAccount));
      if (!config.protocolId.equals(protocol) || config.epochSeconds === 0 || config.policyVersion === 0 ||
          config.authority.equals(PublicKey.default) || config.verifier.equals(PublicKey.default) ||
          !config.escrow.equals(addresses.escrow) || !config.rewardMint.equals(this.#rewardMint) ||
          (config.slotsPerEpoch > 0 && config.rewardPerSlot === 0n)) throw Error();
      const result = { protocol_id: `0x${protocol.toString("hex")}`, policy_version: config.policyVersion };
      if (deviceAccount === null) {
        if (epochAccount !== null) throw Error();
        return { registered: false, ...result, open_slots: 0, reward: "0" };
      }
      const record = decodeDevice(data(deviceAccount));
      if (!record.deviceId.equals(device) || !deviceId(record.key).equals(device) || record.key.every(byte => byte === 0) ||
          record.curve !== 1 || record.registeredAt <= 0n) throw Error();
      const state = epochAccount === null ? undefined : decodeDeviceEpoch(data(epochAccount));
      if (state && state.paidSlotsUsed > state.independentObservers) throw Error();
      return { registered: true, ...result,
        open_slots: Math.max(0, config.slotsPerEpoch - (state?.paidSlotsUsed ?? 0)),
        reward: decimalReward(config.rewardPerSlot),
      };
    } catch { throw new EligibilityError("account_mismatch"); }
  }
}
