import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage, AddressLookupTableProgram, type AddressLookupTableAccount, Ed25519Program,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM,
  UPGRADEABLE_LOADER,
  decodeEnrollment,
  decodeDeviceEpoch,
  decodeObservationCommitment,
  decodeObservationVerifier,
  deviceId,
  discriminator,
  initProtocol,
  initializeEnrollmentAuthority,
  initializeObservationVerifier,
  publishRoot,
  registerDevice,
  registryAddresses,
  observationAddresses,
  appendObservationTree,
  DEFAULT_OBSERVATION_KEY_DIGEST,
  initializePayments, paymentAddresses, decodePayout, claimPayout, claimDigest, updatePolicy,
  publishConfidence, confidenceAuthorizationDigest, type ConfidenceAuthorization,
} from "@pathnod/solana";
import { computeConfidence, confidenceCommitment } from '../src/confidence.ts';
import { AppAttestGate } from "../src/app-attest-gate.ts";
import { ObserverEnrollmentService } from "../src/observer-enrollment.ts";
import { FakeEnrollmentGate } from "../tests/helpers/enrollment-gate.ts";
import {
  ObservationPolicyService,
  deviceChallengeDigest,
} from "../src/observation-policy.ts";
import { PinnedGroth16Verifier } from "../src/observation-groth16.ts";
import { SolanaObservationPolicySource } from "../src/observation-solana.ts";
import {
  ObservationSigner,
  authorizationInstruction,
  relayProofBytes,
} from "../src/observation-authorization.ts";
import {
  ObservationRelayer,
  type ObservationRelayPayload,
} from "../src/observation-relay.ts";
import { SolanaObservationRelayTransport } from "../src/solana-observation-relay.ts";
import { PathnodObservationSubmissionAdapter } from "../src/observation-adapter.ts";
import {
  decodeObservationTranscript,
  encodeObservationTranscript,
  observationTranscriptHash,
} from "../src/observation-transcript.ts";
import type { ObservationEnvelope } from "../src/observation-inbox.ts";
import { DeviceEligibilityService } from '../src/device-eligibility.ts';

const root = fileURLToPath(new URL("../../..", import.meta.url));
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]!,
    value = process.argv[i + 1];
  if (
    ![
      "--rpc",
      "--wallet",
      "--publisher-wallet",
      "--program",
      "--database",
      "--report",
      "--payments",
    ].includes(key) ||
    !value ||
    args.has(key)
  )
    throw Error(
      "Usage: observations:verify --rpc URL --wallet KEYPAIR --program ID --database FILE --report FILE [--publisher-wallet KEYPAIR]",
    );
  args.set(key, value);
}
const required = (key: string) => {
  const value = args.get(key);
  if (!value) throw Error(`Missing ${key}`);
  return value;
};
const raw = (hex: string) => Buffer.from(hex.replace(/^0x/, ""), "hex");
const hash = (...parts: Uint8Array[]) =>
  createHash("sha256").update(Buffer.concat(parts)).digest();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function outside(file: string) {
  const resolved = path.resolve(file),
    relative = path.relative(root, resolved);
  assert.ok(
    relative.startsWith("../") || path.isAbsolute(relative),
    "Keep test data outside Git",
  );
  return resolved;
}
async function main() {
  const payments = args.get('--payments') === 'yes';
  const rpc = new URL(required("--rpc")),
    local = ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname);
  assert.ok(
    local || rpc.href === "https://api.devnet.solana.com/",
    "Only local validator or official devnet",
  );
  const dbPath = outside(required("--database")),
    reportPath = outside(required("--report"));
  await mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const nativeFetch = globalThis.fetch;
  let requestQueue = Promise.resolve(), lastRequest = 0;
  const pacedFetch: typeof fetch = async (input, init) => {
    // Public devnet RPC is shared: serialize request starts rather than flooding it.
    if (!local) {
      const start = requestQueue.then(async () => {
        await sleep(Math.max(0, 500 - (Date.now() - lastRequest)));
        lastRequest = Date.now();
      });
      requestQueue = start.catch(() => {}); await start;
    }
    for (let attempt = 0; ; attempt++) {
      const response = await nativeFetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (local || response.status !== 429 || attempt >= 4) return response;
      await response.text(); await sleep(5_000 * (attempt + 1));
    }
  };
  // Source/transport readers must share this limiter too, not just the harness connection.
  if (!local) globalThis.fetch = pacedFetch;
  const connection = new Connection(rpc.href, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: pacedFetch,
  });
  const genesis = await connection.getGenesisHash();
  if (!local)
    assert.equal(genesis, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(await readFile(required("--wallet"), "utf8"))),
  );
  const publisher = args.has("--publisher-wallet")
    ? Keypair.fromSecretKey(
        Uint8Array.from(
          JSON.parse(await readFile(required("--publisher-wallet"), "utf8")),
        ),
      )
    : wallet;
  const program = new PublicKey(required("--program"));
  assert.notEqual(
    program.toBase58(),
    "5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd",
    "Use a disposable deployment",
  );
  const executable = await connection.getAccountInfo(program);
  assert.ok(
    executable?.executable && executable.owner.equals(UPGRADEABLE_LOADER),
    "Deploy the disposable test program first",
  );
  const payer = Keypair.generate(),
    other = Keypair.generate(),
    verifierKey = Keypair.generate();
  const signer = new ObservationSigner(verifierKey.secretKey.subarray(0, 32));
  const transactions: {
    name: string;
    signature: string;
    bytes: number;
    units: number | null | undefined;
  }[] = [];
  let lookup: AddressLookupTableAccount | undefined;
  async function prepared(
    instructions: TransactionInstruction[],
    signers: Keypair[] = [wallet],
  ) {
    const transaction = new Transaction({
      feePayer: signers[0]!.publicKey,
      ...(await connection.getLatestBlockhash("confirmed")),
    }).add(...instructions);
    if (lookup) {
      const latest = { blockhash:transaction.recentBlockhash!,lastValidBlockHeight:transaction.lastValidBlockHeight! };
      const versioned = new VersionedTransaction(new TransactionMessage({ payerKey:signers[0]!.publicKey,
        recentBlockhash:latest.blockhash,instructions }).compileToV0Message([lookup]));
      versioned.sign(signers);
      assert.ok(versioned.serialize().length <= 1232,'Transaction size limit');
      return Object.assign(versioned,{ recentBlockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,
        compileMessage:()=>versioned.message });
    }
    transaction.sign(...signers);
    assert.ok(transaction.serialize().length <= 1232, "Transaction size limit");
    return transaction;
  }
  async function send(
    name: string,
    instructions: TransactionInstruction[],
    signers: Keypair[] = [wallet],
  ) {
    const transaction = await prepared(instructions, signers);
    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      { skipPreflight: false, maxRetries: 5, preflightCommitment: "confirmed" },
    );
    await connection.confirmTransaction(
      {
        signature,
        blockhash: transaction.recentBlockhash!,
        lastValidBlockHeight: transaction.lastValidBlockHeight!,
      },
      "finalized",
    );
    const executed = await connection.getTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    assert.ok(executed?.meta);
    assert.equal(executed.meta.err, null);
    transactions.push({
      name,
      signature,
      bytes: transaction.serialize().length,
      units: executed.meta.computeUnitsConsumed,
    });
    console.log(
      `${name}: finalized (${executed.meta.computeUnitsConsumed} CU)`,
    );
    return signature;
  }
  const fieldFixtures = JSON.parse(
    await readFile(
      path.join(root, "fixtures/observations/transcript-v0.json"),
      "utf8",
    ),
  );
  const fixture = fieldFixtures.vectors[0];
  const proofs = JSON.parse(
    await readFile(
      path.join(root, "fixtures/observations/dev35-proofs.json"),
      "utf8",
    ),
  ) as {
    publicTestVectors: boolean;
    vectors: {
      secret: string;
      commitment: string;
      public: string[];
      proof: ObservationEnvelope["zk"]["proof"];
      proofBytes: string;
    }[];
  };
  assert.equal(proofs.publicTestVectors, true);
  const protocol = raw(fixture.transcript.protocolID),
    key = raw(fixture.transcript.publicKey),
    device = deviceId(key);
  const addresses = registryAddresses(program, protocol);
  assert.equal(
    await connection.getAccountInfo(addresses.config),
    null,
    "Use a fresh program/test database",
  );
  await send("fund_relayers", [
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: payer.publicKey,
      lamports: 100_000_000,
    }),
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: other.publicKey,
      lamports: 100_000_000,
    }),
  ]);
  let mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  if (local) {
    const created = Keypair.generate();
    mint = created.publicKey;
    await send(
      "create_mint",
      [
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: mint,
          space: 82,
          lamports: await connection.getMinimumBalanceForRentExemption(82),
          programId: TOKEN_PROGRAM,
        }),
        new TransactionInstruction({
          programId: TOKEN_PROGRAM,
          keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
          data: Buffer.concat([
            Buffer.from([20, 6]),
            wallet.publicKey.toBuffer(),
            Buffer.from([0]),
          ]),
        }),
      ],
      [wallet, created],
    );
  }
  const existingEnrollment = await connection.getAccountInfo(
    addresses.enrollment,
  );
  if (existingEnrollment)
    assert.ok(
      decodeEnrollment(existingEnrollment.data).authority.equals(
        publisher.publicKey,
      ),
    );
  else
    await send("initialize_enrollment_authority", [
      initializeEnrollmentAuthority(
        program,
        wallet.publicKey,
        publisher.publicKey,
      ),
    ]);
  await send('initialize_payments',[initializePayments(program,publisher.publicKey,mint,wallet.publicKey)],[publisher]);
  const verifierAddress = observationAddresses(
    program,
    protocol,
    device,
    42,
    raw(fixture.transcript.nullifier),
  ).verifierInfo;
  if (!(await connection.getAccountInfo(verifierAddress)))
    await send(
      "initialize_observation_verifier",
      [initializeObservationVerifier(program, publisher.publicKey)],
      [publisher],
    );
  const info = observationAddresses(
    program,
    protocol,
    device,
    42,
    raw(fixture.transcript.nullifier),
  ).verifierInfo;
  assert.equal(
    decodeObservationVerifier((await connection.getAccountInfo(info))!.data)
      .keyDigest,
    DEFAULT_OBSERVATION_KEY_DIGEST,
  );
  const slot = await connection.getSlot("finalized"),
    time = await connection.getBlockTime(slot);
  assert.ok(time);
  // The public proofs use epoch 42; the configured duration makes it the current real-chain epoch.
  const epochSeconds = Math.floor(time / 42);
  await send("init_protocol", [
    initProtocol(program, wallet.publicKey, mint, {
      protocolId: protocol,
      epochSeconds,
      verifier: verifierKey.publicKey,
      policyVersion: 1,
      rewardPerSlot: payments ? 50_000n : 0n,
      slotsPerEpoch: payments ? 3 : 0,
    }),
  ]);
  if (payments) {
    // Local validator: mint synthetic units. Devnet: use the wallet's real Circle test USDC ATA.
    const amount = Buffer.alloc(8); amount.writeBigUInt64LE(50_000n);
    if (local) await send('fund_escrow',[new TransactionInstruction({ programId:TOKEN_PROGRAM,
      keys:[{pubkey:mint,isSigner:false,isWritable:true},{pubkey:addresses.escrow,isSigner:false,isWritable:true},
        {pubkey:wallet.publicKey,isSigner:true,isWritable:false}], data:Buffer.concat([Buffer.from([7]),amount]) })]);
    else {
      const associated = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
      const ata = PublicKey.findProgramAddressSync([wallet.publicKey.toBuffer(),TOKEN_PROGRAM.toBuffer(),mint.toBuffer()],associated)[0];
      await send('fund_escrow',[new TransactionInstruction({programId:TOKEN_PROGRAM,
        keys:[{pubkey:ata,isSigner:false,isWritable:true},{pubkey:addresses.escrow,isSigner:false,isWritable:true},
          {pubkey:wallet.publicKey,isSigner:true,isWritable:false}],data:Buffer.concat([Buffer.from([3]),amount])})]);
    }
  }
  await send("register_device", [
    registerDevice(program, wallet.publicKey, protocol, {
      deviceId: device,
      key,
      curve: 1,
      capabilities: 2,
      externalAsset: null,
      claimedGeohash: null,
    }),
  ]);
  const eligibility=await DeviceEligibilityService.open(rpc.href,program.toBase58(),protocol.toString('hex'),mint.toBase58());
  const quote=await eligibility.slots(device.toString('hex'),'0');
  assert.equal(quote.open_slots,payments ? 1 : 0);
  assert.equal(quote.reward,payments ? '0.04' : '0');
  const appPolicy = {
    appID: "TESTTEAM01.xyz.pathnod.dev35.synthetic",
    environment: "development",
    allowedValidationCategories: [3],
    allowedBundleVersions: [],
  } as const;
  const gate = new AppAttestGate(dbPath, appPolicy),
    fake = new FakeEnrollmentGate(),
    enrollment = await ObserverEnrollmentService.open(dbPath, fake);
  const db = new DatabaseSync(dbPath);
  const observerKeys = proofs.vectors.map(() => ({
    id: randomBytes(32).toString("base64"),
    pair: generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
  }));
  for (let i = 0; i < proofs.vectors.length; i++) {
    const vector = proofs.vectors[i]!,
      observer = observerKeys[i]!,
      commitment = BigInt(vector.commitment).toString(16).padStart(64, "0");
    const challenge = enrollment.issueEnrollmentChallenge(
      "0x" + commitment,
      observer.id,
    );
    const path = enrollment.enroll(
      challenge.id,
      "0x" + commitment,
      observer.id,
      Buffer.from([42]),
    );
    assert.equal(BigInt(path.root).toString(), vector.public[0]);
    db.prepare(
      "INSERT INTO app_attest_keys VALUES (?, ?, ?, 'development', 0, NULL, NULL)",
    ).run(
      observer.id,
      observer.pair.publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
      appPolicy.appID,
    );
    await send(
      `publish_root_${i}`,
      [publishRoot(program, publisher.publicKey, raw(path.root), i + 1)],
      [publisher],
    );
  }
  const vkPath = path.join(
      root,
      "fixtures/observations/dev35-verification-key.json",
    ),
    vkBytes = await readFile(vkPath);
  const proofVerifier = new PinnedGroth16Verifier(
    vkPath,
    createHash("sha256").update(vkBytes).digest("hex"),
  );
  const source = await SolanaObservationPolicySource.open(
    rpc.href,
    program.toBase58(),
    protocol.toString("hex"),
    -90,
    1,
    genesis,
    proofVerifier.keyDigest,
  );
  const service = new ObservationPolicyService(
    dbPath,
    appPolicy,
    source,
    proofVerifier,
    { relay: { signer } },
  );
  const adapter = new PathnodObservationSubmissionAdapter(
    proofVerifier.keyDigest,
    mint,
  );
  const [createLookup,lookupAddress] = AddressLookupTableProgram.createLookupTable({authority:wallet.publicKey,
    payer:wallet.publicKey,recentSlot:await connection.getSlot('finalized')});
  await send('create_lookup_table',[createLookup]);
  const lookupKeys = [addresses.config,addresses.escrow,addresses.enrollment,addresses.device(device),mint,TOKEN_PROGRAM,
    SystemProgram.programId, new PublicKey('Sysvar1nstructions1111111111111111111111111'),
    paymentAddresses(program,protocol,Buffer.alloc(32)).settings,paymentAddresses(program,protocol,Buffer.alloc(32)).feeVault,
    ...proofs.vectors.map(v=>addresses.root(Buffer.from(BigInt(v.public[0]!).toString(16).padStart(64,'0'),'hex')))];
  await send('extend_lookup_table',[AddressLookupTableProgram.extendLookupTable({lookupTable:lookupAddress,
    authority:wallet.publicKey,payer:wallet.publicKey,addresses:[...new Map(lookupKeys.map(k=>[k.toBase58(),k])).values()]})]);
  lookup = (await connection.getAddressLookupTable(lookupAddress,{commitment:'finalized'})).value ?? undefined;
  assert.ok(lookup);
  const transport = await SolanaObservationRelayTransport.open(
    rpc.href,
    program.toBase58(),
    protocol.toString("hex"),
    payer,
    signer.publicKey,
    adapter,
    genesis,
    lookupAddress.toBase58(),
  );
  let worker = new ObservationRelayer(
    dbPath,
    source.target,
    signer.publicKey,
    transport,
  );
  const devicePrivate = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      createHash("sha256")
        .update("Pathnod/DEV31/public-device-seed/0")
        .digest(),
    ]),
    format: "der",
    type: "pkcs8",
  });
  const cbor = (value: string | Buffer | Map<string, Buffer>): Buffer => {
    const head = (major: number, n: number) =>
      n < 24
        ? Buffer.from([major * 32 + n])
        : Buffer.from([major * 32 + 24, n]);
    if (typeof value === "string") {
      const bytes = Buffer.from(value);
      return Buffer.concat([head(3, bytes.length), bytes]);
    }
    if (Buffer.isBuffer(value))
      return Buffer.concat([head(2, value.length), value]);
    return Buffer.concat([
      head(5, value.size),
      ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]),
    ]);
  };
  const bodies: ObservationEnvelope[] = [],
    payloads: ObservationRelayPayload[] = [];
  let frontier: Buffer[] = Array.from({ length: 16 }, () => Buffer.alloc(32));
  let expectedRoot: Buffer = Buffer.alloc(32);
  async function reject(
    name: string,
    instructions: TransactionInstruction[],
    code: number,
  ) {
    const transaction = await prepared(instructions, [payer]);
    const simulated = new VersionedTransaction(transaction.compileMessage());
    simulated.sign([payer]);
    const simulation = await connection.simulateTransaction(simulated, {
      commitment: "confirmed",
      sigVerify: true,
    });
    const error = simulation.value.err as {
      InstructionError?: [number, { Custom?: number }];
    } | null;
    assert.equal(
      error?.InstructionError?.[1]?.Custom,
      code,
      `${name}: ${JSON.stringify(simulation.value.err)}; ${JSON.stringify(simulation.value.logs)}`,
    );
    console.log(`Rejected ${name}: ${code}`);
  }
  try {
    for (let i = 0; i < proofs.vectors.length; i++) {
      const vector = proofs.vectors[i]!,
        observer = observerKeys[i]!,
        t = decodeObservationTranscript(raw(fixture.bytes));
      t.observationTimeMilliseconds = BigInt(Date.now());
      t.pseudonym = Buffer.from(
        BigInt(vector.public[5]!).toString(16).padStart(64, "0"),
        "hex",
      );
      t.nullifier = Buffer.from(
        BigInt(vector.public[4]!).toString(16).padStart(64, "0"),
        "hex",
      );
      const evidence =
        i === 1 ? Buffer.from("public DEV-35 service evidence") : undefined;
      t.evidenceHash = evidence ? hash(evidence) : Buffer.alloc(32);
      t.challenges.forEach((entry, j) => {
        entry.nonce = createHash("sha256")
          .update(`Pathnod/DEV35/test/${i}/${j}`)
          .digest();
        entry.deviceCounter = i * 3 + j + 1;
        entry.signature = sign(
          null,
          deviceChallengeDigest(t, entry),
          devicePrivate,
        );
      });
      const encoded = encodeObservationTranscript(t),
        transcriptHash = observationTranscriptHash(t),
        counter = Buffer.alloc(4);
      counter.writeUInt32BE(1);
      const auth = Buffer.concat([
        hash(Buffer.from(appPolicy.appID)),
        Buffer.from([0]),
        counter,
      ]);
      const assertion = cbor(
        new Map([
          [
            "signature",
            sign(
              "sha256",
              hash(auth, transcriptHash),
              observer.pair.privateKey,
            ),
          ],
          ["authenticatorData", auth],
        ]),
      );
      const body: ObservationEnvelope = {
        transcript: encoded.toString("base64"),
        assertion: assertion.toString("base64"),
        key_id: observer.id,
        zk: { proof: vector.proof, public: vector.public },
        ...(evidence ? { evidence: evidence.toString("base64") } : {}),
      };
      const receipt = await service.receive(body);
      assert.equal(receipt.policy_validated, true);
      bodies.push(body);
      const row = db
        .prepare(
          "SELECT payload FROM observation_relay_jobs WHERE transcript_hash=?",
        )
        .get(receipt.transcript_hash)!;
      const payload = JSON.parse(
        String(row.payload),
      ) as ObservationRelayPayload;
      payloads.push(payload);
      const valid = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 299999 }),
        authorizationInstruction(
          payload,
          payload.verifier,
          payload.verifierSignature,
        ),
        adapter.instruction(program, payer.publicKey, payload),
      ];
      if (i === 0) {
        const changedHash = { ...payload, transcriptHash: "aa".repeat(32) };
        await reject(
          "altered transcript hash",
          [
            valid[0]!,
            valid[1]!,
            adapter.instruction(program, payer.publicKey, changedHash),
          ],
          6112,
        );
        await reject(
          "missing Ed25519 instruction",
          [valid[0]!, valid[2]!],
          6112,
        );
        await reject(
          "wrong previous instruction",
          [valid[1]!, valid[0]!, valid[2]!],
          6112,
        );
        const badProof = Buffer.from(payload.proofBytes, "hex");
        badProof.fill(0, 192, 256);
        await reject(
          "corrupted Groth16 C",
          [
            valid[0]!,
            valid[1]!,
            adapter.instruction(program, payer.publicKey, {
              ...payload,
              proofBytes: badProof.toString("hex"),
            }),
          ],
          6000,
        );
        const badEvidence = { ...payload, evidenceHash: "11".repeat(32) };
        await reject(
          "unsigned evidence hash",
          [
            valid[0]!,
            valid[1]!,
            adapter.instruction(program, payer.publicKey, badEvidence),
          ],
          6112,
        );
        const wrongSigner = new ObservationSigner(Buffer.alloc(32, 8));
        await reject(
          "wrong verifier key",
          [
            valid[0]!,
            authorizationInstruction(
              payload,
              wrongSigner.publicKey,
              wrongSigner.sign(payload),
            ),
            valid[2]!,
          ],
          6112,
        );
        const noncanonical = new TransactionInstruction({
          programId: program,
          keys: valid[2]!.keys,
          data: Buffer.from(valid[2]!.data),
        });
        noncanonical.data.fill(255, 296, 328);
        await reject(
          "noncanonical public field",
          [valid[0]!, valid[1]!, noncanonical],
          6000,
        );
        const aliasedEpoch = new TransactionInstruction({
          programId: program,
          keys: valid[2]!.keys,
          data: Buffer.from(valid[2]!.data),
        });
        aliasedEpoch.data[360] = 1;
        await reject(
          "oversized epoch scalar",
          [valid[0]!, valid[1]!, aliasedEpoch],
          6113,
        );
        const otherDeviceKey = raw(
            fieldFixtures.vectors[1].transcript.publicKey,
          ),
          otherDevice = deviceId(otherDeviceKey);
        await send("register_other_device", [
          registerDevice(program, wallet.publicKey, protocol, {
            deviceId: otherDevice,
            key: otherDeviceKey,
            curve: 1,
            capabilities: 2,
            externalAsset: null,
            claimedGeohash: null,
          }),
        ]);
        const wrongDevice = new TransactionInstruction({
          programId: program,
          keys: valid[2]!.keys.map((item) => ({ ...item })),
          data: valid[2]!.data,
        });
        wrongDevice.keys[1]!.pubkey = addresses.device(otherDevice);
        wrongDevice.keys[5]!.pubkey = addresses.epoch(otherDevice, 42);
        await reject(
          "wrong registered device binding",
          [valid[0]!, valid[1]!, wrongDevice],
          6113,
        );
        const unregisteredDevice = deviceId(Buffer.alloc(32, 17));
        const missingDevice = new TransactionInstruction({
          programId: program,
          keys: valid[2]!.keys.map((item) => ({ ...item })),
          data: valid[2]!.data,
        });
        missingDevice.keys[1]!.pubkey = addresses.device(unregisteredDevice);
        missingDevice.keys[5]!.pubkey = addresses.epoch(unregisteredDevice, 42);
        await reject(
          "unregistered device",
          [valid[0]!, valid[1]!, missingDevice],
          3012,
        );
        const wrongSysvar = new TransactionInstruction({
          programId: program,
          keys: valid[2]!.keys.map((item) => ({ ...item })),
          data: valid[2]!.data,
        });
        wrongSysvar.keys[6]!.pubkey = SystemProgram.programId;
        await reject(
          "wrong Instructions sysvar",
          [valid[0]!, valid[1]!, wrongSysvar],
          2012,
        );
        const candidate = await prepared(valid, [payer]),
          candidateVersioned = new VersionedTransaction(
            candidate.compileMessage(),
          );
        candidateVersioned.sign([payer]);
        const simulated = await connection.simulateTransaction(
          candidateVersioned,
          { commitment: "confirmed", sigVerify: true },
        );
        assert.equal(
          simulated.value.err,
          null,
          JSON.stringify(simulated.value.logs),
        );
        assert.ok((simulated.value.unitsConsumed ?? 300000) < 300000);
        console.log(
          `First complete observation: ${(await prepared(valid, [payer])).serialize().length} bytes, ${simulated.value.unitsConsumed} CU`,
        );
        const lost = {
          ...transport,
          target: transport.target,
          eligible: transport.eligible.bind(transport),
          prepare: transport.prepare.bind(transport),
          inspect: transport.inspect.bind(transport),
          expired: transport.expired.bind(transport),
          confirmExisting: transport.confirmExisting.bind(transport),
          send: async (transaction: Parameters<typeof transport.send>[0]) => {
            await transport.send(transaction);
            throw Error("Injected lost RPC response after send");
          },
        };
        await worker.close();
        worker = new ObservationRelayer(
          dbPath,
          source.target,
          signer.publicKey,
          lost,
        );
        await worker.tick();
        assert.equal(
          worker.status(receipt.transcript_hash)?.status,
          "submitted",
        );
        await worker.close();
        worker = new ObservationRelayer(
          dbPath,
          source.target,
          signer.publicKey,
          transport,
        );
      } else {
        // An independent relayer submits the same authorized job; this worker must reconcile the real commitment.
        await send(
          "external_submit",
          [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 299999 }),
            valid[1]!,
            adapter.instruction(program, other.publicKey, payload),
          ],
          [other],
        );
      }
      for (let attempt = 0; attempt < 40; attempt++) {
        await sleep(1000);
        await worker.tick();
        if (worker.status(receipt.transcript_hash)?.status === "confirmed")
          break;
      }
      assert.equal(worker.status(receipt.transcript_hash)?.status, "confirmed");
      assert.equal(worker.status(receipt.transcript_hash)?.on_chain, true);
      const record = await connection.getAccountInfo(
        observationAddresses(
          program,
          protocol,
          device,
          42,
          raw(payload.nullifier),
        ).commitment,
        "finalized",
      );
      assert.ok(record);
      assert.ok(record.owner.equals(program));
      assert.equal(
        decodeObservationCommitment(record.data).transcriptHash.toString("hex"),
        payload.transcriptHash,
      );
      const state = decodeDeviceEpoch(
        (await connection.getAccountInfo(
          addresses.epoch(device, 42),
          "finalized",
        ))!.data,
      );
      const next = appendObservationTree(
        frontier,
        i,
        raw(payload.transcriptHash),
      );
      frontier = next.frontier;
      expectedRoot = next.root;
      assert.equal(state.independentObservers, i + 1);
      assert.equal(state.paidSlotsUsed, payments ? 1 : 0);
      assert.equal(decodeObservationCommitment(record.data).slotPaid,payments && i===0);
      assert.ok(state.observationRoot.equals(expectedRoot));
      assert.equal(state.confidenceCommitment.toString('hex'),'00'.repeat(32),'New observations invalidate previous confidence');
      const confidenceInputs=bodies.map(b=>({transcript:b.transcript,reenrollmentCount:null,...(b.evidence===undefined?{}:{evidence:b.evidence})}));
      const confidenceReport=computeConfidence({program:program.toBase58(),protocolID:protocol.toString('hex'),deviceID:device.toString('hex'),
        epoch:42,policyVersion:1,epochSeconds,evaluatedAtMilliseconds:Date.now(),observationRoot:expectedRoot.toString('hex'),
        transcriptOrder:payloads.map(p=>p.transcriptHash),claimedGeohash6:null},confidenceInputs);
      const confidenceArgs:ConfidenceAuthorization={epoch:42,policyVersion:1,evaluatedAtMilliseconds:BigInt(confidenceReport.scope.evaluatedAtMilliseconds),
        observationRoot:expectedRoot.toString('hex'),observerCount:i+1,previousCommitment:'00'.repeat(32),commitment:confidenceCommitment(confidenceReport)};
      const confidenceEd=(a:ConfidenceAuthorization,key:ObservationSigner=signer)=>{
        const hash=confidenceAuthorizationDigest(program,protocol,device,a);
        return Ed25519Program.createInstructionWithPublicKey({publicKey:new PublicKey(key.publicKey).toBuffer(),message:hash,signature:Buffer.from(key.signClaimDigest(hash),'hex')});
      };
      await reject('confidence wrong verifier',[confidenceEd(confidenceArgs,new ObservationSigner(Buffer.alloc(32,8))),publishConfidence(program,protocol,device,confidenceArgs)],6112);
      const staleConfidence={...confidenceArgs,observationRoot:'09'.repeat(32)};
      await reject('confidence stale tree',[confidenceEd(staleConfidence),publishConfidence(program,protocol,device,staleConfidence)],6118);
      const wrongPolicy={...confidenceArgs,policyVersion:2};
      await reject('confidence wrong policy',[confidenceEd(wrongPolicy),publishConfidence(program,protocol,device,wrongPolicy)],6102);
      await send(`publish_confidence_${i+1}`,[confidenceEd(confidenceArgs),publishConfidence(program,protocol,device,confidenceArgs)]);
      const published=decodeDeviceEpoch((await connection.getAccountInfo(addresses.epoch(device,42),'finalized'))!.data);
      assert.equal(published.confidenceCommitment.toString('hex'),confidenceArgs.commitment);
      assert.equal(published.independentObservers,i+1);assert.equal(published.paidSlotsUsed,state.paidSlotsUsed);assert.deepEqual(published.observationRoot,expectedRoot);
      await reject('confidence replay cannot overwrite current commitment',[confidenceEd(confidenceArgs),publishConfidence(program,protocol,device,confidenceArgs)],6118);
      await reject("duplicate nullifier", valid, 6001);
      const unchanged = decodeDeviceEpoch(
        (await connection.getAccountInfo(
          addresses.epoch(device, 42),
          "finalized",
        ))!.data,
      );
      assert.equal(unchanged.independentObservers, i + 1);
      assert.ok(unchanged.observationRoot.equals(expectedRoot));
      assert.deepEqual(await service.receive(body), receipt);
      assert.equal(
        Number(
          db.prepare("SELECT COUNT(*) AS n FROM observation_relay_jobs").get()!
            .n,
        ),
        i + 1,
      );
    }
    if (payments) {
      const payload = payloads[0]!, a = paymentAddresses(program,protocol,raw(payload.pseudonym));
      const credited = decodePayout((await connection.getAccountInfo(a.payout,'finalized'))!.data);
      assert.equal(credited.gross,50_000n);assert.equal(credited.fees,10_000n);assert.equal(credited.available,40_000n);
      assert.equal((await connection.getTokenAccountBalance(a.feeVault,'finalized')).value.amount,'10000');
      assert.equal((await connection.getTokenAccountBalance(a.vault,'finalized')).value.amount,'40000');
      assert.equal((await connection.getTokenAccountBalance(addresses.escrow,'finalized')).value.amount,'0');
      const withdrawal = Keypair.generate(), destination = Keypair.generate();
      await send('prepare_withdrawal',[SystemProgram.transfer({fromPubkey:wallet.publicKey,toPubkey:withdrawal.publicKey,lamports:10_000_000}),
        SystemProgram.createAccount({fromPubkey:wallet.publicKey,newAccountPubkey:destination.publicKey,space:165,
          lamports:await connection.getMinimumBalanceForRentExemption(165),programId:TOKEN_PROGRAM}),
        new TransactionInstruction({programId:TOKEN_PROGRAM,keys:[{pubkey:destination.publicKey,isSigner:false,isWritable:true},
          {pubkey:mint,isSigner:false,isWritable:false}],data:Buffer.concat([Buffer.from([18]),withdrawal.publicKey.toBuffer()])})], [wallet,destination]);
      const expiry=BigInt(Math.floor(Date.now()/1000)+240), auth = {program:program.toBase58(),payout:a.payout.toBase58(),mint:mint.toBase58(),
        withdrawalKey:withdrawal.publicKey.toBase58(),destination:destination.publicKey.toBase58(),amount:'40000',nonce:'0',expiresAt:String(expiry),policyVersion:1};
      const claim = claimPayout(program,protocol,raw(payload.pseudonym),mint,withdrawal.publicKey,destination.publicKey,40_000n,0n,expiry);
      const ed = Ed25519Program.createInstructionWithPublicKey({publicKey:verifierKey.publicKey.toBuffer(),
        message:claimDigest(auth),signature:Buffer.from(signer.signClaimDigest(claimDigest(auth)),'hex')});
      const wrong = claimPayout(program,protocol,raw(payload.pseudonym),mint,other.publicKey,destination.publicKey,40_000n,0n,expiry);
      const bad = await prepared([ed,wrong],[other]);
      const sim = new VersionedTransaction(bad.compileMessage());sim.sign([other]);
      assert.ok((await connection.simulateTransaction(sim,{sigVerify:true})).value.err,'Wrong destination owner must fail');
      for (const invalid of [claim,
        claimPayout(program,protocol,raw(payload.pseudonym),mint,withdrawal.publicKey,destination.publicKey,40_001n,0n,expiry),
        claimPayout(program,protocol,raw(payload.pseudonym),mint,withdrawal.publicKey,destination.publicKey,40_000n,1n,expiry),
        claimPayout(program,protocol,raw(payload.pseudonym),mint,withdrawal.publicKey,destination.publicKey,40_000n,0n,BigInt(Math.floor(Date.now()/1000)-1))]) {
        const unsigned=new VersionedTransaction((await prepared([invalid],[withdrawal])).compileMessage());
        assert.ok((await connection.simulateTransaction(unsigned,{sigVerify:false})).value.err,'Unsafe first claim must fail');
      }
      await send('claim_payout',[ed,claim],[withdrawal]);
      const done = decodePayout((await connection.getAccountInfo(a.payout,'finalized'))!.data);
      assert.equal(done.available,0n);assert.equal(done.withdrawn,40_000n);assert.equal(done.nonce,1n);
      assert.equal((await connection.getTokenAccountBalance(destination.publicKey,'finalized')).value.amount,'40000');
      const replay = await prepared([ed,claim],[withdrawal]), replayed = new VersionedTransaction(replay.compileMessage());replayed.sign([withdrawal]);
      assert.ok((await connection.simulateTransaction(replayed,{sigVerify:true})).value.err,'Double claim must fail');
      await send('update_policy',[updatePolicy(program,protocol,wallet.publicKey,2,verifierKey.publicKey,60_000n,1)]);
      assert.equal(decodePayout((await connection.getAccountInfo(a.payout,'finalized'))!.data).withdrawn,40_000n);
    }
    for (let i = 0; i < 4; i++) {
      const rotated = Buffer.alloc(32);
      rotated[31] = 100 + i;
      await send(
        `rotate_root_${i}`,
        [publishRoot(program, publisher.publicKey, rotated, 2)],
        [publisher],
      );
    }
    const inactive = { ...payloads[0]!, nullifier: "00".repeat(31) + "7b" };
    const inactiveProof = Buffer.from(inactive.proofBytes, "hex");
    raw(inactive.nullifier).copy(inactiveProof, 384);
    inactive.proofBytes = inactiveProof.toString("hex");
    inactive.verifierSignature = signer.sign(inactive);
    await reject(
      "inactive published root",
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 299999 }),
        authorizationInstruction(
          inactive,
          inactive.verifier,
          inactive.verifierSignature,
        ),
        adapter.instruction(program, payer.publicKey, inactive),
      ],
      6108,
    );
    const signature = worker.status(payloads[0]!.transcriptHash)?.signature;
    if (typeof signature === "string") {
      const executed = await connection.getTransaction(signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      assert.ok(executed?.meta);
      assert.equal(executed.meta.err, null);
      assert.ok((executed.meta.computeUnitsConsumed ?? 300000) < 300000);
      transactions.push({
        name: "worker_submit",
        signature,
        bytes: Buffer.from(String(db.prepare('SELECT wire FROM observation_relay_jobs WHERE transcript_hash=?').get(payloads[0]!.transcriptHash)!.wire),'base64').length,
        units: executed.meta.computeUnitsConsumed,
      });
    }
    const report = {
      publicSyntheticTests: true,
      genesis,
      program: program.toBase58(),
      protocol: protocol.toString("hex"),
      device: device.toString("hex"),
      verificationKeyDigest: proofVerifier.keyDigest,
      observers: 2,
      independentObservers: 2,
      paidSlotsUsed: payments ? 1 : 0,
      payoutsTested: payments,
      lookupTable:lookupAddress.toBase58(),
      transactions,
      lostResponseRestart: true,
      externalSubmissionReconciled: true,
      duplicatesRejected: true,
      signatureV1Evidence: true,
      confidencePublicationTested: true,
      staleConfidenceRejected: true,
      confidenceInvalidatedOnNewObservation: true,
    };
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(JSON.stringify(report));
  } finally {
    await worker.close();
    service.close();
    db.close();
    enrollment.close();
    gate.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
