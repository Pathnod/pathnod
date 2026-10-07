import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Ed25519Program, Keypair, PublicKey, Transaction, TransactionInstruction, type AccountInfo } from "@solana/web3.js";
import { discriminator } from "@pathnod/solana";
import { eligibilityAccounts } from "./helpers/eligibility-accounts.ts";
import { relayProofBytes } from "../src/observation-authorization.ts";
import { SolanaObservationRelayTransport, signatureBase58 } from "../src/solana-observation-relay.ts";
import type { ObservationRelayPayload } from "../src/observation-relay.ts";

test("DEV-34: real Solana transaction serialization, pinned RPC state and commitment confirmation (mock RPC/DEV-35 ABI)", async () => {
  const f = eligibilityAccounts();
  const vector = JSON.parse(readFileSync(new URL("../../../fixtures/observations/verifier-authorization-v0.json", import.meta.url), "utf8"));
  new PublicKey(vector.verifier).toBuffer().copy(f.config, 76);
  f.config.writeUInt32LE(vector.policyVersion, 108);
  const enrollment = Buffer.alloc(176); discriminator("account", "EnrollmentAuthority").copy(enrollment);
  f.program.toBuffer().copy(enrollment, 8); enrollment.writeBigUInt64LE(1n, 40); enrollment[79] = 1;
  const payload: ObservationRelayPayload = { ...vector, verifierSignature: vector.signature,
    protocolID: f.protocol.toString("hex"), deviceID: f.device.toString("hex"), evidenceHash: "00".repeat(32), epoch: 1,
    proofBytes: relayProofBytes({ protocol: "groth16", curve: "bn128", pi_a: ["1", "2", "1"],
      pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"] },
      ["1", "2", "3", "1", "34", "51", "1"]).toString("hex") };
  const payer = Keypair.fromSeed(Buffer.alloc(32, 9));
  let genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", matches = true;
  let phase: "missing" | "pending" | "success" | "failed" = "missing", height = 99;
  let occupied = false, sentWire = "";
  const encode = (a: AccountInfo<Buffer>) => ({ ...a, owner: a.owner.toBase58(),
    data: [a.data.toString("base64"), "base64"], rentEpoch: 0 });
  const calls: { method: string; params: unknown[] }[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(Buffer.from(c));
    const call = JSON.parse(Buffer.concat(chunks).toString()); calls.push(call);
    let result: unknown;
    switch (call.method) {
      case "getGenesisHash": result = genesis; break;
      case "getAccountInfo": result = { context: { slot: 123 }, value: {
        ...encode(f.account(Buffer.alloc(0))), executable: true, owner: "BPFLoaderUpgradeab1e11111111111111111111111" } }; break;
      case "getMultipleAccounts": result = { context: { slot: 123 }, value: [encode(f.account(f.config)),
        encode(f.account(enrollment)), occupied ? encode(f.account(Buffer.alloc(1))) : null] }; break;
      case "getLatestBlockhash": result = { context: { slot: 123 }, value: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 } }; break;
      case "sendTransaction": sentWire = call.params[0]; result = signatureBase58(Transaction.from(Buffer.from(sentWire, "base64")).signature!); break;
      case "getSignatureStatuses": result = { context: { slot: 123 }, value: [phase === "missing" ? null : {
        slot: 123, confirmations: phase === "pending" ? 1 : null, err: phase === "failed" ? { InstructionError: [1, "InvalidArgument"] } : null,
        confirmationStatus: phase === "pending" ? "confirmed" : "finalized" }] }; break;
      case "getBlockHeight": result = height; break;
      default: throw Error(`Unexpected mock RPC method ${call.method}`);
    }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    // Test-only consumer instruction. This is deliberately not the production ABI.
    const adapter = { contract: "synthetic-dev35-test-only", instruction: (program: PublicKey) =>
      new TransactionInstruction({ programId: program, keys: [], data: Buffer.from(payload.proofBytes, "hex") }),
      confirm: async () => matches };
    const open = () => SolanaObservationRelayTransport.open(url, f.program.toBase58(), payload.protocolID, payer, vector.verifier, adapter);
    const transport = await open(); assert.ok(await transport.eligible(payload));
    assert.deepEqual(calls.find(c => c.method === "getMultipleAccounts")!.params[1], { commitment: "finalized", encoding: "base64" });
    const prepared = await transport.prepare(payload), tx = Transaction.from(Buffer.from(prepared.wire, "base64"));
    assert.ok(tx.verifySignatures()); assert.ok(tx.feePayer!.equals(payer.publicKey));
    assert.ok(tx.instructions[0]!.programId.equals(Ed25519Program.programId));
    assert.ok(tx.instructions[1]!.programId.equals(f.program)); assert.equal(tx.instructions[1]!.data.toString("hex"), payload.proofBytes);
    assert.ok(Buffer.from(prepared.wire, "base64").length <= 1232);
    await transport.send(prepared); assert.equal(sentWire, prepared.wire);
    assert.equal(await transport.inspect(prepared, payload), "missing");
    phase = "pending"; assert.equal(await transport.inspect(prepared, payload), "pending");
    phase = "success"; matches = false; await assert.rejects(transport.inspect(prepared, payload), /commitment/);
    matches = true; assert.equal(await transport.inspect(prepared, payload), "confirmed");
    phase = "failed"; assert.equal(await transport.inspect(prepared, payload), "failed");
    assert.equal(await transport.expired(prepared), false); height = 101; assert.equal(await transport.expired(prepared), true);
    occupied = true; assert.equal(await transport.eligible(payload), false); occupied = false;
    f.config.writeUInt32LE(1, 108); assert.equal(await transport.eligible(payload), false); f.config.writeUInt32LE(vector.policyVersion, 108);
    enrollment[79] = 2; assert.equal(await transport.eligible(payload), false);
    genesis = "wrong-cluster"; await assert.rejects(open(), /cluster/);
    await assert.rejects(SolanaObservationRelayTransport.open("https://rpc.invalid/?secret=value", f.program.toBase58(), payload.protocolID, payer, vector.verifier, adapter), /RPC/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
