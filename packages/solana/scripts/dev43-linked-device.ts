import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  stat,
  realpath,
  open,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  SYSVAR_CLOCK_PUBKEY,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  createSignerFromKeypair,
  signerIdentity,
  publicKey as umiKey,
} from "@metaplex-foundation/umi";
import {
  fromWeb3JsKeypair,
  toWeb3JsInstruction,
} from "@metaplex-foundation/umi-web3js-adapters";
import {
  mplBubblegum,
  createTree,
  mintV1,
  transfer,
  hashMetadataData,
  hashMetadataCreators,
  TokenStandard,
  type MetadataArgsArgs,
} from "@metaplex-foundation/mpl-bubblegum";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  cnftAssetId,
  cnftLeaf,
  assetControlDigest,
  assetControlAuthorization,
  registerDevice,
  initProtocol,
  deviceId,
  decodeDevice,
  registryAddresses,
  DEVNET_USDC,
  ACCOUNT_COMPRESSION_V1,
  cnftTreeConfig,
  type CnftControlProof,
  type DeviceArgs,
} from "../src/index.ts";

interface Config {
  version: 1;
  rpc: string;
  program: string;
  wallet: string;
  stateDirectory: string;
  deviceInfo: string;
  localValidator?: boolean;
  expectedGenesis?: string;
  scope?: string;
}
interface Step {
  wire: string;
  signature: string;
  lastValidBlockHeight: number;
  state: "prepared" | "finalized";
  error?: unknown;
  membershipRejectionVerified?: boolean;
}
interface State {
  version: 1;
  target: string;
  tree: string;
  protocolID: string;
  steps: Record<string, Step>;
}
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
function base58(bytes: Uint8Array) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let s = "";
  while (n) {
    s = alphabet[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b) break;
    s = "1" + s;
  }
  return s;
}
async function outside(file: string) {
  assert.ok(path.isAbsolute(file));
  const resolved = await realpath(file),
    root = await realpath(repo),
    relative = path.relative(root, resolved);
  assert.ok(
    relative.startsWith(".." + path.sep) || path.isAbsolute(relative),
    "Keep state and private files outside Git",
  );
  return resolved;
}
async function privateJSON(file: string) {
  const f = await outside(file),
    info = await stat(f);
  assert.ok(
    info.isFile() && (info.mode & 0o077) === 0 && info.size < 1_000_000,
  );
  return JSON.parse(await readFile(f, "utf8"));
}
async function atomic(file: string, value: unknown) {
  await writeFile(file + ".next", JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  const { rename } = await import("node:fs/promises");
  await rename(file + ".next", file);
}
const metadata: MetadataArgsArgs = {
  name: "Pathnod DEV43 Helium demo",
  symbol: "PNDEMO",
  uri: "https://raw.githubusercontent.com/Pathnod/pathnod/feat/dev-43-linked-cnft/docs/evidence/dev43-demo-cnft-metadata.json",
  sellerFeeBasisPoints: 0,
  primarySaleHappened: false,
  isMutable: false,
  editionNonce: null,
  tokenStandard: TokenStandard.NonFungible,
  collection: null,
  uses: null,
  creators: [],
};

async function main() {
  const args = process.argv.slice(2).filter((v) => v !== "--");
  assert.equal(args[0], "--config");
  assert.equal(args.length, 3);
  const action = args[2]!;
  assert.ok(
    ["prepare", "mint", "register", "negative-tests", "report"].includes(
      action,
    ),
  );
  const c = (await privateJSON(path.resolve(args[1]!))) as Config;
  assert.equal(c.version, 1);
  const rpc = new URL(c.rpc),
    local = ["127.0.0.1", "localhost", "[::1]"].includes(rpc.hostname);
  assert.ok(!rpc.username && !rpc.password && !rpc.search && !rpc.hash);
  assert.ok(
    local
      ? c.localValidator === true &&
          !!c.expectedGenesis &&
          ["http:", "https:"].includes(rpc.protocol)
      : c.localValidator !== true &&
          rpc.href === "https://api.devnet.solana.com/",
  );
  const connection = new Connection(rpc.href, {
    commitment: "finalized",
    disableRetryOnRateLimit: true,
  });
  const genesis = await connection.getGenesisHash();
  assert.equal(
    genesis,
    local ? c.expectedGenesis : "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  );
  const wallet = Keypair.fromSecretKey(
      Uint8Array.from(await privateJSON(c.wallet)),
    ),
    program = new PublicKey(c.program);
  assert.ok(path.isAbsolute(c.stateDirectory));
  await mkdir(c.stateDirectory, { recursive: true, mode: 0o700 });
  const directory = await outside(c.stateDirectory);
  assert.equal((await stat(directory)).mode & 0o077, 0);
  const lock = await open(path.join(directory, "run.lock"), "wx", 0o600);
  await lock.writeFile(String(process.pid));
  try {
    const target = `${genesis}/${program.toBase58()}/${wallet.publicKey.toBase58()}`,
      stateFile = path.join(directory, "state.json"),
      treeFile = path.join(directory, "tree.json");
    let tree: Keypair;
    try {
      tree = Keypair.fromSecretKey(
        Uint8Array.from(await privateJSON(treeFile)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      tree = Keypair.generate();
      await atomic(treeFile, [...tree.secretKey]);
    }
    assert.ok(c.scope === undefined || /^[a-z0-9-]{1,48}$/.test(c.scope));
    const protocol = createHash("sha256")
      .update("Pathnod/dev43/demo-protocol/v0")
      .update(program.toBuffer())
      .update(wallet.publicKey.toBuffer())
      .update(c.scope ?? "")
      .digest();
    let state: State;
    try {
      state = (await privateJSON(stateFile)) as State;
      assert.equal(state.target, target);
      assert.equal(state.tree, tree.publicKey.toBase58());
      assert.equal(state.protocolID, protocol.toString("hex"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = {
        version: 1,
        target,
        tree: tree.publicKey.toBase58(),
        protocolID: protocol.toString("hex"),
        steps: {},
      };
      await atomic(stateFile, state);
    }
    const info = Buffer.from(c.deviceInfo, "hex");
    assert.equal(info.length, 70);
    assert.deepEqual([...info.subarray(0, 2)], [0, 1]);
    const deviceKey = info.subarray(2, 34),
      id = deviceId(deviceKey),
      capabilities = info.readUInt32BE(34);
    const umi = createUmi(rpc.href).use(mplBubblegum());
    const identity = createSignerFromKeypair(umi, fromWeb3JsKeypair(wallet));
    umi.use(signerIdentity(identity));
    const treeSigner = createSignerFromKeypair(umi, fromWeb3JsKeypair(tree));
    const rejectCodes: Record<string, unknown> = {};
    const rejectionCodes: Record<string, number> = {
      "wrong-owner": 6001,
      "wrong-data": 6001,
      "swapped-metadata": 6120,
      expired: 6121,
      "far-expiry": 6121,
      "missing-precompile": 6120,
      "forged-tree": 6119,
      "changed-owner": 6001,
    };
    async function send(
      label: string,
      instructions: TransactionInstruction[],
      signers: Keypair[] = [wallet],
      expectFailure = false,
    ) {
      let step = state.steps[label];
      if (!step) {
        const latest = await connection.getLatestBlockhash("finalized");
        const tx = new VersionedTransaction(
          new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: latest.blockhash,
            instructions,
          }).compileToV0Message(),
        );
        tx.sign(signers);
        const wire = Buffer.from(tx.serialize());
        assert.ok(
          wire.length <= 1232,
          `Transaction ${label} exceeds 1232 bytes`,
        );
        step = {
          wire: wire.toString("base64"),
          signature: base58(tx.signatures[0]!),
          lastValidBlockHeight: latest.lastValidBlockHeight,
          state: "prepared",
        };
        state.steps[label] = step;
        await atomic(stateFile, state);
      }
      const tx = VersionedTransaction.deserialize(
        Buffer.from(step.wire, "base64"),
      );
      assert.equal(base58(tx.signatures[0]!), step.signature);
      assert.ok(tx.message.staticAccountKeys[0]!.equals(wallet.publicKey));
      for (let i = 0; i < tx.message.header.numRequiredSignatures; i++) {
        const key = createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            tx.message.staticAccountKeys[i]!.toBuffer(),
          ]),
          format: "der",
          type: "spki",
        });
        assert.ok(
          verify(null, tx.message.serialize(), key, tx.signatures[i]!),
          "Invalid signed journal",
        );
      }
      let status = (
        await connection.getSignatureStatuses([step.signature], {
          searchTransactionHistory: true,
        })
      ).value[0];
      if (
        !status &&
        step.state === "finalized" &&
        Object.hasOwn(step, "error")
      ) {
        // A recorded finalized outcome is historical evidence; account checks below still run.
        assert.equal(step.error !== null, expectFailure);
        if (expectFailure) {
          assert.equal(
            (step.error as { InstructionError?: [number, { Custom?: number }] })
              .InstructionError?.[1]?.Custom,
            rejectionCodes[label],
          );
          if (rejectionCodes[label] === 6001)
            assert.equal(
              step.membershipRejectionVerified,
              true,
              "Missing verified rejection origin in historical journal",
            );
          rejectCodes[label] = step.error;
        }
        console.log(
          JSON.stringify({
            step: label,
            signature: step.signature,
            error: step.error,
            recoveredFinalized: true,
          }),
        );
        return step.signature;
      }
      if (!status) {
        assert.ok(
          (await connection.getBlockHeight("finalized")) <=
            step.lastValidBlockHeight,
          "Expired ambiguous transaction: inspect journal; no replacement is generated",
        );
        const sent = await connection.sendRawTransaction(
          Buffer.from(step.wire, "base64"),
          { skipPreflight: true, maxRetries: 0 },
        );
        assert.equal(sent, step.signature);
      }
      for (let i = 0; i < 90; i++) {
        status = (
          await connection.getSignatureStatuses([step.signature], {
            searchTransactionHistory: true,
          })
        ).value[0];
        if (status?.confirmationStatus === "finalized") break;
        await pause(local ? 250 : 1000);
      }
      assert.equal(
        status?.confirmationStatus,
        "finalized",
        "Transaction outcome remains ambiguous; resume this journal",
      );
      step.state = "finalized";
      step.error = status.err;
      await atomic(stateFile, state);
      assert.equal(
        status.err !== null,
        expectFailure,
        `${label}: unexpected finalized result ${JSON.stringify(status.err)}`,
      );
      if (expectFailure) {
        const error = status.err as {
          InstructionError?: [number, { Custom?: number }];
        };
        assert.equal(
          error.InstructionError?.[1]?.Custom,
          rejectionCodes[label],
          `${label}: failed for an unrelated reason`,
        );
        if (rejectionCodes[label] === 6001) {
          const detail = await connection.getTransaction(step.signature, {
            commitment: "finalized",
            maxSupportedTransactionVersion: 0,
          });
          assert.ok(
            detail?.meta?.logMessages?.some(
              (line) =>
                line ===
                `Program ${ACCOUNT_COMPRESSION_V1.toBase58()} failed: custom program error: 0x1771`,
            ),
            "Require the Account Compression membership rejection, not an unrelated 6001",
          );
          step.membershipRejectionVerified = true;
          await atomic(stateFile, state);
        }
      }
      if (expectFailure) rejectCodes[label] = status.err;
      console.log(
        JSON.stringify({
          step: label,
          signature: step.signature,
          error: status.err,
          bytes: Buffer.from(step.wire, "base64").length,
        }),
      );
      return step.signature;
    }
    async function rootAndNodes(leaf: Buffer, otherLeaf?: Buffer) {
      const levels: Buffer[][] = [
        Array.from({ length: 8 }, (_, i) =>
          i === 0 ? leaf : i === 1 && otherLeaf ? otherLeaf : Buffer.alloc(32),
        ),
      ];
      for (let level = 0; level < 3; level++) {
        const next: Buffer[] = [];
        for (let i = 0; i < levels[level]!.length; i += 2)
          next.push(
            Buffer.from(
              keccak_256(
                Buffer.concat([levels[level]![i]!, levels[level]![i + 1]!]),
              ),
            ),
          );
        levels.push(next);
      }
      const account = await connection.getAccountInfo(
        tree.publicKey,
        "finalized",
      );
      assert.ok(
        account &&
          !account.executable &&
          account.owner.equals(ACCOUNT_COMPRESSION_V1),
      );
      const active = Number(account.data.readBigUInt64LE(64));
      assert.ok(active >= 0 && active < 8);
      const actual = account.data.subarray(
        80 + active * 136,
        112 + active * 136,
      );
      assert.deepEqual(
        actual,
        levels[3]![0],
        "Known-leaf root does not match the current on-chain compression tree",
      );
      return {
        root: levels[3]![0]!,
        nodes: [levels[0]![1]!, levels[1]![1]!, levels[2]![1]!].map(
          (b) => new PublicKey(b),
        ),
      };
    }
    function proof(
      owner = wallet.publicKey,
      delegate = owner,
      nonce = 0n,
      index = 0,
    ): CnftControlProof {
      return {
        tree: tree.publicKey,
        owner,
        delegate,
        nonce,
        index,
        root: Buffer.alloc(32),
        dataHash: hashMetadataData(metadata),
        creatorHash: hashMetadataCreators(metadata.creators),
        expiresAt: 0n,
        nodes: [],
      };
    }
    async function chainTime() {
      const account = await connection.getAccountInfo(
        SYSVAR_CLOCK_PUBKEY,
        "finalized",
      );
      assert.ok(account && account.data.length === 40);
      return account.data.readBigInt64LE(32);
    }
    async function currentProof() {
      const value = proof(),
        leaf = cnftLeaf(value);
      Object.assign(value, await rootAndNodes(leaf));
      value.expiresAt = (await chainTime()) + 300n;
      return value;
    }
    function device(proof?: CnftControlProof): DeviceArgs {
      return {
        deviceId: id,
        key: deviceKey,
        curve: 1,
        capabilities,
        externalAsset: cnftAssetId(tree.publicKey, 0n),
        claimedGeohash: null,
        ...(proof ? { proofOfControl: proof } : {}),
      };
    }
    async function register(
      label: string,
      proto: Buffer,
      value: DeviceArgs,
      owner = wallet,
      signedValue = value,
      fail = false,
    ) {
      if (label !== "expired" && label !== "far-expiry") {
        const expiresAt = (await chainTime()) + 300n;
        if (value.proofOfControl)
          value = {
            ...value,
            proofOfControl: { ...value.proofOfControl, expiresAt },
          };
        if (signedValue.proofOfControl)
          signedValue = {
            ...signedValue,
            proofOfControl: { ...signedValue.proofOfControl, expiresAt },
          };
      }
      const { sign, createPrivateKey } = await import("node:crypto");
      const key = createPrivateKey({
        key: Buffer.concat([
          Buffer.from("302e020100300506032b657004220420", "hex"),
          owner.secretKey.subarray(0, 32),
        ]),
        type: "pkcs8",
        format: "der",
      });
      const authorization = assetControlAuthorization(
        program,
        wallet.publicKey,
        proto,
        signedValue,
        sign(
          null,
          assetControlDigest(program, wallet.publicKey, proto, signedValue),
          key,
        ),
      );
      const sig = await send(
        label,
        [
          authorization,
          registerDevice(program, wallet.publicKey, proto, value),
        ],
        [wallet],
        fail,
      );
      const address = registryAddresses(program, proto).device(id),
        account = await connection.getAccountInfo(address, "finalized");
      if (fail) {
        assert.equal(
          account,
          null,
          "Rejected ownership proof created a registry",
        );
        return sig;
      }
      assert.ok(
        account && !account.executable && account.owner.equals(program),
      );
      const linked = decodeDevice(account.data);
      assert.equal(linked.linked, true);
      assert.ok(linked.externalAsset?.equals(value.externalAsset!));
      assert.ok(linked.key.equals(deviceKey));
      return sig;
    }
    async function initialize(label: string, proto: Buffer) {
      return send(label, [
        initProtocol(program, wallet.publicKey, DEVNET_USDC, {
          protocolId: proto,
          epochSeconds: 604800,
          verifier: wallet.publicKey,
          policyVersion: 1,
          rewardPerSlot: 0n,
          slotsPerEpoch: 0,
        }),
      ]);
    }
    if (action === "prepare") {
      console.log(
        JSON.stringify({
          network: local ? "local-validator" : "devnet",
          program: c.program,
          tree: tree.publicKey.toBase58(),
          asset: cnftAssetId(tree.publicKey, 0n).toBase58(),
          protocolID: protocol.toString("hex"),
          deviceID: id.toString("hex"),
          payer: wallet.publicKey.toBase58(),
          balanceLamports: await connection.getBalance(
            wallet.publicKey,
            "finalized",
          ),
        }),
      );
      return;
    }
    if (action === "mint") {
      await send(
        "create-tree",
        (
          await createTree(umi, {
            merkleTree: treeSigner,
            maxDepth: 3,
            maxBufferSize: 8,
            canopyDepth: 0,
            public: false,
          })
        )
          .getInstructions()
          .map(toWeb3JsInstruction),
        [wallet, tree],
      );
      await send(
        "mint-demo-cnft",
        mintV1(umi, {
          merkleTree: treeSigner.publicKey,
          leafOwner: identity.publicKey,
          leafDelegate: identity.publicKey,
          metadata,
        })
          .getInstructions()
          .map(toWeb3JsInstruction),
      );
      const current = await currentProof();
      const config = await connection.getAccountInfo(
        cnftTreeConfig(tree.publicKey),
        "finalized",
      );
      assert.ok(config && config.data.readBigUInt64LE(80) === 1n);
      await atomic(path.join(directory, "asset-public.json"), {
        asset: cnftAssetId(tree.publicKey, 0n).toBase58(),
        tree: tree.publicKey.toBase58(),
        owner: wallet.publicKey.toBase58(),
        root: Buffer.from(current.root).toString("hex"),
        metadata,
      });
      return;
    }
    if (action === "register") {
      const unlinkedProtocol = createHash("sha256")
        .update("Pathnod/dev43/unlinked-control/v0")
        .update(protocol)
        .digest();
      await initialize("init-unlinked-control", unlinkedProtocol);
      await send("register-unlinked-control", [
        registerDevice(program, wallet.publicKey, unlinkedProtocol, device()),
      ]);
      const unlinked = await connection.getAccountInfo(
        registryAddresses(program, unlinkedProtocol).device(id),
        "finalized",
      );
      assert.ok(unlinked && unlinked.owner.equals(program));
      assert.equal(decodeDevice(unlinked.data).linked, false);
      await initialize("init-linked-protocol", protocol);
      await register(
        "register-linked-device",
        protocol,
        device(await currentProof()),
      );
      return;
    }
    if (action === "negative-tests") {
      assert.ok(
        local,
        "Adversarial mutations are restricted to the explicit local-validator test",
      );
      const proto = (name: string) =>
        createHash("sha256")
          .update("Pathnod/dev43/negative/v0")
          .update(protocol)
          .update(name)
          .digest();
      const wrongOwnerFile = path.join(directory, "negative-owner.json");
      let wrongOwner: Keypair;
      try {
        wrongOwner = Keypair.fromSecretKey(
          Uint8Array.from(await privateJSON(wrongOwnerFile)),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        wrongOwner = Keypair.generate();
        await atomic(wrongOwnerFile, [...wrongOwner.secretKey]);
      }
      const inputFile = path.join(directory, "negative-input.json");
      let value: CnftControlProof;
      try {
        const input = await privateJSON(inputFile);
        value = {
          tree: new PublicKey(input.tree),
          owner: new PublicKey(input.owner),
          delegate: new PublicKey(input.delegate),
          nonce: BigInt(input.nonce),
          index: input.index,
          root: Buffer.from(input.root, "hex"),
          dataHash: Buffer.from(input.dataHash, "hex"),
          creatorHash: Buffer.from(input.creatorHash, "hex"),
          expiresAt: (await chainTime()) + 300n,
          nodes: input.nodes.map((p: string) => new PublicKey(p)),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        value = await currentProof();
        await atomic(inputFile, {
          tree: value.tree.toBase58(),
          owner: value.owner.toBase58(),
          delegate: value.delegate.toBase58(),
          nonce: String(value.nonce),
          index: value.index,
          root: Buffer.from(value.root).toString("hex"),
          dataHash: Buffer.from(value.dataHash).toString("hex"),
          creatorHash: Buffer.from(value.creatorHash).toString("hex"),
          nodes: value.nodes.map((p) => p.toBase58()),
        });
      }
      for (const name of [
        "wrong-owner",
        "wrong-data",
        "swapped-metadata",
        "expired",
        "far-expiry",
        "missing-precompile",
        "forged-tree",
        "changed-owner",
      ])
        await initialize("init-" + name, proto(name));
      await register(
        "wrong-owner",
        proto("wrong-owner"),
        device({
          ...value,
          owner: wrongOwner.publicKey,
          delegate: wrongOwner.publicKey,
        }),
        wrongOwner,
        device({
          ...value,
          owner: wrongOwner.publicKey,
          delegate: wrongOwner.publicKey,
        }),
        true,
      );
      await register(
        "wrong-data",
        proto("wrong-data"),
        device({ ...value, dataHash: Buffer.alloc(32, 4) }),
        wallet,
        device({ ...value, dataHash: Buffer.alloc(32, 4) }),
        true,
      );
      await register(
        "swapped-metadata",
        proto("swapped-metadata"),
        { ...device(value), capabilities: capabilities ^ 1 },
        wallet,
        device(value),
        true,
      );
      const now = await chainTime(),
        expired = device({ ...value, expiresAt: now - 60n }),
        farExpiry = device({ ...value, expiresAt: now + 3600n });
      await register(
        "expired",
        proto("expired"),
        expired,
        wallet,
        expired,
        true,
      );
      await register(
        "far-expiry",
        proto("far-expiry"),
        farExpiry,
        wallet,
        farExpiry,
        true,
      );
      value.expiresAt = (await chainTime()) + 300n;
      await send(
        "missing-precompile",
        [
          registerDevice(
            program,
            wallet.publicKey,
            proto("missing-precompile"),
            device(value),
          ),
        ],
        [wallet],
        true,
      );
      const forged = registerDevice(
        program,
        wallet.publicKey,
        proto("forged-tree"),
        device(value),
      );
      forged.keys[6] = {
        pubkey: wallet.publicKey,
        isSigner: false,
        isWritable: false,
      };
      const { sign, createPrivateKey } = await import("node:crypto");
      const k = createPrivateKey({
        key: Buffer.concat([
          Buffer.from("302e020100300506032b657004220420", "hex"),
          wallet.secretKey.subarray(0, 32),
        ]),
        type: "pkcs8",
        format: "der",
      });
      await send(
        "forged-tree",
        [
          assetControlAuthorization(
            program,
            wallet.publicKey,
            proto("forged-tree"),
            device(value),
            sign(
              null,
              assetControlDigest(
                program,
                wallet.publicKey,
                proto("forged-tree"),
                device(value),
              ),
              k,
            ),
          ),
          forged,
        ],
        [wallet],
        true,
      );
      const stale = device(value);
      await send(
        "transfer-demo-asset",
        transfer(umi, {
          leafOwner: identity,
          leafDelegate: identity,
          newLeafOwner: umiKey(wrongOwner.publicKey.toBase58()),
          merkleTree: treeSigner.publicKey,
          root: value.root,
          dataHash: value.dataHash,
          creatorHash: value.creatorHash,
          nonce: 0n,
          index: 0,
          proof: value.nodes.map((n) => umiKey(n.toBase58())),
        })
          .getInstructions()
          .map(toWeb3JsInstruction),
      );
      await register(
        "changed-owner",
        proto("changed-owner"),
        stale,
        wallet,
        stale,
        true,
      );
      await atomic(path.join(directory, "negative-public.json"), rejectCodes);
      return;
    }
    const a = registryAddresses(program, protocol).device(id),
      snapshot = await connection.getAccountInfoAndContext(a, "finalized"),
      record = snapshot.value;
    assert.ok(record && !record.executable && record.owner.equals(program));
    assert.equal(record.data.length, 126);
    const registered = decodeDevice(record.data);
    assert.deepEqual(registered.deviceId, id);
    assert.deepEqual(registered.key, deviceKey);
    assert.equal(registered.curve, 1);
    assert.equal(registered.capabilities, capabilities);
    assert.equal(registered.claimedGeohash, null);
    assert.equal(registered.linked, true);
    assert.ok(
      registered.externalAsset?.equals(cnftAssetId(tree.publicKey, 0n)),
    );
    const report = {
      version: 1,
      network: local ? "local-validator" : "devnet",
      program: c.program,
      protocolID: protocol.toString("hex"),
      deviceID: id.toString("hex"),
      deviceKey: deviceKey.toString("hex"),
      capabilities,
      externalAsset: registered.externalAsset!.toBase58(),
      tree: tree.publicKey.toBase58(),
      registry: a.toBase58(),
      finalizedContextSlot: snapshot.context.slot,
      registeredAt: registered.registeredAt.toString(),
      linked: registered.linked,
      control:
        "Bubblegum v1 owner signature and current on-chain membership at registration",
      heliumAffiliation: false,
      transactions: Object.fromEntries(
        Object.entries(state.steps).map(([name, s]) => [
          name,
          { signature: s.signature, error: s.error ?? null },
        ]),
      ),
    };
    await atomic(path.join(directory, "report.json"), report);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await lock.close();
    await unlink(path.join(directory, "run.lock"));
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "DEV-43 demo failed");
  process.exitCode = 1;
});
