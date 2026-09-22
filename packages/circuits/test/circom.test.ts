import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadFixture } from "../src/fixture.js";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const circomBinary = process.env.CIRCOM_BIN ?? "circom";

test("Circom witnesses match every canonical vector", { timeout: 120_000 }, async () => {
  const { stdout: versionOutput } = await execFileAsync(circomBinary, ["--version"]);
  assert.match(versionOutput, /2\.2\.3/, "Circom compiler must be pinned to 2.2.3");

  const fixture = await loadFixture();
  const workDirectory = await mkdtemp(path.join(tmpdir(), "pathnod-poseidon-"));
  const compiled = new Set<number>();

  for (const vector of fixture.vectors) {
    const circuitName = `poseidon_${vector.arity}`;
    if (!compiled.has(vector.arity)) {
      await execFileAsync(circomBinary, [
        path.join(packageRoot, "circuits", `${circuitName}.circom`),
        "--wasm",
        "--output",
        workDirectory,
        "-l",
        path.join(packageRoot, "node_modules"),
      ]);
      compiled.add(vector.arity);
    }

    const inputPath = path.join(workDirectory, `${vector.name}-input.json`);
    const witnessPath = path.join(workDirectory, `${vector.name}.wtns`);
    const witnessJsonPath = path.join(workDirectory, `${vector.name}-witness.json`);
    await writeFile(inputPath, JSON.stringify({ in: vector.inputs }), "utf8");

    await execFileAsync("node", [
      path.join(workDirectory, `${circuitName}_js`, "generate_witness.js"),
      path.join(workDirectory, `${circuitName}_js`, `${circuitName}.wasm`),
      inputPath,
      witnessPath,
    ]);
    await execFileAsync(path.join(packageRoot, "node_modules", ".bin", "snarkjs"), [
      "wtns",
      "export",
      "json",
      witnessPath,
      witnessJsonPath,
    ]);

    const witness = JSON.parse(await readFile(witnessJsonPath, "utf8")) as string[];
    assert.equal(witness[1], vector.expected, vector.name);
  }
});
