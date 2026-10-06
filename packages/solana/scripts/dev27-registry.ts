import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  BN254_MODULUS, DEVNET_USDC, TOKEN_PROGRAM, UPGRADEABLE_LOADER, activeRoots,
  decodeDevice, decodeEnrollment, decodeProtocol, decodeRoot, deviceId, fieldBytes,
  initProtocol, initializeEnrollmentAuthority, publishRoot, registerDevice, registryAddresses,
} from "../src/index.ts";

const options = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]!, value = process.argv[i + 1];
  if (!["--rpc", "--wallet", "--program", "--report", "--root", "--leaf-count"].includes(key) || !value || options.has(key)) {
    throw new Error("Usage: registry:verify --rpc URL --wallet KEYPAIR --program PROGRAM_ID --report FILE [--root HEX --leaf-count N]");
  }
  options.set(key, value);
}
function required(key: string) {
  const value = options.get(key);
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

async function main() {
  const rpc = new URL(required("--rpc"));
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(rpc.hostname);
  assert.ok(local || rpc.href === "https://api.devnet.solana.com/", "Only localhost or official devnet is allowed");
  let requestQueue = Promise.resolve();
  const connection = new Connection(rpc.href, {
    commitment: "confirmed",
    ...(!local ? {
      fetchMiddleware: (url, init, fetch) => {
        requestQueue = requestQueue.then(() => new Promise<void>(resolve => setTimeout(resolve, 750)));
        void requestQueue.then(() => fetch(url, init));
      },
    } : {}),
  });
  const genesis = await connection.getGenesisHash();
  if (!local) assert.equal(genesis, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  const reportPath = path.resolve(required("--report"));
  const repo = await realpath(fileURLToPath(new URL("../../..", import.meta.url)));
  const parent = await realpath(path.dirname(reportPath));
  const relative = path.relative(repo, parent);
  assert.ok(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "Keep reports outside Git");
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(required("--wallet"), "utf8"))));
  const program = new PublicKey(required("--program"));
  assert.notEqual(program.toBase58(), "5V9pXQN5dQkRBSTsaezBg6qLRC3mbLj21Ny3j7xtuHTd", "Use a disposable program, never the shared deployment");
  const programAccount = await connection.getAccountInfo(program);
  assert.ok(programAccount?.executable && programAccount.owner.equals(UPGRADEABLE_LOADER), "Deploy an upgradeable test program first");
  const protocolId = createHash("sha256").update("Pathnod/DEV-27/test").update(randomBytes(32)).digest();
  const addresses = registryAddresses(program, protocolId);
  assert.equal(await connection.getAccountInfo(addresses.enrollment), null, "Use a fresh deployment: enrollment authority already exists");
  const publisher = Keypair.generate(), intruder = Keypair.generate();
  const accepted: Record<string, { signature: string; computeUnits: number; transactionBytes: number }> = {};
  const rejected: Record<string, unknown> = {};

  async function send(name: string, ix: TransactionInstruction | TransactionInstruction[], signers = [wallet]) {
    const tx = new Transaction().add(...(Array.isArray(ix) ? ix : [ix]));
    const signature = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
    let record = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
    for (let i = 0; !record && i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      record = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
    }
    assert.ok(record?.meta && record.meta.err === null, `Missing successful transaction metadata: ${signature}`);
    accepted[name] = { signature, computeUnits: record.meta.computeUnitsConsumed!, transactionBytes: tx.serialize().length };
    assert.ok(accepted[name]!.transactionBytes <= 1232);
    console.log(`${name}: confirmed (${record.meta.computeUnitsConsumed} CU)`);
  }

  async function reject(name: string, ix: TransactionInstruction, signer: Keypair, expectedCode: number) {
    const tx = new Transaction({ feePayer: signer.publicKey, ...(await connection.getLatestBlockhash()) }).add(ix,
      new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from(name) }));
    tx.sign(signer);
    const simulation = await connection.simulateTransaction(tx);
    assert.deepEqual(simulation.value.err, { InstructionError: [0, { Custom: expectedCode }] }, `${name}: unexpected rejection\n${simulation.value.logs?.join("\n")}`);
    rejected[name] = simulation.value.err;
  }

  async function owned(address: PublicKey) {
    const account = await connection.getAccountInfo(address);
    assert.ok(account && account.owner.equals(program), `Missing program account ${address.toBase58()}`);
    return account.data;
  }

  async function createMint(decimals: number) {
    const mint = Keypair.generate();
    await send(`create_mint_${decimals}`, [
      SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: mint.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(82), space: 82, programId: TOKEN_PROGRAM }),
      new TransactionInstruction({ programId: TOKEN_PROGRAM, keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }],
        data: Buffer.concat([Buffer.from([20, decimals]), wallet.publicKey.toBuffer(), Buffer.from([0])]) }),
    ], [wallet, mint]);
    return mint.publicKey;
  }

  await send("fund_test_signers", [publisher, intruder].map(signer => SystemProgram.transfer({
    fromPubkey: wallet.publicKey, toPubkey: signer.publicKey, lamports: 50_000_000,
  })));
  await reject("bootstrap_wrong_upgrade_authority", initializeEnrollmentAuthority(program, intruder.publicKey, publisher.publicKey), intruder, 6100);
  assert.equal(await connection.getAccountInfo(addresses.enrollment), null);
  await reject("bootstrap_zero_authority", initializeEnrollmentAuthority(program, wallet.publicKey, PublicKey.default), wallet, 6110);
  await send("initialize_enrollment_authority", initializeEnrollmentAuthority(program, wallet.publicKey, publisher.publicKey));
  const enrollment = decodeEnrollment(await owned(addresses.enrollment));
  assert.ok(enrollment.authority.equals(publisher.publicKey));
  assert.equal(enrollment.publications, 0n);
  assert.deepEqual(activeRoots(enrollment), []);
  await reject("duplicate_bootstrap", initializeEnrollmentAuthority(program, wallet.publicKey, intruder.publicKey), wallet, 0);

  const mint = local ? await createMint(6) : DEVNET_USDC;
  const mintAccount = await connection.getAccountInfo(mint);
  assert.ok(mintAccount && mintAccount.owner.equals(TOKEN_PROGRAM));
  assert.equal(mintAccount.data[44], 6);
  const badMint = await createMint(7);
  const policy = { protocolId, epochSeconds: 604800, verifier: Keypair.generate().publicKey,
    policyVersion: 1, rewardPerSlot: 50_000n, slotsPerEpoch: 3 };
  await reject("zero_epoch", initProtocol(program, wallet.publicKey, mint, { ...policy, epochSeconds: 0 }), wallet, 6102);
  await reject("invalid_mint", initProtocol(program, wallet.publicKey, badMint, policy), wallet, 6103);
  assert.equal(await connection.getAccountInfo(addresses.config), null);
  assert.equal(await connection.getAccountInfo(addresses.escrow), null);
  await send("init_protocol", initProtocol(program, wallet.publicKey, mint, policy));
  const configData = await owned(addresses.config);
  const config = decodeProtocol(configData);
  assert.ok(config.authority.equals(wallet.publicKey) && config.verifier.equals(policy.verifier));
  assert.ok(config.protocolId.equals(protocolId) && config.rewardMint.equals(mint) && config.escrow.equals(addresses.escrow));
  assert.equal(config.epochSeconds, policy.epochSeconds);
  assert.equal(config.policyVersion, policy.policyVersion);
  assert.equal(config.rewardPerSlot, policy.rewardPerSlot);
  assert.equal(config.slotsPerEpoch, policy.slotsPerEpoch);
  const escrow = await connection.getAccountInfo(addresses.escrow);
  assert.ok(escrow && escrow.owner.equals(TOKEN_PROGRAM));
  assert.equal(escrow.data.length, 165);
  assert.ok(escrow.data.subarray(0, 32).equals(mint.toBuffer()) && escrow.data.subarray(32, 64).equals(addresses.config.toBuffer()));
  assert.equal(escrow.data.readBigUInt64LE(64), 0n);
  assert.equal(escrow.data.readUInt32LE(72), 0, "Escrow must have no delegate");
  assert.equal(escrow.data[108], 1, "Escrow must be initialized");
  assert.equal(escrow.data.readUInt32LE(129), 0, "Escrow must have no close authority");
  await reject("duplicate_protocol", initProtocol(program, wallet.publicKey, mint, policy), wallet, 0);

  const key = Keypair.generate().publicKey.toBuffer();
  const device = { deviceId: deviceId(key), key, curve: 1, capabilities: 2,
    externalAsset: Keypair.generate().publicKey, claimedGeohash: "u09tvw" };
  await reject("device_wrong_authority", registerDevice(program, intruder.publicKey, protocolId, device), intruder, 6100);
  await reject("device_wrong_id", registerDevice(program, wallet.publicKey, protocolId, { ...device, deviceId: randomBytes(32) }), wallet, 6104);
  await reject("unsupported_curve", registerDevice(program, wallet.publicKey, protocolId, { ...device, curve: 2 }), wallet, 6105);
  const proof = registerDevice(program, wallet.publicKey, protocolId, device);
  // proof_of_control follows discriminator, two IDs, curve and Some(asset).
  proof.data = Buffer.concat([proof.data.subarray(0, 106), Buffer.from([1, 1, 0, 0, 0, 42]), proof.data.subarray(107)]);
  await reject("unsupported_external_proof", proof, wallet, 6106);
  const invalidGeo = registerDevice(program, wallet.publicKey, protocolId, device);
  invalidGeo.data.fill(0x61, invalidGeo.data.length - 6);
  await reject("invalid_geohash", invalidGeo, wallet, 6107);
  assert.equal(await connection.getAccountInfo(addresses.device(device.deviceId)), null);
  await send("register_device", registerDevice(program, wallet.publicKey, protocolId, device));
  const deviceData = await owned(addresses.device(device.deviceId));
  const registered = decodeDevice(deviceData);
  assert.ok(registered.deviceId.equals(device.deviceId) && registered.key.equals(key));
  assert.ok(registered.externalAsset?.equals(device.externalAsset));
  assert.equal(registered.linked, false);
  assert.equal(registered.curve, 1);
  assert.equal(registered.capabilities, 2);
  assert.equal(registered.claimedGeohash, "u09tvw");
  assert.ok(registered.registeredAt > 0n);
  await reject("duplicate_device", registerDevice(program, wallet.publicKey, protocolId, device), wallet, 0);
  const secondKey = Keypair.generate().publicKey.toBuffer();
  const secondDevice = { ...device, key: secondKey, deviceId: deviceId(secondKey), externalAsset: null, claimedGeohash: null };
  await send("register_device_without_metadata", registerDevice(program, wallet.publicKey, protocolId, secondDevice));
  const secondRegistered = decodeDevice(await owned(addresses.device(secondDevice.deviceId)));
  assert.equal(secondRegistered.externalAsset, null);
  assert.equal(secondRegistered.claimedGeohash, null);

  const suppliedRoot = options.get("--root"), suppliedCount = options.get("--leaf-count");
  assert.equal(suppliedRoot !== undefined, suppliedCount !== undefined, "Root and leaf count must be supplied together");
  if (suppliedRoot) assert.match(suppliedRoot, /^(0x)?[0-9a-fA-F]{64}$/);
  const root = suppliedRoot ? Buffer.from(suppliedRoot.replace(/^0x/, ""), "hex") : fieldBytes(42n);
  const count = suppliedCount ? Number(suppliedCount) : 1;
  const rootIx = () => publishRoot(program, publisher.publicKey, root, count);
  await reject("root_wrong_authority", publishRoot(program, wallet.publicKey, root, count), wallet, 6100);
  const invalidRoot = rootIx();
  const modulus = Buffer.from(BN254_MODULUS.toString(16).padStart(64, "0"), "hex");
  invalidRoot.data.set(modulus, 8);
  invalidRoot.keys[1]!.pubkey = addresses.root(modulus);
  await reject("noncanonical_root", invalidRoot, publisher, 6108);
  const invalidCount = rootIx();
  invalidCount.data.writeUInt32LE(2 ** 20 + 1, 40);
  await reject("oversized_tree", invalidCount, publisher, 6109);
  const wrongPda = rootIx();
  wrongPda.keys[1]!.pubkey = addresses.root(fieldBytes(99n));
  await reject("substituted_root_pda", wrongPda, publisher, 2006);
  assert.equal(decodeEnrollment(await owned(addresses.enrollment)).publications, 0n);
  assert.equal(await connection.getAccountInfo(addresses.root(root)), null);
  await send("publish_root", rootIx(), [publisher]);
  const rootData = await owned(addresses.root(root));
  const published = decodeRoot(rootData);
  assert.ok(published.root.equals(root) && published.authority.equals(publisher.publicKey));
  assert.equal(published.leafCount, count);
  assert.ok(published.publishedAt > 0n);
  await reject("duplicate_root", rootIx(), publisher, 0);
  assert.equal(decodeEnrollment(await owned(addresses.enrollment)).publications, 1n);
  const syntheticRoots = [1n, 2n, 3n, 4n].map(fieldBytes);
  assert.ok(syntheticRoots.every(value => !value.equals(root)), "Select a root distinct from synthetic window fixtures");
  for (const [i, value] of syntheticRoots.entries()) {
    await send(`publish_window_root_${i + 1}`, publishRoot(program, publisher.publicKey, value, i + 2), [publisher]);
  }
  const finalState = decodeEnrollment(await owned(addresses.enrollment));
  assert.equal(finalState.publications, 5n);
  assert.deepEqual(activeRoots(finalState), [...syntheticRoots].reverse());
  assert.ok((await owned(addresses.root(root))).equals(rootData), "Old root was overwritten");
  assert.ok((await owned(addresses.config)).equals(configData), "Protocol changed during rejected writes");
  assert.ok((await owned(addresses.device(device.deviceId))).equals(deviceData), "Device changed during rejected writes");
  const report = {
    developmentOnly: true, rpc: rpc.href, genesis, program: program.toBase58(), requester: wallet.publicKey.toBase58(),
    enrollmentAuthority: publisher.publicKey.toBase58(), protocolId: protocolId.toString("hex"),
    config: addresses.config.toBase58(), escrow: addresses.escrow.toBase58(), rewardMint: mint.toBase58(),
    device: addresses.device(device.deviceId).toBase58(), deviceId: device.deviceId.toString("hex"),
    observerRoot: addresses.root(root).toBase58(), root: `0x${root.toString("hex")}`, leafCount: count,
    rootSource: suppliedRoot ? "caller-supplied (see validation notes)" : "synthetic fixture",
    recentRoots: activeRoots(finalState).map(value => `0x${value.toString("hex")}`),
    accepted, rejected, negativeChecks: "RPC simulations; state checked before and after successful writes",
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PASS: ${Object.keys(accepted).length} transactions, ${Object.keys(rejected).length} rejected simulations. Report: ${reportPath}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
