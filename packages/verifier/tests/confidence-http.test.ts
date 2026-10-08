import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AppAttestGate } from "../src/app-attest-gate.ts";
import { ObserverEnrollmentService } from "../src/observer-enrollment.ts";
import {
  ObservationPolicyService,
  type ObservationPolicySource,
} from "../src/observation-policy.ts";
import { createEnrollmentServer } from "../src/enrollment-http.ts";

async function fixture(enabled = true) {
  const directory = await mkdtemp(
      path.join(tmpdir(), "pathnod-confidence-http-"),
    ),
    database = path.join(directory, "enrollment.sqlite");
  const policy = {
    appID: "U5MCCC24G5.xyz.pathnod.appattestspike",
    environment: "development" as const,
    allowedValidationCategories: [3],
    allowedBundleVersions: [],
  };
  const gate = new AppAttestGate(database, policy),
    enrollment = await ObserverEnrollmentService.open(database, gate);
  const vector = JSON.parse(
    await readFile(
      new URL("../../../fixtures/confidence/report-v0.json", import.meta.url),
      "utf8",
    ),
  );
  const report = vector.report,
    commitment = vector.commitment,
    signature = "public-synthetic-test-signature";
  let state:
    | {
        program: string;
        protocolID: string;
        policyVersion: number;
        observationRoot: string;
        observerCount: number;
        commitment: string;
      }
    | undefined = {
    program: report.scope.program,
    protocolID: report.scope.protocolID,
    policyVersion: 1,
    observationRoot: report.scope.observationRoot,
    observerCount: report.scope.transcriptOrder.length,
    commitment,
  };
  let calls = 0,
    unavailable = false;
  const source: ObservationPolicySource = {
    target: "public-synthetic-http-confidence-test",
    snapshot: async () => {
      throw Error("Unexpected observation validation");
    },
    confidenceState: async () => {
      calls++;
      if (unavailable) throw Error("private RPC failure detail");
      return state;
    },
  };
  const service = new ObservationPolicyService(database, policy, source, {
    verify: async () => {
      throw Error("Unexpected proof verification");
    },
  });
  const db = new DatabaseSync(database);
  db.exec(
    "CREATE TABLE confidence_reports_v0 (device_id TEXT,epoch INTEGER,target TEXT,commitment TEXT,report TEXT,signature TEXT)",
  );
  db.prepare("INSERT INTO confidence_reports_v0 VALUES (?,?,?,?,?,?)").run(
    report.scope.deviceID,
    report.scope.epoch,
    source.target,
    commitment,
    JSON.stringify(report),
    signature,
  );
  const server = createEnrollmentServer(
    enrollment,
    undefined,
    undefined,
    undefined,
    enabled ? service : undefined,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/devices/${report.scope.deviceID}/confidence`;
  return {
    report,
    commitment,
    signature,
    endpoint,
    db,
    source,
    get calls() {
      return calls;
    },
    setState: (value: typeof state) => {
      state = value;
    },
    get state() {
      return state!;
    },
    setUnavailable: () => {
      unavailable = true;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      service.close();
      db.close();
      enrollment.close();
      gate.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function read(url: string) {
  const response = await fetch(url);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body: unknown = await response.json();
  assert.ok(body && typeof body === "object" && !Array.isArray(body));
  return { status: response.status, body: body as Record<string, unknown> };
}

test("Confidence HTTP published response passes through the router, service and SQLite without exposing private inputs", async () => {
  const f = await fixture();
  try {
    const expected = {
      status: "published",
      commitment: f.commitment,
      confidence: f.report,
      transaction_signature: f.signature,
    };
    assert.deepEqual(
      await read(`${f.endpoint}?epoch=${f.report.scope.epoch}`),
      { status: 200, body: expected },
    );
    assert.equal(f.calls, 1);
    assert.ok(!Object.hasOwn(expected.confidence, "inputs"));
    assert.ok(!Object.hasOwn(expected, "key_id"));
    assert.ok(!Object.hasOwn(expected, "assertion"));
    const stored = f.db.prepare("SELECT * FROM confidence_reports_v0").get();
    await read(`${f.endpoint}?epoch=${f.report.scope.epoch}`);
    assert.deepEqual(
      f.db.prepare("SELECT * FROM confidence_reports_v0").get(),
      stored,
    );
  } finally {
    await f.close();
  }
});
test("Confidence HTTP unknown device/epoch returns stable 404 without querying chain state", async () => {
  const f = await fixture();
  try {
    for (const url of [
      `${f.endpoint}?epoch=0`,
      `${f.endpoint}?epoch=4294967295`,
      `${f.endpoint.replace(f.report.scope.deviceID, "ff".repeat(32))}?epoch=${f.report.scope.epoch}`,
    ]) {
      assert.deepEqual(await read(url), {
        status: 404,
        body: { error: "confidence_unknown" },
      });
    }
    assert.equal(f.calls, 0);
  } finally {
    await f.close();
  }
});
test("Confidence HTTP hash mismatch or a missing epoch returns stale with no active report or transaction link", async () => {
  const f = await fixture();
  try {
    f.setState({ ...f.state, commitment: "ff".repeat(32) });
    assert.deepEqual(
      await read(`${f.endpoint}?epoch=${f.report.scope.epoch}`),
      {
        status: 200,
        body: { status: "stale", commitment: null, confidence: null },
      },
    );
    f.setState(undefined);
    assert.deepEqual(
      await read(`${f.endpoint}?epoch=${f.report.scope.epoch}`),
      {
        status: 200,
        body: { status: "stale", commitment: null, confidence: null },
      },
    );
  } finally {
    await f.close();
  }
});
test("Confidence HTTP policy rotation makes a previously published report stale", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await read(`${f.endpoint}?epoch=${f.report.scope.epoch}`)).body.status,
      "published",
    );
    f.setState({ ...f.state, policyVersion: 2 });
    assert.deepEqual(
      await read(`${f.endpoint}?epoch=${f.report.scope.epoch}`),
      {
        status: 200,
        body: { status: "stale", commitment: null, confidence: null },
      },
    );
  } finally {
    await f.close();
  }
});
test("Confidence HTTP observation invalidation stops serving the prior report after root/count/commitment change", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await read(`${f.endpoint}?epoch=${f.report.scope.epoch}`)).body.status,
      "published",
    );
    f.setState({
      ...f.state,
      commitment: "00".repeat(32),
      observationRoot: "33".repeat(32),
      observerCount: 2,
    });
    assert.deepEqual(
      await read(`${f.endpoint}?epoch=${f.report.scope.epoch}`),
      {
        status: 200,
        body: { status: "stale", commitment: null, confidence: null },
      },
    );
  } finally {
    await f.close();
  }
});
test("Confidence HTTP malformed/repeated/unexpected epoch parameters return 400 before any chain query", async () => {
  const f = await fixture();
  try {
    for (const query of [
      "",
      "?epoch=",
      "?epoch=-1",
      "?epoch=1.5",
      "?epoch=042",
      "?epoch=0x2a",
      "?epoch=%2042",
      "?epoch=4294967296",
      "?epoch=abc",
      "?epoch=42&epoch=42",
      "?epoch=42&epoch=43",
      "?epoch=42&extra=1",
    ]) {
      assert.deepEqual(
        await read(f.endpoint + query),
        { status: 400, body: { error: "invalid_input" } },
        query,
      );
    }
    assert.equal(f.calls, 0);
  } finally {
    await f.close();
  }
});
test("Confidence HTTP unavailable RPC or disabled policy returns 503 without leaking internal error details", async () => {
  const f = await fixture(),
    disabled = await fixture(false);
  try {
    f.setUnavailable();
    assert.deepEqual(
      await read(`${f.endpoint}?epoch=${f.report.scope.epoch}`),
      { status: 503, body: { error: "observation_dependency_unavailable" } },
    );
    assert.deepEqual(
      await read(`${disabled.endpoint}?epoch=${disabled.report.scope.epoch}`),
      { status: 503, body: { error: "observation_dependency_unavailable" } },
    );
  } finally {
    await f.close();
    await disabled.close();
  }
});
