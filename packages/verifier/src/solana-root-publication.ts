import { readFile } from "node:fs/promises";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, type AccountInfo } from "@solana/web3.js";
import {
  BN254_MODULUS, UPGRADEABLE_LOADER, activeRoots, decodeEnrollment, decodeRoot, publishRoot, registryAddresses,
} from "@pathnod/solana";
import type { ObserverRootSnapshot } from "./observer-enrollment.ts";
import { RootPublicationError, type PreparedRootTransaction, type RootPublicationTransport } from "./root-publication.ts";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export class SolanaRootPublicationTransport implements RootPublicationTransport {
  readonly target: string;
  readonly program: string;
  readonly cluster: "devnet" | "local";
  readonly #connection: Connection;
  readonly #program: PublicKey;
  readonly #signer: Keypair;

  private constructor(connection: Connection, program: PublicKey, signer: Keypair, genesis: string, local: boolean) {
    this.#connection = connection;
    this.#program = program;
    this.#signer = signer;
    this.program = program.toBase58();
    this.cluster = local ? "local" : "devnet";
    this.target = `${genesis}/${this.program}/${signer.publicKey.toBase58()}`;
  }

  static async open(rpcURL: string, programID: string, keypairPath: string): Promise<SolanaRootPublicationTransport> {
    let rpc: URL, program: PublicKey, signer: Keypair;
    try {
      rpc = new URL(rpcURL);
      program = new PublicKey(programID);
      const key: unknown = JSON.parse(await readFile(keypairPath, "utf8"));
      if (!Array.isArray(key) || key.length !== 64 || key.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
        throw Error();
      }
      signer = Keypair.fromSecretKey(Uint8Array.from(key));
    } catch { throw new RootPublicationError("invalid_config"); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname);
    if ((!local && rpc.protocol !== "https:") || (local && !["http:", "https:"].includes(rpc.protocol))) {
      throw new RootPublicationError("invalid_target");
    }
    let queue = Promise.resolve();
    const connection = new Connection(rpc.href, {
      commitment: "confirmed",
      ...(!local ? { fetchMiddleware: (url, init, fetch) => {
        queue = queue.then(() => new Promise<void>(resolve => setTimeout(resolve, 750)));
        void queue.then(() => fetch(url, init));
      } } : {}),
    });
    try {
      const genesis = await connection.getGenesisHash();
      if (!local && genesis !== DEVNET_GENESIS) throw new RootPublicationError("invalid_target");
      const account = await connection.getAccountInfo(program);
      if (!account?.executable || !account.owner.equals(UPGRADEABLE_LOADER)) throw new RootPublicationError("invalid_target");
      const client = new SolanaRootPublicationTransport(connection, program, signer, genesis, local);
      await client.#enrollment();
      return client;
    } catch (error) {
      if (error instanceof RootPublicationError) throw error;
      throw new RootPublicationError("rpc_error");
    }
  }

  address(root: string): string {
    return registryAddresses(this.#program, Buffer.alloc(32)).root(this.#rootBytes(root)).toBase58();
  }

  async inspect(snapshot: ObserverRootSnapshot): Promise<{ slot: number; active: boolean } | undefined> {
    const address = new PublicKey(this.address(snapshot.root));
    const enrollmentAddress = registryAddresses(this.#program, Buffer.alloc(32)).enrollment;
    const accounts = await this.#connection.getMultipleAccountsInfoAndContext([address, enrollmentAddress], { commitment: "finalized" });
    // A confirmed bootstrap may not exist yet in this finalized bank.
    if (!accounts.value[1]) throw new RootPublicationError("rpc_error");
    const enrollment = this.#decodeEnrollment(accounts.value[1] ?? null);
    const account = accounts.value[0];
    if (!account) return undefined;
    if (!account.owner.equals(this.#program)) throw new RootPublicationError("account_mismatch");
    try {
      const record = decodeRoot(account.data);
      if (!record.root.equals(this.#rootBytes(snapshot.root)) || record.leafCount !== snapshot.leafCount ||
          !record.authority.equals(this.#signer.publicKey) || record.publishedAt <= 0n) {
        throw Error();
      }
      return { slot: accounts.context.slot, active: activeRoots(enrollment).some(root => root.equals(record.root)) };
    } catch { throw new RootPublicationError("account_mismatch"); }
  }

  async prepare(snapshot: ObserverRootSnapshot): Promise<PreparedRootTransaction> {
    const hash = await this.#connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({ feePayer: this.#signer.publicKey, ...hash }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
      publishRoot(this.#program, this.#signer.publicKey, this.#rootBytes(snapshot.root), snapshot.leafCount),
    );
    transaction.sign(this.#signer);
    const wire = transaction.serialize();
    if (wire.length > 1232) throw new RootPublicationError("invalid_config");
    return { wire: wire.toString("base64"), lastValidBlockHeight: hash.lastValidBlockHeight };
  }

  async send(transaction: PreparedRootTransaction): Promise<string> {
    return this.#connection.sendRawTransaction(Buffer.from(transaction.wire, "base64"), { maxRetries: 3 });
  }

  async expired(transaction: PreparedRootTransaction): Promise<boolean> {
    return await this.#connection.getBlockHeight("finalized") > transaction.lastValidBlockHeight;
  }

  async #enrollment() {
    const address = registryAddresses(this.#program, Buffer.alloc(32)).enrollment;
    const account = await this.#connection.getAccountInfo(address, "confirmed");
    return this.#decodeEnrollment(account);
  }

  #decodeEnrollment(account: AccountInfo<Buffer> | null) {
    if (!account || !account.owner.equals(this.#program)) throw new RootPublicationError("invalid_target");
    let record: ReturnType<typeof decodeEnrollment>;
    try { record = decodeEnrollment(account.data); }
    catch { throw new RootPublicationError("account_mismatch"); }
    if (!record.authority.equals(this.#signer.publicKey)) throw new RootPublicationError("invalid_authority");
    return record;
  }

  #rootBytes(root: string): Buffer {
    if (!/^0x[0-9a-f]{64}$/.test(root) || BigInt(root) >= BN254_MODULUS) throw new RootPublicationError("account_mismatch");
    return Buffer.from(root.slice(2), "hex");
  }
}
