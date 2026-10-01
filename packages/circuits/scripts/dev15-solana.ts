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
import { convertProof, convertVerificationKey, PUBLIC_INPUT_ORDER, verificationComputeUnits } from "../src/groth16-solana.js";
import { BN254_SCALAR_FIELD } from "../src/field.js";

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  const value = process.argv[i + 1];
  if (!["--artifacts", "--rpc", "--wallet", "--program"].includes(name) || !value || options.has(name)) {
    throw new Error("Usage: dev15:verify --artifacts DIR --rpc URL --wallet KEYPAIR --program PROGRAM_ID");
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
  const inputs = await json("public.json");
  const checked = await run(path.join(packageRoot, "node_modules/.bin/snarkjs"), [
    "groth16", "verify", path.join(artifacts, "verification_key.json"),
    path.join(artifacts, "public.json"), path.join(artifacts, "proof.json"),
  ]);
  assert.match(checked.stdout + checked.stderr, /OK!/);
  const keyBytes = convertVerificationKey(vk);
  const proofBytes = convertProof(proof, inputs);
  await writeFile(path.join(artifacts, "dev15-key.bin"), keyBytes);
  await writeFile(path.join(artifacts, "dev15-proof.bin"), proofBytes);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("dev15-vk"), wallet.publicKey.toBuffer()], program);
  const configData = Buffer.concat([discriminator("account", "Groth16SpikeConfig"), wallet.publicKey.toBuffer(), keyBytes]);
  const existing = await connection.getAccountInfo(config);
  const instruction = (name: string, data: Buffer, keys: TransactionInstruction["keys"]) => new TransactionInstruction({
    programId: program, keys, data: Buffer.concat([discriminator("global", name), data]),
  });
  async function signed(instructions: TransactionInstruction[]): Promise<Transaction> {
    const tx = new Transaction({ feePayer: wallet.publicKey, ...(await connection.getLatestBlockhash()) }).add(...instructions);
    tx.sign(wallet);
    assert.ok(tx.serialize().length <= 1232, "Transaction exceeds Solana packet size");
    return tx;
  }
  async function send(tx: Transaction): Promise<string> {
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    // HTTP polling also works when websocket access is unavailable.
    for (let i = 0; i < 120; i++) {
      const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status) {
        assert.equal(status.err, null, `Transaction failed: ${signature}`);
        if (["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) return signature;
      }
      assert.ok(await connection.getBlockHeight() <= tx.lastValidBlockHeight!, `Transaction expired: ${signature}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Confirmation timed out: ${signature}; inspect status before retrying`);
  }
  if (existing) {
    assert.ok(existing.owner.equals(program) && existing.data.equals(configData), "Existing immutable config has another key; use a fresh test wallet");
  } else {
    // The 960-byte VK just fits the packet; do not add budget instructions here.
    await send(await signed([instruction("initialize_groth16_spike", keyBytes, [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ])]));
  }
  const verify = (data: Buffer) => [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    instruction("verify_groth16_spike", data, [{ pubkey: config, isSigner: false, isWritable: false }]),
  ];
  // Negative cases must fail specifically inside the verifier (custom 6000),
  // not from packet size, missing accounts or an exhausted CU budget.
  const tampered = [...inputs as string[]];
  tampered[0] = ((BigInt(tampered[0]) + 1n) % BN254_SCALAR_FIELD).toString();
  const corrupted = Buffer.from(proofBytes);
  corrupted.fill(0, 192, 256); // Replace C with infinity: invalid for this fixture.
  for (const [name, data] of [["altered public root", convertProof(proof, tampered)], ["corrupted proof C", corrupted]] as const) {
    const simulation = await connection.simulateTransaction(await signed(verify(data)));
    assert.deepEqual(simulation.value.err, { InstructionError: [1, { Custom: 6000 }] },
      `${name} must be rejected by the verifier; logs=${JSON.stringify(simulation.value.logs)}; units=${simulation.value.unitsConsumed}`);
    console.log(`Rejected: ${name}`);
  }
  const signature = await send(await signed(verify(proofBytes)));
  let transaction = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  for (let i = 0; !transaction && i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    transaction = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  }
  assert.ok(transaction?.meta && transaction.meta.err === null, "Confirmed transaction metadata missing");
  const verificationCU = verificationComputeUnits(transaction.meta.logMessages ?? []);
  assert.ok(verificationCU > 0 && verificationCU < 300_000, "Verification must use <300k CU");
  const report = { developmentOnly: true, rpc: rpc.href, genesis, program: program.toBase58(),
    config: config.toBase58(), signature, publicInputOrder: PUBLIC_INPUT_ORDER,
    verificationCU, transactionCU: transaction.meta.computeUnitsConsumed, budget: 400_000,
    keySha256: createHash("sha256").update(keyBytes).digest("hex"),
    negativeCases: ["altered public root rejected", "corrupted proof C rejected"] };
  await writeFile(path.join(artifacts, "dev15-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
