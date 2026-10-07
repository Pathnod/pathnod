/** Devnet signature probe ONLY: no Pathnod instruction, observation or payout. */
import { readFile, stat } from "node:fs/promises";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { authorizationInstruction } from "../src/observation-authorization.ts";
import { signatureBase58 } from "../src/solana-observation-relay.ts";

const path = process.env.PATHNOD_DEVNET_FEE_PAYER;
if (!path) throw Error("PATHNOD_DEVNET_FEE_PAYER must point to a local test keypair");
const info = await stat(path);
if (!info.isFile() || info.size > 4096 || (info.mode & 0o077)) throw Error("Test keypair must be a small private file (chmod 600)");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path, "utf8"))));
const vector = JSON.parse(await readFile(new URL("../../../fixtures/observations/verifier-authorization-v0.json", import.meta.url), "utf8"));
const connection = new Connection("https://api.devnet.solana.com", {
  commitment: "finalized", disableRetryOnRateLimit: true,
  fetch: (input, init) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }),
});
if (await connection.getGenesisHash() !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG") throw Error("Not devnet");
const latest = await connection.getLatestBlockhash("finalized");
const good = authorizationInstruction(vector, vector.verifier, vector.signature);
const tx = new Transaction({ feePayer: payer.publicKey, ...latest }).add(good);
tx.sign(payer);
const fee = (await connection.getFeeForMessage(tx.compileMessage(), "finalized")).value;
if (fee === null || fee > 100_000 || await connection.getBalance(payer.publicKey, "finalized") < fee) throw Error("Fee/balance guard failed");

// Flip an Ed25519 signature byte, not the transaction signature. Simulation costs no fee.
const bad = authorizationInstruction(vector, vector.verifier, vector.signature);
bad.data[bad.data.readUInt16LE(2)]! ^= 1;
const negative = new Transaction({ feePayer: payer.publicKey, ...latest }).add(bad);
negative.sign(payer);
const rejected = await connection.simulateTransaction(negative);
if (!rejected.value.err) throw Error("Tampered signature was not rejected");
const simulated = await connection.simulateTransaction(tx);
if (simulated.value.err) throw Error("Valid signature simulation failed");
const signature = signatureBase58(tx.signature!);
// Log the known signature BEFORE send: on a lost RPC response, inspect it instead of resubmitting a new transaction.
console.log(JSON.stringify({ probe_only: true, fee_payer: payer.publicKey.toBase58(), signature, estimated_fee_lamports: fee }));
const sent = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "finalized", maxRetries: 0 });
if (sent !== signature) throw Error("Unexpected signature");
const confirmation = await connection.confirmTransaction({ ...latest, signature }, "finalized");
if (confirmation.value.err) throw Error("Probe failed on devnet");
const result = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
if (!result || !result.meta || result.meta.err) throw Error("Missing successful finalized transaction");
console.log(JSON.stringify({ probe_only: true, finalized: true, signature, fee_lamports: result.meta.fee,
  tampered_signature_rejected: true, observation_registered: false, rewards_paid: false }));
