import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ObservationEnvelope } from "./observation-inbox.ts";
import type { ObservationProofVerifier } from "./observation-policy.ts";
import { verificationKeyDigest } from "@pathnod/solana";

/** Pin a trusted circuit VK, NOT a key supplied by the observation. No prover artifacts needed. */
export class PinnedGroth16Verifier implements ObservationProofVerifier {
  readonly digest: string;
  readonly keyDigest: string;
  readonly #key: unknown;
  constructor(path: string, expectedSHA256: string) {
    if (!/^[a-f0-9]{64}$/.test(expectedSHA256) || statSync(path).size > 64 * 1024) throw Error("Invalid VK configuration");
    const bytes = readFileSync(path);
    this.digest = createHash("sha256").update(bytes).digest("hex");
    if (this.digest !== expectedSHA256) throw Error("Verification key digest mismatch");
    const key = JSON.parse(bytes.toString("utf8"));
    if (!key || key.protocol !== "groth16" || key.curve !== "bn128" || key.nPublic !== 7 ||
      !Array.isArray(key.IC) || key.IC.length !== 8 || !Array.isArray(key.vk_alpha_1) ||
      !Array.isArray(key.vk_beta_2) || !Array.isArray(key.vk_gamma_2) || !Array.isArray(key.vk_delta_2)) {
      throw Error("Expected trusted DEV-13 seven-input BN254 Groth16 verification key");
    }
    this.#key = key;
    this.keyDigest = verificationKeyDigest(key);
  }
  async verify(envelope: ObservationEnvelope): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const worker = fork(fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./groth16-worker.ts" : "./groth16-worker.js", import.meta.url)),
        { execArgv: ["--max-old-space-size=128"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
      let settled = false;
      const finish = (value?: boolean) => {
        if (settled) return; settled = true; clearTimeout(timer);
        worker.kill("SIGKILL");
        if (value === undefined) reject(Error("Proof verifier unavailable")); else resolve(value);
      };
      const timer = setTimeout(() => finish(), 15_000);
      worker.once("message", (value: unknown) => finish(value === true));
      worker.once("error", () => finish());
      worker.once("exit", () => finish());
      worker.send({ key: this.#key, inputs: envelope.zk.public, proof: envelope.zk.proof }, error => { if (error) finish(); });
    });
  }
}
