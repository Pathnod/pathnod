import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import { AppAttestGate } from "./app-attest-gate.ts";
import { EnrollmentError, ObserverEnrollmentService } from "./observer-enrollment.ts";
import { ObserverRootPublisher } from "./root-publication.ts";
import { SolanaRootPublicationTransport } from "./solana-root-publication.ts";
import { DeviceEligibilityService, EligibilityError } from "./device-eligibility.ts";
import { DevelopmentObservationInbox, ObservationInboxError } from "./observation-inbox.ts";
import { ObservationPolicyService, ObservationPolicyError } from "./observation-policy.ts";
import { SolanaObservationPolicySource } from "./observation-solana.ts";
import { PinnedGroth16Verifier } from "./observation-groth16.ts";
import { loadObservationSigner } from "./observation-authorization.ts";

const MAX_BODY = 128 * 1024;

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage, fields: readonly string[], optional: readonly string[] = []): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new EnrollmentError("invalid_input");
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += buffer.length;
    if (size > MAX_BODY) throw new EnrollmentError("invalid_input");
    parts.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw Error();
    if (fields.some(key => !(key in parsed)) ||
        Object.keys(parsed).some((key) => !fields.includes(key) && !optional.includes(key))) throw Error();
    return parsed as Record<string, unknown>;
  } catch { throw new EnrollmentError("invalid_input"); }
}

function object(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BODY ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new EnrollmentError("invalid_input");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new EnrollmentError("invalid_input");
  return decoded;
}

function challenge(value: ReturnType<ObserverEnrollmentService["issueEnrollmentChallenge"]>) {
  return { id: value.id, challenge: value.bytes.toString("base64"), mode: value.mode, expiresAt: value.expiresAt };
}

export function createEnrollmentServer(service: ObserverEnrollmentService, publisher?: ObserverRootPublisher,
  eligibility?: DeviceEligibilityService, inbox?: DevelopmentObservationInbox, policy?: ObservationPolicyService): Server {
  if (inbox && policy) throw Error("Development receipt and policy validation are mutually exclusive");
  let validating = 0;
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        send(response, 200, { status: "ok" });
      } else if (request.method === "GET" && url.pathname === "/root") {
        send(response, 200, { ...service.root(), publication: publisher?.status() ?? { enabled: false } });
      } else if (/^\/devices\/[^/]+\/slots$/.test(url.pathname)) {
        if (request.method !== "GET") {
          response.setHeader("allow", "GET"); send(response, 405, { error: "method_not_allowed" });
        } else {
          if ([...url.searchParams.keys()].some(key => !["epoch", "protocol_id"].includes(key)) ||
              url.searchParams.getAll("epoch").length !== 1 || url.searchParams.getAll("protocol_id").length > 1) {
            throw new EligibilityError("invalid_input");
          }
          if (!eligibility) { send(response, 503, { error: "eligibility_unavailable" }); return; }
          const quote = await eligibility.quote(url.pathname.split("/")[2], url.searchParams.get("epoch"),
            url.searchParams.get("protocol_id") ?? undefined);
          response.setHeader("x-pathnod-epoch-seconds", String(quote.epochSeconds));
          send(response, 200, quote.slots);
        }
      } else if (url.pathname === "/observations") {
        if (request.method !== "POST") {
          response.setHeader("allow", "POST"); send(response, 405, { error: "method_not_allowed" });
        } else if (policy) {
          if (validating >= 2) { send(response, 429, { error: "observation_busy" }); return; }
          validating++;
          try {
            send(response, 202, await policy.receive(await body(request, ["transcript", "assertion", "key_id", "zk"], ["evidence"])));
          } finally { validating--; }
        } else if (!inbox) {
          send(response, 503, { error: "observation_receiver_unavailable" });
        } else if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) {
          send(response, 403, { error: "development_receiver_local_only" });
        } else {
          send(response, 202, await inbox.receive(await body(request, ["transcript", "assertion", "key_id", "zk"], ["evidence"])));
        }
      } else if (request.method === "POST" && url.pathname === "/enroll/challenge") {
        const input = await body(request, ["commitment", "keyID"]);
        send(response, 200, challenge(service.issueEnrollmentChallenge(input.commitment, input.keyID)));
      } else if (request.method === "POST" && url.pathname === "/enroll") {
        const input = await body(request, ["challengeID", "commitment", "keyID", "object"]);
        send(response, 200, service.enroll(input.challengeID, input.commitment, input.keyID, object(input.object)));
      } else if (request.method === "POST" && url.pathname === "/tree/challenge") {
        const input = await body(request, ["commitment", "keyID"]);
        send(response, 200, challenge(service.issueTreeChallenge(input.commitment, input.keyID)));
      } else if (request.method === "GET" && url.pathname === "/tree") {
        send(response, 200, service.treePath(
          request.headers["x-pathnod-challenge-id"], url.searchParams.get("commitment"),
          request.headers["x-pathnod-key-id"], object(request.headers["x-pathnod-assertion"]),
        ));
      } else {
        send(response, 404, { error: "not_found" });
      }
    } catch (error) {
      if (error instanceof ObservationPolicyError) {
        send(response, error.code === "observation_dependency_unavailable" ? 503 : error.code === "observation_capacity" ? 507 : 422,
          { error: error.code });
      } else if (error instanceof ObservationInboxError) {
        send(response, error.code === "receipt_conflict" ? 409 : error.code === "inbox_full" ? 507 : 400, { error: error.code });
      } else if (error instanceof EligibilityError) {
        send(response, error.code === "invalid_input" ? 400 : error.code === "protocol_unknown" ? 404 : 503, { error: error.code });
      } else if (error instanceof EnrollmentError) {
        const status = error.code === "challenge_limit" ? 429 : error.code === "unknown_observer" ? 404 :
          error.code === "already_enrolled" ? 409 : error.code === "tree_full" ? 507 : 400;
        send(response, status, {
          error: error.code,
          ...(process.env.NODE_ENV === "production" || error.reason === undefined ? {} : { reason: error.reason }),
        });
      } else {
        send(response, 500, { error: "internal_error" });
      }
    }
  });
}

async function main(): Promise<void> {
  const db = process.env.PATHNOD_ENROLLMENT_DB;
  const appID = process.env.PATHNOD_APP_ATTEST_APP_ID;
  const environment = process.env.PATHNOD_APP_ATTEST_ENVIRONMENT;
  const categories = (process.env.PATHNOD_APP_ATTEST_CATEGORIES ??
    (environment === "development" ? "3" : "")).split(",").map(Number);
  const versions = (process.env.PATHNOD_APP_ATTEST_BUNDLE_VERSIONS ?? "")
    .split(",").filter((value) => value.length > 0);
  const host = process.env.PATHNOD_ENROLLMENT_HOST ?? "127.0.0.1";
  const receiptDB = process.env.PATHNOD_DEV32_RECEIPT_DB;
  const observationVK = process.env.PATHNOD_OBSERVATION_VK;
  const observationSHA = process.env.PATHNOD_OBSERVATION_VK_SHA256;
  const observationRPC = process.env.PATHNOD_OBSERVATION_RPC_URL;
  const observationProgram = process.env.PATHNOD_OBSERVATION_PROGRAM_ID;
  const observationProtocol = process.env.PATHNOD_OBSERVATION_PROTOCOL_ID;
  const verifierSigner = process.env.PATHNOD_OBSERVATION_VERIFIER_SIGNER;
  const observationEnabled = [observationVK, observationSHA, observationRPC, observationProgram, observationProtocol].some(v => v !== undefined);
  if (observationEnabled && (receiptDB || !observationVK || !observationSHA || !observationRPC || !observationProgram || !observationProtocol)) {
    throw Error("Set all five PATHNOD_OBSERVATION_* required settings; do not enable the development receipt sink.");
  }
  if (verifierSigner && !observationEnabled) throw Error("Verifier signing requires the complete DEV-33 policy configuration");
  if (receiptDB && (process.env.NODE_ENV === "production" || !["127.0.0.1", "::1"].includes(host))) {
    throw Error("DEV-32 receipt sink requires a non-production loopback host.");
  }
  const port = Number(process.env.PATHNOD_ENROLLMENT_PORT ?? "8787");
  if (!db || !appID || (environment !== "development" && environment !== "production") ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      categories.length === 0 || categories.some((value) => ![2, 3, 4, 5].includes(value))) {
    throw Error("Set PATHNOD_ENROLLMENT_DB, PATHNOD_APP_ATTEST_APP_ID, PATHNOD_APP_ATTEST_ENVIRONMENT and a valid port.");
  }
  const gate = new AppAttestGate(db, {
    appID, environment, allowedValidationCategories: categories, allowedBundleVersions: versions,
  }, { maxPendingChallenges: Number(process.env.PATHNOD_PENDING_CHALLENGE_LIMIT ?? "1024") });
  const service = await ObserverEnrollmentService.open(db, gate,
    { maxPendingChallenges: Number(process.env.PATHNOD_PENDING_CHALLENGE_LIMIT ?? "1024") });
  const rpc = process.env.PATHNOD_ROOT_RPC_URL;
  const program = process.env.PATHNOD_ROOT_PROGRAM_ID;
  const signer = process.env.PATHNOD_ROOT_SIGNER;
  let publisher: ObserverRootPublisher | undefined;
  let eligibility: DeviceEligibilityService | undefined;
  let observationPolicy: ObservationPolicyService | undefined;
  try {
    if (observationEnabled) {
      const proof = new PinnedGroth16Verifier(observationVK!, observationSHA!);
      const source = await SolanaObservationPolicySource.open(observationRPC!, observationProgram!, observationProtocol!,
        Number(process.env.PATHNOD_OBSERVATION_MINIMUM_RSSI ?? "-90"), Number(process.env.PATHNOD_OBSERVATION_POLICY_VERSION ?? "1"),
        process.env.PATHNOD_OBSERVATION_GENESIS);
      observationPolicy = new ObservationPolicyService(db, {
        appID, environment, allowedValidationCategories: categories, allowedBundleVersions: versions,
      }, { target: `${source.target}/${proof.digest}/${appID}/${environment}/${categories.join(",")}/${versions.join(",")}`,
        snapshot: t => source.snapshot(t) }, proof,
      verifierSigner ? { relay: { signer: await loadObservationSigner(verifierSigner) } } : {});
    }
    const eligibilityRPC = process.env.PATHNOD_ELIGIBILITY_RPC_URL;
    const eligibilityProgram = process.env.PATHNOD_ELIGIBILITY_PROGRAM_ID;
    const eligibilityProtocol = process.env.PATHNOD_ELIGIBILITY_PROTOCOL_ID;
    const eligibilityMint = process.env.PATHNOD_ELIGIBILITY_REWARD_MINT;
    if ([eligibilityRPC, eligibilityProgram, eligibilityProtocol, eligibilityMint].some(value => value !== undefined)) {
      if (!eligibilityRPC || !eligibilityProgram || !eligibilityProtocol) {
        throw Error("Set all three PATHNOD_ELIGIBILITY_RPC_URL, PATHNOD_ELIGIBILITY_PROGRAM_ID and PATHNOD_ELIGIBILITY_PROTOCOL_ID.");
      }
      eligibility = await DeviceEligibilityService.open(eligibilityRPC, eligibilityProgram, eligibilityProtocol, eligibilityMint);
    }
    if ([rpc, program, signer].some(value => value !== undefined)) {
      if (!rpc || !program || !signer) throw Error("Set all three PATHNOD_ROOT_RPC_URL, PATHNOD_ROOT_PROGRAM_ID and PATHNOD_ROOT_SIGNER.");
      const transport = await SolanaRootPublicationTransport.open(rpc, program, signer);
      publisher = new ObserverRootPublisher(db, service, transport, {
        batchSize: Number(process.env.PATHNOD_ROOT_BATCH_SIZE ?? "16"),
        maxDelayMs: Number(process.env.PATHNOD_ROOT_MAX_DELAY_MS ?? "30000"),
      });
      publisher.start();
    }
  } catch (error) { observationPolicy?.close(); service.close(); gate.close(); throw error; }
  const inbox = receiptDB ? new DevelopmentObservationInbox(receiptDB) : undefined;
  const server = createEnrollmentServer(service, publisher, eligibility, inbox, observationPolicy);
  server.requestTimeout = 15_000;
  server.listen(port, host, () => { process.stdout.write(`Enrollment server listening on ${host}:${port}\n`); });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close(() => {
      void (async () => { await publisher?.close(); observationPolicy?.close(); inbox?.close(); service.close(); gate.close(); })();
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Server failed"}\n`);
    process.exitCode = 1;
  });
}
