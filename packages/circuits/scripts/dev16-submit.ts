import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
} from "@solana/web3.js";
import { BN254_SCALAR_FIELD, parseCanonicalFieldElement, toHex32 } from "../src/field.js";
import { convertProof, convertVerificationKey, PUBLIC_INPUT_ORDER, verificationComputeUnits } from "../src/groth16-solana.js";

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  const value = process.argv[i + 1];
  if (!["--artifacts", "--rpc", "--wallet", "--program"].includes(name) || !value || options.has(name)) {
    throw new Error("Usage: dev16:submit --artifacts DIR --rpc URL --wallet KEYPAIR --program PROGRAM_ID");
  }
  options.set(name, value);
}
function required(name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function discriminator(namespace: string, name: string): Buffer {
  return createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);
}
function scalar(value: unknown): Buffer {
  return Buffer.from(toHex32(parseCanonicalFieldElement(value)).slice(2), "hex");
}
function submission(proofBytes: Buffer): Buffer {
  assert.equal(proofBytes.length, 480);
  return Buffer.concat([proofBytes.subarray(256), proofBytes.subarray(0, 256)]);
}

async function main(): Promise<void> {
  const artifacts = await realpath(required("--artifacts"));
  const relative = path.relative(repoRoot, artifacts);
  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "Keep generated artifacts outside Git");
  const rpc = new URL(required("--rpc"));
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname);
  assert.ok(local || rpc.href === "https://api.devnet.solana.com/", "Only localhost or official devnet is allowed");
  const connection = new Connection(rpc.href, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (!local) assert.equal(genesis, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "Not devnet");
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(required("--wallet"), "utf8"))));
  const program = new PublicKey(required("--program"));
  assert.equal((await connection.getAccountInfo(program))?.executable, true, "Program is not deployed");
  const json = async (name: string): Promise<unknown> => JSON.parse(await readFile(path.join(artifacts, name), "utf8"));
  const vk = await json("verification_key.json");
  const proof = await json("proof.json");
  const inputs = await json("public.json") as string[];
  const checked = await run(path.join(packageRoot, "node_modules/.bin/snarkjs"), [
    "groth16", "verify", path.join(artifacts, "verification_key.json"),
    path.join(artifacts, "public.json"), path.join(artifacts, "proof.json"),
  ]);
  assert.match(checked.stdout + checked.stderr, /OK!/);
  const keyBytes = convertVerificationKey(vk);
  const proofBytes = convertProof(proof, inputs);
  const nullifier = scalar(inputs[4]);
  await writeFile(path.join(artifacts, "dev16-key.bin"), keyBytes);
  await writeFile(path.join(artifacts, "dev16-proof.bin"), proofBytes);

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("dev15-vk"), wallet.publicKey.toBuffer()], program);
  const commitmentFor = (seed: Buffer) => PublicKey.findProgramAddressSync([Buffer.from("obs"), seed], program)[0];
  const commitment = commitmentFor(nullifier);
  const instruction = (name: string, data: Buffer, keys: TransactionInstruction["keys"]) => new TransactionInstruction({
    programId: program, keys, data: Buffer.concat([discriminator("global", name), data]),
  });
  async function signed(instructions: TransactionInstruction[], payer: Keypair): Promise<Transaction> {
    const tx = new Transaction({ feePayer: payer.publicKey, ...(await connection.getLatestBlockhash()) }).add(...instructions);
    tx.sign(payer);
    assert.ok(tx.serialize().length <= 1232, "Transaction exceeds Solana packet size");
    return tx;
  }
  async function send(tx: Transaction, expectedError: unknown = null) {
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: expectedError !== null });
    for (let i = 0; i < 120; i++) {
      const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status && ["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
        assert.deepEqual(status.err, expectedError, `Unexpected transaction status: ${signature}`);
        let transaction = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
        for (let retry = 0; !transaction && retry < 20; retry++) {
          await new Promise(resolve => setTimeout(resolve, 500));
          transaction = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
        }
        assert.ok(transaction?.meta, `Confirmed transaction metadata missing: ${signature}`);
        assert.deepEqual(transaction.meta.err, expectedError);
        return { signature, meta: transaction.meta, bytes: tx.serialize().length };
      }
      assert.ok(await connection.getBlockHeight() <= tx.lastValidBlockHeight!, `Transaction expired: ${signature}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Confirmation timed out: ${signature}`);
  }
  const existingConfig = await connection.getAccountInfo(config);
  const configData = Buffer.concat([discriminator("account", "Groth16SpikeConfig"), wallet.publicKey.toBuffer(), keyBytes]);
  if (existingConfig) {
    assert.ok(existingConfig.owner.equals(program) && existingConfig.data.equals(configData), "Existing config has another key; use a fresh test wallet");
  } else {
    await send(await signed([instruction("initialize_groth16_spike", keyBytes, [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ])], wallet));
  }
  assert.equal(await connection.getAccountInfo(commitment), null, "Use a fresh program for this synthetic nullifier");

  const submit = (data: Buffer, target: PublicKey, payer: PublicKey) => [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    instruction("submit_observation", data, [
      { pubkey: config, isSigner: false, isWritable: false },
      { pubkey: target, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ]),
  ];
  const invalidProof = { InstructionError: [1, { Custom: 6000 }] };
  const duplicateNullifier = { InstructionError: [1, { Custom: 6001 }] };
  const corrupted = Buffer.from(proofBytes);
  corrupted.fill(0, 192, 256);
  const badProof = await send(await signed(submit(submission(corrupted), commitment, wallet.publicKey), wallet), invalidProof);
  assert.equal(await connection.getAccountInfo(commitment), null, "Invalid proof created a commitment");

  const changedInputs = [...inputs];
  changedInputs[4] = ((BigInt(changedInputs[4]) + 1n) % BN254_SCALAR_FIELD).toString();
  const changedNullifier = scalar(changedInputs[4]);
  const changedCommitment = commitmentFor(changedNullifier);
  const changedProof = convertProof(proof, changedInputs);
  const badInput = await send(await signed(submit(submission(changedProof), changedCommitment, wallet.publicKey), wallet), invalidProof);
  assert.equal(await connection.getAccountInfo(changedCommitment), null, "Invalid public input created a commitment");

  const accepted = await send(await signed(submit(submission(proofBytes), commitment, wallet.publicKey), wallet));
  const account = await connection.getAccountInfo(commitment);
  assert.ok(account && account.owner.equals(program), "Commitment PDA is missing");
  const expectedPrefix = Buffer.concat([
    discriminator("account", "ObservationCommitment"), Buffer.from([1]), nullifier,
    ...inputs.map(scalar), config.toBuffer(), wallet.publicKey.toBuffer(),
  ]);
  assert.equal(account.data.length, expectedPrefix.length + 8);
  assert.ok(account.data.subarray(0, expectedPrefix.length).equals(expectedPrefix), "Commitment fields differ from verified inputs");
  const acceptedSlot = account.data.readBigUInt64LE(expectedPrefix.length).toString();

  const second = Keypair.generate();
  await send(await signed([SystemProgram.transfer({
    fromPubkey: wallet.publicKey, toPubkey: second.publicKey, lamports: 10_000_000,
  })], wallet));
  const replay = await send(await signed(submit(submission(proofBytes), commitment, second.publicKey), second), duplicateNullifier);
  assert.match((replay.meta.logMessages ?? []).join("\n"), /E_NULLIFIER/);
  assert.ok((await connection.getAccountInfo(commitment))?.data.equals(account.data), "Replay changed the commitment");

  const verificationCU = verificationComputeUnits(accepted.meta.logMessages ?? []);
  assert.ok(verificationCU > 0 && verificationCU < 300_000, "Verification must use <300k CU");
  assert.ok((accepted.meta.computeUnitsConsumed ?? 400_000) < 400_000, "Submission exceeded CU budget");
  const report = {
    developmentOnly: true, rpc: rpc.href, genesis, program: program.toBase58(), config: config.toBase58(),
    commitment: commitment.toBase58(), nullifier: inputs[4], acceptedSlot,
    acceptedSignature: accepted.signature, duplicateSignature: replay.signature,
    invalidProofSignature: badProof.signature, invalidInputSignature: badInput.signature,
    publicInputOrder: PUBLIC_INPUT_ORDER, verificationCU,
    transactionCU: accepted.meta.computeUnitsConsumed, transactionBytes: accepted.bytes,
    budget: 400_000, keySha256: createHash("sha256").update(keyBytes).digest("hex"),
    duplicateError: "E_NULLIFIER (6001)", invalidProofError: "InvalidProof (6000)",
  };
  await writeFile(path.join(artifacts, "dev16-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
