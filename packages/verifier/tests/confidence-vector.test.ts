import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { computeConfidence, confidenceCommitment } from "../src/confidence.ts";
test("DEV-39 matches the shared canonical scoring report and commitment", () => {
  const v = JSON.parse(
    readFileSync(
      new URL("../../../fixtures/confidence/report-v0.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(v.publicSyntheticTests, true);
  const actual = computeConfidence(v.scope, v.inputs);
  assert.deepEqual(actual, v.report);
  assert.equal(confidenceCommitment(actual), v.commitment);
});
