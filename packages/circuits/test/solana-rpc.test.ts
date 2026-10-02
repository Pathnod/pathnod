import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection, PublicKey } from "@solana/web3.js";

test("web3 RPC client remains compatible with the scoped jayson override", async () => {
  const calls: string[] = [];
  const signature = "1".repeat(64);
  const connection = new Connection("http://127.0.0.1:8899", {
    commitment: "confirmed",
    fetch: async (_url, init) => {
      assert.equal(typeof init?.body, "string");
      const request = JSON.parse(init!.body as string);
      assert.equal(request.jsonrpc, "2.0");
      assert.equal(typeof request.id, "string");
      calls.push(request.method);
      let result: unknown;
      switch (request.method) {
        case "getBalance":
          result = { context: { slot: 1 }, value: 3_000_000_000 };
          break;
        case "getLatestBlockhash":
          result = { context: { slot: 1 }, value: {
            blockhash: "1".repeat(32), lastValidBlockHeight: 100,
          } };
          break;
        case "sendTransaction":
          assert.equal(request.params[0], "AQID");
          assert.equal(request.params[1].encoding, "base64");
          result = signature;
          break;
        case "getSignatureStatuses":
          assert.deepEqual(request.params[0], [signature]);
          result = { context: { slot: 1 }, value: [{ slot: 1,
            confirmations: 1, err: null, confirmationStatus: "confirmed",
          }] };
          break;
        default:
          throw new Error(`Unexpected RPC method: ${request.method}`);
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal(await connection.getBalance(new PublicKey("1".repeat(32))), 3_000_000_000);
  assert.equal((await connection.getLatestBlockhash()).lastValidBlockHeight, 100);
  assert.equal(await connection.sendRawTransaction(Uint8Array.of(1, 2, 3)), signature);
  assert.equal((await connection.getSignatureStatuses([signature])).value[0]?.confirmationStatus, "confirmed");
  assert.deepEqual(calls, ["getBalance", "getLatestBlockhash", "sendTransaction", "getSignatureStatuses"]);
});
