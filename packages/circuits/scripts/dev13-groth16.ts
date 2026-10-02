import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";
import { deriveDeviceIdField, deriveProtocolIdField } from "../src/id-field.js";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const snarkjs = path.join(packageRoot, "node_modules", ".bin", "snarkjs");
const circom = process.env.CIRCOM_BIN ?? "circom";
const depth = 20;

async function run(binary: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    const beacon = (args[0] === "powersoftau" || args[0] === "zkey") && args[1] === "beacon";
    const safeArgs = args.map((arg, index) =>
      arg.startsWith("-e=") || (beacon && index === 4) ? "[redacted]" : arg);
    throw new Error(`Command failed: ${path.basename(binary)} ${safeArgs.join(" ")}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`);
  }
}

function file(directory: string, name: string): string {
  return path.join(directory, name);
}

async function createInput(): Promise<Record<string, string | string[]>> {
  const poseidon = await buildPoseidon();
  const hash = (...values: bigint[]): bigint => poseidon.F.toObject(poseidon(values));
  const syntheticSecret = 42n;
  const hardwareClass = 1n;
  const epoch = 3n;
  const protocolId = Uint8Array.from({ length: 32 }, (_, index) => index);
  const deviceId = new Uint8Array(32).fill(0xff);
  const protocol = BigInt((await deriveProtocolIdField(protocolId)).decimal);
  const device = BigInt((await deriveDeviceIdField(deviceId)).decimal);
  const siblings = Array.from({ length: depth }, (_, index) => BigInt(100 + index));
  const positions = Array.from({ length: depth }, (_, index) => BigInt(index % 2));

  let root = hash(hash(syntheticSecret), hardwareClass);
  for (let index = 0; index < depth; index++) {
    root = positions[index] === 0n
      ? hash(root, siblings[index])
      : hash(siblings[index], root);
  }

  return {
    s_obs: syntheticSecret.toString(),
    class: hardwareClass.toString(),
    merkle_path: siblings.map(String),
    merkle_index: positions.map(String),
    root: root.toString(),
    protocol_id_f: protocol.toString(),
    device_id_f: device.toString(),
    epoch: epoch.toString(),
    nullifier: hash(1n, syntheticSecret, protocol, device, epoch).toString(),
    pseudonym: hash(2n, syntheticSecret, protocol).toString(),
    class_pub: hardwareClass.toString(),
  };
}

async function outputDirectory(): Promise<string> {
  if (process.argv.length !== 2 && (process.argv.length !== 4 || process.argv[2] !== "--out")) {
    throw new Error("Usage: pnpm --filter @pathnod/circuits dev13:prove [--out EXISTING_DIRECTORY]");
  }
  const directory = process.argv.length === 2
    ? await mkdtemp(path.join(tmpdir(), "pathnod-dev13-"))
    : await realpath(process.argv[3]);
  const relative = path.relative(repoRoot, directory);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("The output directory must be outside the repository");
  }
  if ((await readdir(directory)).length !== 0) {
    throw new Error("The output directory must be empty");
  }
  return directory;
}

async function main(): Promise<void> {
  const directory = await outputDirectory();
  console.log(`Development-only artifacts: ${directory}`);
  assert.match(await run(circom, ["--version"]), /circom compiler 2\.2\.3\b/);

  console.log("Compiling observation.circom...");
  await run(circom, [
    file(packageRoot, "circuits/observation.circom"),
    "--r1cs", "--wasm", "--O2", "-o", directory,
    "-l", file(packageRoot, "node_modules"),
  ]);
  const r1cs = file(directory, "observation.r1cs");
  const wasm = file(directory, "observation_js/observation.wasm");
  const info = await run(snarkjs, ["r1cs", "info", r1cs]);
  const constraints = Number(info.match(/# of Constraints: (\d+)/)?.[1]);
  assert.ok(constraints > 0 && constraints < 2 ** 14, "R1CS exceeds the 2^14 ptau capacity");
  assert.match(info, /# of Public Inputs: 7\b/);
  console.log(`${constraints} constraints; 7 public inputs`);

  console.log("Preparing a local BN254 powers-of-tau transcript...");
  const ptau0 = file(directory, "pot14_0000.ptau");
  const ptau1 = file(directory, "pot14_0001.ptau");
  const ptauBeacon = file(directory, "pot14_beacon.ptau");
  const ptauFinal = file(directory, "pot14_final.ptau");
  await run(snarkjs, ["powersoftau", "new", "bn128", "14", ptau0]);
  await run(snarkjs, ["powersoftau", "contribute", ptau0, ptau1, "--name=DEV-13 local contribution", `-e=${randomBytes(32).toString("hex")}`]);
  await run(snarkjs, ["powersoftau", "beacon", ptau1, ptauBeacon, randomBytes(32).toString("hex"), "10", "--name=DEV-13 local beacon"]);
  await run(snarkjs, ["powersoftau", "prepare", "phase2", ptauBeacon, ptauFinal]);
  assert.match(await run(snarkjs, ["powersoftau", "verify", ptauFinal]), /Powers Of tau file OK!/);

  console.log("Completing the local Groth16 phase 2 setup...");
  const zkey0 = file(directory, "observation_0000.zkey");
  const zkey1 = file(directory, "observation_0001.zkey");
  const zkeyFinal = file(directory, "observation_final.zkey");
  const verificationKey = file(directory, "verification_key.json");
  await run(snarkjs, ["groth16", "setup", r1cs, ptauFinal, zkey0]);
  await run(snarkjs, ["zkey", "contribute", zkey0, zkey1, "--name=DEV-13 local contribution", `-e=${randomBytes(32).toString("hex")}`]);
  await run(snarkjs, ["zkey", "beacon", zkey1, zkeyFinal, randomBytes(32).toString("hex"), "10", "--name=DEV-13 local beacon"]);
  assert.match(await run(snarkjs, ["zkey", "verify", r1cs, ptauFinal, zkeyFinal]), /ZKey Ok!/);
  await run(snarkjs, ["zkey", "export", "verificationkey", zkeyFinal, verificationKey]);

  console.log("Generating and verifying a synthetic observation proof...");
  const input = await createInput();
  const inputPath = file(directory, "synthetic-input.json");
  const proofPath = file(directory, "proof.json");
  const publicPath = file(directory, "public.json");
  await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });
  await run(snarkjs, ["groth16", "fullprove", inputPath, wasm, zkeyFinal, proofPath, publicPath]);
  const publicSignals = JSON.parse(await readFile(publicPath, "utf8")) as string[];
  const names = ["root", "protocol_id_f", "device_id_f", "epoch", "nullifier", "pseudonym", "class_pub"];
  assert.deepEqual(publicSignals, names.map((name) => input[name]));
  assert.match(await run(snarkjs, ["groth16", "verify", verificationKey, publicPath, proofPath]), /OK!/);

  const tampered = [...publicSignals];
  tampered[0] = (BigInt(tampered[0]) + 1n).toString();
  const tamperedPath = file(directory, "public-tampered.json");
  await writeFile(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
  let negativeOutput: string;
  try {
    negativeOutput = await run(snarkjs, ["groth16", "verify", verificationKey, tamperedPath, proofPath]);
  } catch (error) {
    negativeOutput = String(error);
  }
  assert.match(negativeOutput, /Invalid proof/);
  console.log("Valid proof accepted; changed root rejected.");
  console.log(`Verification key: ${verificationKey}`);
  console.log(`Proof: ${proofPath}`);
  console.log(`Public inputs (${names.join(", ")}): ${publicPath}`);
  console.log("These local setup artifacts are unsuitable for production.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
