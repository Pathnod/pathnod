import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { activeRoots, decodeProtocol, decodeEnrollment, registryAddresses, UPGRADEABLE_LOADER } from "@pathnod/solana";
import { authorizationInstruction, hex32 } from "./observation-authorization.ts";
import type { ObservationRelayPayload, ObservationRelayTransport, PreparedObservationTransaction } from "./observation-relay.ts";

export interface ObservationSubmissionAdapter {
  readonly contract: string;
  readonly computeUnitLimit?: number;
  validateTarget?(connection: Connection, program: PublicKey): Promise<void>;
  instruction(program: PublicKey, payer: PublicKey, payload: ObservationRelayPayload): TransactionInstruction;
  confirm(connection: Connection, program: PublicKey, payload: ObservationRelayPayload): Promise<boolean>;
}
export function signatureBase58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`), result = "";
  while (n > 0n) { result = alphabet[Number(n % 58n)]! + result; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; result = "1" + result; }
  return result;
}
export class SolanaObservationRelayTransport implements ObservationRelayTransport {
  readonly target: string;
  readonly connection: Connection;
  readonly program: PublicKey;
  readonly protocol: Buffer;
  readonly payer: Keypair;
  readonly adapter: ObservationSubmissionAdapter;
  readonly verifier: string;
  private constructor(connection: Connection, program: PublicKey, protocol: Buffer,
    payer: Keypair, adapter: ObservationSubmissionAdapter, genesis: string, verifier: string) {
    this.connection = connection; this.program = program; this.protocol = protocol;
    this.payer = payer; this.adapter = adapter; this.verifier = verifier;
    if (!adapter.contract || payer.publicKey.toBase58() === verifier) throw Error("Separate relayer and verifier keys required");
    this.target = `${genesis}/${program.toBase58()}/${protocol.toString("hex")}/${verifier}/${payer.publicKey.toBase58()}/${adapter.contract}`;
  }
  static async open(rpcURL: string, program: string, protocol: string, payer: Keypair, verifier: string,
    adapter: ObservationSubmissionAdapter, genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") {
    const url = new URL(rpcURL), local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash ||
        !(url.protocol === "https:" || local && url.protocol === "http:")) throw Error("Invalid relay RPC");
    const connection = new Connection(url.href, { commitment: "finalized", disableRetryOnRateLimit: true,
      fetch: (input, init) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }) });
    if (await connection.getGenesisHash() !== genesis) throw Error("Unexpected relay cluster");
    const key = new PublicKey(program), account = await connection.getAccountInfo(key, "finalized");
    if (!account?.executable || !account.owner.equals(UPGRADEABLE_LOADER)) throw Error("Untrusted relay program");
    await adapter.validateTarget?.(connection, key);
    return new SolanaObservationRelayTransport(connection, key, hex32(protocol), payer, adapter, genesis, verifier);
  }
  async eligible(payload: ObservationRelayPayload): Promise<boolean> {
    if (payload.protocolID !== this.protocol.toString("hex") || payload.verifier !== this.verifier) return false;
    const addresses = registryAddresses(this.program, this.protocol);
    const nullifier = PublicKey.findProgramAddressSync([Buffer.from("obs"), hex32(payload.nullifier)], this.program)[0];
    const [configAccount, rootAccount, observation] = await this.connection.getMultipleAccountsInfo(
      [addresses.config, addresses.enrollment, nullifier], "finalized");
    if (!configAccount || !rootAccount || configAccount.executable || rootAccount.executable ||
        !configAccount.owner.equals(this.program) || !rootAccount.owner.equals(this.program)) throw Error("Untrusted relay state");
    const config = decodeProtocol(configAccount.data), root = decodeEnrollment(rootAccount.data);
    if (!config.protocolId.equals(this.protocol) || !config.escrow.equals(addresses.escrow) ||
        config.authority.equals(PublicKey.default) || root.authority.equals(PublicKey.default)) throw Error("Invalid relay config");
    const bytes = Buffer.from(payload.proofBytes, "hex");
    if (bytes.length !== 480) throw Error("Invalid relay proof");
    return config.verifier.toBase58() === payload.verifier && config.policyVersion === payload.policyVersion &&
      observation === null && activeRoots(root).some(value => value.equals(bytes.subarray(256, 288)));
  }
  async prepare(payload: ObservationRelayPayload): Promise<PreparedObservationTransaction> {
    const latest = await this.connection.getLatestBlockhash("finalized");
    const submit = this.adapter.instruction(this.program, this.payer.publicKey, payload);
    if (!submit.programId.equals(this.program)) throw Error("Adapter selected another program");
    const tx = new Transaction({ feePayer: this.payer.publicKey, ...latest });
    if (this.adapter.computeUnitLimit !== undefined) {
      if (!Number.isInteger(this.adapter.computeUnitLimit) || this.adapter.computeUnitLimit < 1 || this.adapter.computeUnitLimit > 300_000) throw Error("Invalid observation compute budget");
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: this.adapter.computeUnitLimit }));
    }
    tx.add(authorizationInstruction(payload, payload.verifier, payload.verifierSignature), submit);
    tx.sign(this.payer);
    const wire = tx.serialize(); if (wire.length > 1232 || !tx.signature) throw Error("Transaction size/signature invalid");
    return { wire: wire.toString("base64"), signature: signatureBase58(tx.signature), lastValidBlockHeight: latest.lastValidBlockHeight };
  }
  async send(transaction: PreparedObservationTransaction): Promise<void> {
    const signature = await this.connection.sendRawTransaction(Buffer.from(transaction.wire, "base64"),
      { skipPreflight: false, preflightCommitment: "finalized", maxRetries: 0 });
    if (signature !== transaction.signature) throw Error("Unexpected RPC signature");
  }
  async inspect(transaction: PreparedObservationTransaction, payload: ObservationRelayPayload) {
    const status = (await this.connection.getSignatureStatuses([transaction.signature], { searchTransactionHistory: true })).value[0];
    if (!status) return "missing" as const;
    if (status.confirmationStatus !== "finalized") return "pending" as const;
    if (status.err) return "failed" as const;
    if (!await this.adapter.confirm(this.connection, this.program, payload)) throw Error("Missing or mismatched observation commitment");
    return "confirmed" as const;
  }
  async expired(transaction: PreparedObservationTransaction): Promise<boolean> {
    return await this.connection.getBlockHeight("finalized") > transaction.lastValidBlockHeight;
  }
  async confirmExisting(payload: ObservationRelayPayload): Promise<boolean> {
    return this.adapter.confirm(this.connection, this.program, payload);
  }
}
