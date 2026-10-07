import Foundation
import XCTest
import PathnodObserverEnrollment
@testable import PathnodObservationCore

private struct SubmissionStore: ObserverSecretStore {
    let secret: Data
    func load() throws -> Data? { secret }
    func insertIfAbsent(_ secret: Data) throws -> Bool { false }
}
@MainActor private final class SubmissionProver: ObservationProver {
    var mismatch = false
    var seen: ObservationWitness?
    func prove(_ witness: ObservationWitness) async throws -> ObservationZK {
        seen = witness
        var inputs = witness.publicInputs; if mismatch { inputs[0] = "0" }
        return ObservationZK(proof: testProof(), publicInputs: inputs)
    }
}
@MainActor private final class SubmissionAttester: ObservationAssertionProvider {
    var hashes: [Data] = []
    func assertion(for transcriptHash: Data) async throws -> (keyID: String, object: Data) {
        hashes.append(transcriptHash); return ("synthetic-key", Data([42]))
    }
}
private func testProof() -> ObservationGroth16Proof {
    // Framing only: explicitly NOT a valid cryptographic proof.
    ObservationGroth16Proof(a: ["1", "2", "1"], b: [["3", "4"], ["5", "6"], ["1", "0"]], c: ["7", "8", "1"])
}
final class ObservationSubmissionTests: XCTestCase {
    private func vector() throws -> [String: Any] {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appending(path: "fixtures/observations/transcript-v0.json"))
        let all = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try XCTUnwrap((all["vectors"] as? [[String: Any]])?.first)
    }
    private func bytes(_ hex: String) throws -> Data { try ObservationEncoding.id(hex) }
    private func input() throws -> (ObservationCapture, ObserverCredential, ObserverMerklePath, ObservationTranscript) {
        let v = try vector()
        let capture = try JSONDecoder().decode(ObservationCapture.self, from: JSONSerialization.data(withJSONObject: XCTUnwrap(v["capture"])))
        let path = try JSONDecoder().decode(ObserverMerklePath.self, from: JSONSerialization.data(withJSONObject: XCTUnwrap(v["enrollment"])))
        let secretHex = try XCTUnwrap(v["secret"] as? String)
        let secret = try bytes("0x00" + secretHex.dropFirst(2)).dropFirst()
        let credential = try ObserverCredentialManager(store: SubmissionStore(secret: Data(secret))).loadOrCreate()
        let t = try ObservationTranscript(capture: capture, credential: credential, enrollment: path)
        return (capture, credential, path, t)
    }
    @MainActor func testPreparationBindsAssertionAndSevenPublicInputsWithoutLeakingWitness() async throws {
        let (capture, credential, path, t) = try input()
        let prover = SubmissionProver(), attester = SubmissionAttester()
        let envelope = try await ObservationSubmission.prepare(capture: capture, credential: credential, enrollment: path,
            prover: prover, attester: attester)
        XCTAssertEqual(attester.hashes, [try t.transcriptHash()])
        XCTAssertEqual(envelope.zk.public, prover.seen?.publicInputs)
        XCTAssertEqual(prover.seen?.inputs["merkle_index"], path.directions.map(String.init))
        XCTAssertEqual(prover.seen?.inputs["s_obs"], [ObservationWitness.decimal(Data([0]) + credential.secretBytes)])
        let json = String(decoding: try JSONEncoder().encode(envelope), as: UTF8.self)
        if let destination = ProcessInfo.processInfo.environment["PATHNOD_DEV32_SWIFT_ENVELOPE"] {
            try Data(json.utf8).write(to: URL(fileURLWithPath: destination), options: .atomic)
        }
        XCTAssertFalse(json.contains("s_obs")); XCTAssertFalse(json.contains("merkle_path")); XCTAssertFalse(json.contains("commitment"))
        prover.mismatch = true
        do { _ = try await ObservationSubmission.prepare(capture: capture, credential: credential, enrollment: path,
            prover: prover, attester: attester); XCTFail("mismatched proof accepted") }
        catch { XCTAssertEqual(error as? ObservationSubmissionError, .proofMismatch) }
        XCTAssertEqual(attester.hashes.count, 1)
    }
    @MainActor func testDurableRetryReusesEnvelopeAndRequiresMatchingReceipt() async throws {
        let (capture, credential, path, _) = try input()
        let envelope = try await ObservationSubmission.prepare(capture: capture, credential: credential, enrollment: path,
            prover: SubmissionProver(), attester: SubmissionAttester())
        let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appending(path: "outbox.json"), endpoint = URL(string: "https://verifier.example/observations")!
        let queue = ObservationOutbox(url: url)
        try queue.enqueue(envelope, endpoint: endpoint); try queue.enqueue(envelope, endpoint: endpoint)
        XCTAssertEqual(try queue.entries().count, 1)
        let now = Date()
        var sent: [Data] = []
        let failing = try ObservationHTTPClient(baseURL: endpoint.deletingLastPathComponent()) { request in
            sent.append(try XCTUnwrap(request.httpBody)); throw URLError(.notConnectedToInternet)
        }
        do { _ = try await queue.drain(client: failing, now: now); XCTFail() } catch {}
        let restored = ObservationOutbox(url: url)
        XCTAssertEqual(try restored.entries().first?.attempts, 1)
        let valid = try ObservationHTTPClient(baseURL: endpoint.deletingLastPathComponent()) { request in
            sent.append(try XCTUnwrap(request.httpBody))
            return (try JSONEncoder().encode(ObservationReceipt(hash: envelope.hashHex())),
                HTTPURLResponse(url: endpoint, statusCode: 202, httpVersion: nil, headerFields: nil)!)
        }
        let early = try await restored.drain(client: valid, now: now); XCTAssertEqual(early, 0)
        let received = try await restored.drain(client: valid, now: now.addingTimeInterval(3)); XCTAssertEqual(received, 1)
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(sent[0], sent[1])
        let first = try JSONDecoder().decode(ObservationEnvelope.self, from: sent[0])
        let second = try JSONDecoder().decode(ObservationEnvelope.self, from: sent[1])
        XCTAssertEqual(first, second); XCTAssertTrue(try restored.entries().isEmpty)
        XCTAssertTrue(try ObservationOutbox(url: url).wasReceived(hash: envelope.hashHex(), endpoint: endpoint))
        XCTAssertThrowsError(try restored.enqueue(envelope, endpoint: endpoint))
    }
    @MainActor func testWrongReceiptAndTerminalFailureRetainQueueAndEndpointBinding() async throws {
        let (capture, credential, path, _) = try input()
        let e = try await ObservationSubmission.prepare(capture: capture, credential: credential, enrollment: path,
            prover: SubmissionProver(), attester: SubmissionAttester())
        let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let queue = ObservationOutbox(url: dir.appending(path: "outbox.json"))
        let endpoint = URL(string: "https://verifier.example/observations")!
        try queue.enqueue(e, endpoint: endpoint)
        let other = try ObservationHTTPClient(baseURL: URL(string: "https://other.example")!) { _ in XCTFail("cross-origin leak"); throw URLError(.unknown) }
        let count = try await queue.drain(client: other); XCTAssertEqual(count, 0)
        let wrong = try ObservationHTTPClient(baseURL: endpoint.deletingLastPathComponent()) { _ in
            (try JSONEncoder().encode(ObservationReceipt(hash: String(repeating: "0", count: 64))),
                HTTPURLResponse(url: endpoint, statusCode: 202, httpVersion: nil, headerFields: nil)!)
        }
        do { _ = try await queue.drain(client: wrong); XCTFail() }
        catch { XCTAssertEqual(error as? ObservationSubmissionError, .invalidReceipt) }
        let rejected = try ObservationHTTPClient(baseURL: endpoint.deletingLastPathComponent()) { _ in
            (Data(), HTTPURLResponse(url: endpoint, statusCode: 400, httpVersion: nil, headerFields: nil)!)
        }
        do { _ = try await queue.drain(client: rejected, now: Date().addingTimeInterval(10)); XCTFail() } catch {}
        XCTAssertEqual(try queue.entries().first?.rejected, true)
    }
    @MainActor func testBackoffPreservesAssertionOrderAcrossRestart() async throws {
        let (_, credential, path, firstTranscript) = try input()
        var secondTranscript = firstTranscript
        secondTranscript.observationTimeMilliseconds += 1
        // Framing-only envelopes; these bytes model increasing assertion counters,
        // not genuine App Attest assertions or Groth16 proofs.
        func envelope(_ transcript: ObservationTranscript, counter: UInt8) throws -> ObservationEnvelope {
            let witness = try ObservationWitness(transcript: transcript, credential: credential, enrollment: path)
            return try ObservationEnvelope(transcript: transcript.encode(), assertion: Data([counter]), keyID: "synthetic-key",
                zk: ObservationZK(proof: testProof(), publicInputs: witness.publicInputs))
        }
        let first = try envelope(firstTranscript, counter: 1), second = try envelope(secondTranscript, counter: 2)
        XCTAssertNotEqual(try first.hashHex(), try second.hashHex())
        let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appending(path: "outbox.json")
        let base = URL(string: "https://verifier.example")!, endpoint = base.appending(path: "observations")
        let queue = ObservationOutbox(url: file)
        try queue.enqueue(first, endpoint: endpoint); try queue.enqueue(second, endpoint: endpoint)
        let now = Date(timeIntervalSince1970: 1_000)
        var failedBody: Data?
        let failing = try ObservationHTTPClient(baseURL: base) { request in
            failedBody = request.httpBody; throw URLError(.notConnectedToInternet)
        }
        do { _ = try await queue.drain(client: failing, now: now); XCTFail("send should fail") }
        catch { XCTAssertEqual((error as? URLError)?.code, .notConnectedToInternet) }
        let restored = ObservationOutbox(url: file)
        XCTAssertEqual(try restored.entries().map(\.attempts), [1, 0])
        var sent: [Data] = [], lastCounter: UInt8 = 0
        let accepting = try ObservationHTTPClient(baseURL: base) { request in
            let body = try XCTUnwrap(request.httpBody)
            let entry = try JSONDecoder().decode(ObservationEnvelope.self, from: body)
            let counter = try XCTUnwrap(Data(base64Encoded: entry.assertion)?.first)
            XCTAssertGreaterThan(counter, lastCounter)
            lastCounter = counter; sent.append(body)
            return (try JSONEncoder().encode(ObservationReceipt(hash: entry.hashHex())),
                HTTPURLResponse(url: endpoint, statusCode: 202, httpVersion: nil, headerFields: nil)!)
        }
        let early = try await restored.drain(client: accepting, now: now)
        XCTAssertEqual(early, 0); XCTAssertTrue(sent.isEmpty)
        XCTAssertEqual(try restored.entries().count, 2)
        let recovered = try await restored.drain(client: accepting, now: now.addingTimeInterval(2))
        XCTAssertEqual(recovered, 2); XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(sent.first, failedBody)
        XCTAssertEqual(try sent.map { try JSONDecoder().decode(ObservationEnvelope.self, from: $0) }, [first, second])
        XCTAssertTrue(try ObservationOutbox(url: file).entries().isEmpty)
    }

    @MainActor func testInvalidURLsAndCorruptQueueFailClosed() throws {
        for text in ["http://evil.example", "https://u:p@verifier.example", "https://verifier.example?x=1", "https://verifier.example#x"] {
            XCTAssertThrowsError(try ObservationHTTPClient(baseURL: URL(string: text)!, allowLocalHTTP: true))
        }
        XCTAssertNoThrow(try ObservationHTTPClient(baseURL: URL(string: "http://localhost:8787")!, allowLocalHTTP: true))
        let file = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        try Data("{}".utf8).write(to: file)
        XCTAssertThrowsError(try ObservationOutbox(url: file).entries())
        XCTAssertEqual(try Data(contentsOf: file), Data("{}".utf8))
    }
}
