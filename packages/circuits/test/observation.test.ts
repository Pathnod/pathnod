import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";
import { deriveDeviceIdField, deriveProtocolIdField } from "../src/id-field.js";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const circomBinary = process.env.CIRCOM_BIN ?? "circom";
const depth = 20;

type Input = Record<string, string | string[]>;

test("observation circuit verifies membership, scoped outputs, and rejects tampering", { timeout: 120_000 }, async () => {
  const { stdout: version } = await execFileAsync(circomBinary, ["--version"]);
  assert.match(version, /2\.2\.3/, "Circom compiler must be pinned to 2.2.3");

  const workDirectory = await mkdtemp(path.join(tmpdir(), "pathnod-observation-"));
  await execFileAsync(circomBinary, [
    path.join(packageRoot, "circuits", "observation.circom"),
    "--r1cs",
    "--wasm",
    "--O2",
    "-o",
    workDirectory,
    "-l",
    path.join(packageRoot, "node_modules"),
  ]);

  const snarkjs = path.join(packageRoot, "node_modules", ".bin", "snarkjs");
  const wasm = path.join(workDirectory, "observation_js", "observation.wasm");
  const witnessGenerator = path.join(workDirectory, "observation_js", "generate_witness.js");
  const r1cs = path.join(workDirectory, "observation.r1cs");
  const { stdout: circuitInfo } = await execFileAsync(snarkjs, ["r1cs", "info", r1cs]);
  assert.match(circuitInfo, /# of Public Inputs: 7\b/);
  const constraintCount = Number(circuitInfo.match(/# of Constraints: (\d+)/)?.[1]);
  assert.ok(constraintCount > 0 && constraintCount < 2 ** 14, "circuit must fit DEV-13's ptau 2^14");
  const poseidon = await buildPoseidon();
  const hash = (...values: bigint[]): bigint => poseidon.F.toObject(poseidon(values));
  const protocolId = Uint8Array.from({ length: 32 }, (_, index) => index);
  const deviceId = new Uint8Array(32).fill(0xff);
  const protocol = BigInt((await deriveProtocolIdField(protocolId)).decimal);
  const device = BigInt((await deriveDeviceIdField(deviceId)).decimal);
  const otherProtocol = BigInt((await deriveProtocolIdField(new Uint8Array(32))).decimal);
  const otherDevice = BigInt((await deriveDeviceIdField(new Uint8Array(32))).decimal);

  function makeInput(secret: bigint, protocol: bigint, device: bigint, epoch: bigint, hardwareClass = 1n): Input {
    const siblings = Array.from({ length: depth }, (_, i) => BigInt(100 + i));
    const positions = Array.from({ length: depth }, (_, i) => BigInt(i % 2));
    let node = hash(hash(secret), hardwareClass);
    for (let i = 0; i < depth; i++) {
      node = positions[i] === 0n ? hash(node, siblings[i]) : hash(siblings[i], node);
    }
    return {
      s_obs: secret.toString(),
      class: hardwareClass.toString(),
      merkle_path: siblings.map(String),
      merkle_index: positions.map(String),
      root: node.toString(),
      protocol_id_f: protocol.toString(),
      device_id_f: device.toString(),
      epoch: epoch.toString(),
      nullifier: hash(1n, secret, protocol, device, epoch).toString(),
      pseudonym: hash(2n, secret, protocol).toString(),
      class_pub: hardwareClass.toString(),
    };
  }

  let caseNumber = 0;
  async function checkWitness(input: Input): Promise<string> {
    const caseName = `case-${caseNumber++}`;
    const inputPath = path.join(workDirectory, `${caseName}.json`);
    const witnessPath = path.join(workDirectory, `${caseName}.wtns`);
    await writeFile(inputPath, JSON.stringify(input), "utf8");
    await execFileAsync("node", [witnessGenerator, wasm, inputPath, witnessPath]);
    await execFileAsync(snarkjs, ["wtns", "check", r1cs, witnessPath]);
    return witnessPath;
  }

  const valid = makeInput(42n, protocol, device, 3n);
  const validWitness = await checkWitness(valid);
  const witnessJsonPath = path.join(workDirectory, "valid-witness.json");
  await execFileAsync(snarkjs, ["wtns", "export", "json", validWitness, witnessJsonPath]);
  const witness = JSON.parse(await readFile(witnessJsonPath, "utf8")) as string[];
  assert.deepEqual(witness.slice(1, 8), [
    valid.root,
    valid.protocol_id_f,
    valid.device_id_f,
    valid.epoch,
    valid.nullifier,
    valid.pseudonym,
    valid.class_pub,
  ]);
  await checkWitness(makeInput(42n, protocol, otherDevice, 3n));
  await checkWitness(makeInput(42n, otherProtocol, device, 3n));
  await checkWitness(makeInput(42n, protocol, device, 3n, 2n));
  await checkWitness(makeInput(42n, protocol, device, 3n, 3n));

  assert.equal(makeInput(42n, protocol, otherDevice, 3n).pseudonym, valid.pseudonym);
  assert.notEqual(makeInput(42n, protocol, otherDevice, 3n).nullifier, valid.nullifier);
  assert.equal(makeInput(42n, protocol, device, 4n).pseudonym, valid.pseudonym);
  assert.notEqual(makeInput(42n, protocol, device, 4n).nullifier, valid.nullifier);
  assert.notEqual(makeInput(42n, otherProtocol, device, 3n).pseudonym, valid.pseudonym);

  const tampered: Input[] = [
    { ...valid, root: "0" },
    { ...valid, nullifier: "0" },
    { ...valid, pseudonym: "0" },
    { ...valid, protocol_id_f: otherProtocol.toString() },
    { ...valid, device_id_f: otherDevice.toString() },
    { ...valid, epoch: "4" },
    { ...valid, class_pub: "2" },
    makeInput(42n, protocol, device, 3n, 4n),
    { ...valid, merkle_index: ["2", ...(valid.merkle_index as string[]).slice(1)] },
    { ...valid, merkle_path: ["0", ...(valid.merkle_path as string[]).slice(1)] },
  ];
  for (const input of tampered) {
    await assert.rejects(checkWitness(input));
  }
});
