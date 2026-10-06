import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { decodeEnrollment, initializeEnrollmentAuthority, registryAddresses } from "@pathnod/solana";
import { ObserverEnrollmentService, type EnrollmentAttestationGate } from "../src/observer-enrollment.ts";
import { ObserverRootPublisher } from "../src/root-publication.ts";
import { SolanaRootPublicationTransport } from "../src/solana-root-publication.ts";
import { createEnrollmentServer } from "../src/enrollment-http.ts";
import { FakeEnrollmentGate } from "../tests/helpers/enrollment-gate.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i]!, value = process.argv[i + 1];
  if (!["--rpc", "--program", "--wallet", "--bootstrap-wallet", "--database", "--report", "--synthetic"].includes(name) || !value || args.has(name)) {
    throw Error("Usage: roots:verify --rpc URL --program ID --wallet SIGNER --database DB --report FILE --synthetic yes|no [--bootstrap-wallet KEYPAIR]");
  }
  args.set(name, value);
}
function required(name: string): string {
  const value = args.get(name);
  if (!value) throw Error(`Missing ${name}`);
  return value;
}
async function keypair(filename: string): Promise<Keypair> {
  try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(filename, "utf8")))); }
  catch { throw Error("Invalid test signer file"); }
}

async function main() {
  const synthetic = required("--synthetic"); assert.ok(["yes", "no"].includes(synthetic));
  const dbPath = path.resolve(required("--database")), reportPath = path.resolve(required("--report"));
  const repo = await realpath(fileURLToPath(new URL("../../..", import.meta.url)));
  for (const filename of [dbPath, reportPath]) {
    const relative = path.relative(repo, await realpath(path.dirname(filename)));
    assert.ok(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "Keep private databases and reports outside Git");
  }
  const rpc = new URL(required("--rpc"));
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname);
  assert.ok(local || rpc.href === "https://api.devnet.solana.com/", "Test only on localhost or official devnet");
  const connection = new Connection(rpc.href, "confirmed");
  const program = new PublicKey(required("--program"));
  assert.notEqual(program.toBase58(), "5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd", "Use a disposable test deployment");
  if (!local) assert.equal(await connection.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  const signer = await keypair(required("--wallet"));
  const enrollment = registryAddresses(program, Buffer.alloc(32)).enrollment;
  const bootstrap = args.get("--bootstrap-wallet");
  if (bootstrap) {
    const owner = await keypair(bootstrap);
    if (!await connection.getAccountInfo(enrollment)) {
      await sendAndConfirmTransaction(connection, new Transaction().add(
        initializeEnrollmentAuthority(program, owner.publicKey, signer.publicKey)), [owner], { commitment: "confirmed" });
    }
    if (await connection.getBalance(signer.publicKey) < 10_000_000) {
      await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({
        fromPubkey: owner.publicKey, toPubkey: signer.publicKey, lamports: 50_000_000,
      })), [owner], { commitment: "confirmed" });
    }
  }
  const account = await connection.getAccountInfo(enrollment);
  assert.ok(account && account.owner.equals(program));
  const initial = decodeEnrollment(account.data);
  assert.ok(initial.authority.equals(signer.publicKey));
  const transport = await SolanaRootPublicationTransport.open(rpc.href, program.toBase58(), required("--wallet"));
  const unavailable = () => { throw Error("Recorded-root validation does not enroll observers"); };
  const gate: EnrollmentAttestationGate = synthetic === "yes" ? new FakeEnrollmentGate() : {
    issueChallenge: unavailable, acceptAssertion: unavailable, acceptAttestation: unavailable, getKey: () => undefined,
  };
  let service = await ObserverEnrollmentService.open(dbPath, gate);
  const options = synthetic === "yes" ? { batchSize: 2, maxDelayMs: 5_000 } : {};
  let publisher = new ObserverRootPublisher(dbPath, service, transport, options);
  let server = createEnrollmentServer(service, publisher);
  const snapshots: NonNullable<ReturnType<ObserverRootPublisher["status"]>["confirmed"]>[] = [];
  const listen = async () => {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  const stop = async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await publisher.close(); service.close();
  };
  let base = await listen();
  const httpRoot = async () => {
    const response = await fetch(`${base}/root`); assert.equal(response.status, 200);
    return await response.json() as { root: string; revision: number; publication: ReturnType<ObserverRootPublisher["status"]> };
  };
  async function wait(revision: number) {
    for (let attempt = 0; attempt < 90; attempt++) {
      const state = await httpRoot();
      if (state.publication.confirmed?.revision === revision && state.publication.confirmed.active === true) {
        assert.equal(state.publication.confirmed.root, state.root);
        snapshots.push(state.publication.confirmed);
        console.log(`Root revision ${revision} confirmed (${state.publication.confirmed.leafCount} leaves).`);
        return state.publication.confirmed;
      }
      assert.ok(!state.publication.lastError || state.publication.lastError === "rpc_error", `Publication failed: ${state.publication.lastError}`);
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    throw Error("Timed out waiting for confirmed root");
  }
  let expectedPublications = 2n;
  try {
    if (synthetic === "yes") {
      assert.equal(service.root().revision, 0, "Use a fresh synthetic test database");
      const observerKeys = Array.from({ length: 3 }, () => randomBytes(32).toString("base64"));
      const enroll = async (i: number) => {
        const commitment = `0x${(100 + i).toString(16).padStart(64, "0")}`, keyID = observerKeys[i]!;
        const post = async (route: string, value: unknown) => fetch(base + route, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
        });
        const challenge = await (await post("/enroll/challenge", { commitment, keyID })).json() as { id: string };
        const response = await post("/enroll", { challengeID: challenge.id, commitment, keyID, object: "Kg==" });
        assert.equal(response.status, 200);
      };
      await enroll(0); await publisher.tick();
      assert.equal((await httpRoot()).publication.confirmed, null);
      await enroll(1); publisher.start(); await wait(2);
      await enroll(2);
      const pending = await httpRoot();
      assert.equal(pending.publication.state, "pending"); assert.equal(pending.publication.confirmed?.revision, 2);
      await wait(3);
      await enroll(2); assert.equal(service.root().revision, 3);
    } else {
      const snapshot = service.publicationBatch(0)?.snapshot;
      assert.ok(snapshot, "Recorded database contains no enrolled observers");
      expectedPublications = await transport.inspect(snapshot) ? 0n : 1n;
      publisher.start(); await wait(snapshot.revision);
    }
    const beforeRestart = (await connection.getAccountInfo(enrollment))!.data;
    const confirmed = publisher.status().confirmed; assert.ok(confirmed);
    const rootBefore = (await connection.getAccountInfo(new PublicKey(confirmed.address)))!.data;
    await stop();
    service = await ObserverEnrollmentService.open(dbPath, gate);
    publisher = new ObserverRootPublisher(dbPath, service, transport, options);
    server = createEnrollmentServer(service, publisher); base = await listen(); publisher.start();
    await wait(confirmed.revision);
    assert.ok((await connection.getAccountInfo(enrollment))!.data.equals(beforeRestart), "Restart republished an existing root");
    assert.ok((await connection.getAccountInfo(new PublicKey(confirmed.address)))!.data.equals(rootBefore), "Restart rewrote an immutable root");
    const final = decodeEnrollment(beforeRestart);
    assert.equal(final.publications - initial.publications, expectedPublications);
    const report = { developmentOnly: true, program: program.toBase58(), cluster: transport.cluster,
      source: synthetic === "yes" ? "synthetic test enrollments (fake gate only in test harness)" : "existing verified enrollment database",
      initialPublications: initial.publications.toString(), finalPublications: final.publications.toString(),
      confirmedRoots: snapshots, restart: "no additional publication or root mutation" };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`PASS: automatic root publication and restart recovery. Report: ${reportPath}`);
  } finally { await stop(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Root validation failed"); process.exitCode = 1; });
