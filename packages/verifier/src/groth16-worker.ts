import { groth16 } from "snarkjs";

// Use a child PROCESS: ffjavascript/web-worker incorrectly assumes every worker_threads
// parent belongs to its own worker harness. A process also bounds all nested crypto workers.
process.once("message", async (input: { key: unknown; inputs: string[]; proof: unknown }) => {
  try { process.send?.(await groth16.verify(input.key, input.inputs, input.proof)); }
  catch { process.send?.(false); }
});
