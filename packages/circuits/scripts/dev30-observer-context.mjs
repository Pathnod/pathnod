import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(import.meta.url);
const source = path.resolve(path.dirname(require.resolve("circomlibjs")), "../src/poseidon_constants.json");
const constants = JSON.parse(await readFile(source, "utf8"));
const hex = value => "0x" + BigInt(value).toString(16).padStart(64, "0");
const poseidon = await buildPoseidon();
const hash = values => poseidon.F.toObject(poseidon(values));
const parameters = { parameterSet: "circom-bn254-x5", arity: 3,
  roundConstants: constants.C[2].map(hex), mds: constants.M[2].map(row => row.map(hex)) };
const contexts = Array.from({ length: 64 }, (_, index) => {
  const secret = index === 0 ? Buffer.alloc(31) : index === 1 ? Buffer.alloc(31, 255) :
    createHash("sha256").update(`Pathnod/DEV30/public-secret-fixture/${index}`).digest().subarray(0, 31);
  const protocol = index === 0 ? Buffer.alloc(32, 1) : index === 1 ? Buffer.alloc(32, 255) :
    createHash("sha256").update(`Pathnod/DEV30/public-protocol-fixture/${index}`).digest();
  const protocolField = hash([3n, BigInt("0x" + protocol.subarray(0, 16).toString("hex")), BigInt("0x" + protocol.subarray(16).toString("hex"))]);
  const pseudonym = hash([2n, BigInt("0x" + secret.toString("hex")), protocolField]);
  return { secret: "0x" + secret.toString("hex"), protocolID: "0x" + protocol.toString("hex"),
    protocolField: hex(protocolField), pseudonym: hex(pseudonym), hint: hex(pseudonym).slice(0, 18) };
});
const modulus = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const triples = Array.from({ length: 32 }, (_, i) => {
  const inputs = Array.from({ length: 3 }, (_, j) => i === 0 ? 0n : i === 1 ? modulus - 1n :
    BigInt("0x" + createHash("sha256").update(`Pathnod/DEV30/public-field-fixture/${i}/${j}`).digest("hex")) % modulus);
  return { inputs: inputs.map(hex), output: hex(hash(inputs)) };
});
await writeFile(path.join(repo, "apps/ios/Sources/PathnodObserverEnrollment/Resources/poseidon-t4.json"), JSON.stringify(parameters, null, 2) + "\n");
await writeFile(path.join(repo, "fixtures/poseidon/observer-context-v0.json"), JSON.stringify({
  publicTestVectors: true, source: "circomlibjs 0.1.7", contexts, triples,
}, null, 2) + "\n");
console.log("Generated public Poseidon t4 parameters, 64 context vectors and 32 field vectors.");
