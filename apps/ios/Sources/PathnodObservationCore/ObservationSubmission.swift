import CryptoKit
import Foundation
import PathnodObserverEnrollment

public enum ObservationSubmissionError: Error, Equatable, LocalizedError {
    case invalidEnvelope, proofMismatch, proverUnavailable, invalidEndpoint, queueFull, corruptQueue, alreadyReceived
    case http(Int), invalidReceipt
    public var errorDescription: String? {
        switch self {
        case .invalidEnvelope: "The submission envelope is malformed."
        case .proofMismatch: "The proof does not match this observation and enrollment."
        case .proverUnavailable: "Mopro is unavailable in this build."
        case .invalidEndpoint: "Use an HTTPS verifier URL without credentials, query or fragment."
        case .queueFull: "The local outbox is full; no observation was discarded."
        case .corruptQueue: "The local outbox could not be validated; it was not erased."
        case .alreadyReceived: "This observation was already received by this service."
        case .http(let code): "Verifier returned HTTP \(code)."
        case .invalidReceipt: "The verifier did not return a matching receipt."
        }
    }
}

/// Standard snarkjs Groth16 JSON. No Solana-specific point conversion on this wire.
public struct ObservationGroth16Proof: Codable, Sendable, Equatable {
    public let pi_a: [String]
    public let pi_b: [[String]]
    public let pi_c: [String]
    public let `protocol`: String
    public let curve: String

    public init(a: [String], b: [[String]], c: [String]) {
        pi_a = a; pi_b = b; pi_c = c; `protocol` = "groth16"; curve = "bn128"
    }

    public func validate() throws {
        let coordinates = pi_a + pi_b.flatMap { $0 } + pi_c
        guard `protocol` == "groth16", curve == "bn128", pi_a.count == 3, pi_b.count == 3,
              pi_b.allSatisfy({ $0.count == 2 }), pi_c.count == 3,
              pi_a[2] == "1", pi_b[2] == ["1", "0"], pi_c[2] == "1",
              coordinates.allSatisfy({ Self.isDecimal($0) && ($0.count < 77 || ($0.count == 77 &&
                  $0 < "21888242871839275222246405745257275088696311157297823662689037894645226208583")) })
        else { throw ObservationSubmissionError.invalidEnvelope }
    }

    static func isDecimal(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 78 && (value == "0" || !value.hasPrefix("0")) &&
        value.utf8.allSatisfy { (48...57).contains($0) }
    }
}

public struct ObservationZK: Codable, Sendable, Equatable {
    public let proof: ObservationGroth16Proof
    public let `public`: [String]
    public init(proof: ObservationGroth16Proof, publicInputs: [String]) { self.proof = proof; `public` = publicInputs }
}

/// Secret and Merkle witness are held in memory only and never encoded in the envelope or queue.
public struct ObservationWitness: Sendable {
    public let inputs: [String: [String]]
    public let publicInputs: [String]

    public init(transcript: ObservationTranscript, credential: ObserverCredential, enrollment: ObserverMerklePath) throws {
        try transcript.validate()
        try enrollment.validate(expectedCommitment: "0x" + credential.commitmentHex)
        let protocolField = try Self.idField(transcript.protocolID, domain: 3)
        let deviceField = try Self.idField(transcript.deviceID, domain: 4)
        let secret = Data([0]) + credential.secretBytes
        let epoch = Data(repeating: 0, count: 28) + Data((0..<4).reversed().map { UInt8(truncatingIfNeeded: transcript.epoch >> ($0 * 8)) })
        guard transcript.observerClass == enrollment.observerClass,
              try PoseidonCommitment.hashThree(ObservationEncoding.field(2), secret, protocolField) == transcript.pseudonym,
              try PoseidonCommitment.hashFive(ObservationEncoding.field(1), secret, protocolField, deviceField, epoch) == transcript.nullifier
        else { throw ObservationSubmissionError.proofMismatch }
        publicInputs = try [enrollment.root].map { Self.decimal(try ObservationEncoding.id($0)) } +
            [Self.decimal(protocolField), Self.decimal(deviceField), String(transcript.epoch),
             Self.decimal(transcript.nullifier), Self.decimal(transcript.pseudonym), String(transcript.observerClass)]
        inputs = ["s_obs": [Self.decimal(secret)], "class": [String(enrollment.observerClass)],
            "merkle_path": try enrollment.siblings.map { Self.decimal(try ObservationEncoding.id($0)) },
            "merkle_index": enrollment.directions.map(String.init), "root": [publicInputs[0]],
            "protocol_id_f": [publicInputs[1]], "device_id_f": [publicInputs[2]], "epoch": [publicInputs[3]],
            "nullifier": [publicInputs[4]], "pseudonym": [publicInputs[5]], "class_pub": [publicInputs[6]]]
    }

    public static func idField(_ id: Data, domain: UInt8) throws -> Data {
        guard id.count == 32 else { throw ObservationSubmissionError.invalidEnvelope }
        return try PoseidonCommitment.hashThree(ObservationEncoding.field(domain),
            Data(repeating: 0, count: 16) + id.prefix(16), Data(repeating: 0, count: 16) + id.suffix(16))
    }

    public static func decimal(_ bytes: Data) -> String {
        var digits = [0]
        for byte in bytes {
            var carry = Int(byte)
            for i in digits.indices { let value = digits[i] * 256 + carry; digits[i] = value % 10; carry = value / 10 }
            while carry > 0 { digits.append(carry % 10); carry /= 10 }
        }
        return digits.reversed().map(String.init).joined()
    }
}

public struct ObservationEnvelope: Codable, Sendable, Equatable {
    public let transcript: String
    public let assertion: String
    public let key_id: String
    public let zk: ObservationZK
    public let evidence: String?

    public init(transcript: Data, assertion: Data, keyID: String, zk: ObservationZK, evidence: Data? = nil) throws {
        self.transcript = transcript.base64EncodedString(); self.assertion = assertion.base64EncodedString()
        key_id = keyID; self.zk = zk; self.evidence = evidence?.base64EncodedString()
        try validate()
    }

    public func validate() throws {
        guard let bytes = Data(base64Encoded: transcript), bytes.base64EncodedString() == transcript,
              let attestation = Data(base64Encoded: assertion), !attestation.isEmpty, attestation.count <= 16_384,
              attestation.base64EncodedString() == assertion, !key_id.isEmpty, key_id.utf8.count <= 1024,
              zk.public.count == 7, zk.public.allSatisfy({ ObservationGroth16Proof.isDecimal($0) })
        else { throw ObservationSubmissionError.invalidEnvelope }
        let t = try ObservationTranscript.decode(bytes)
        let expected = [try ObservationWitness.idField(t.protocolID, domain: 3), try ObservationWitness.idField(t.deviceID, domain: 4)]
        guard Array(zk.public[1...6]) == [ObservationWitness.decimal(expected[0]), ObservationWitness.decimal(expected[1]),
            String(t.epoch), ObservationWitness.decimal(t.nullifier), ObservationWitness.decimal(t.pseudonym), String(t.observerClass)]
        else { throw ObservationSubmissionError.proofMismatch }
        let fieldLimit = "21888242871839275222246405745257275088548364400416034343698204186575808495617"
        guard zk.public.allSatisfy({ $0.count < fieldLimit.count || ($0.count == fieldLimit.count && $0 < fieldLimit) })
        else { throw ObservationSubmissionError.invalidEnvelope }
        let evidenceBytes: Data?
        if let evidence {
            guard let decoded = Data(base64Encoded: evidence), decoded.count <= 16_384,
                  decoded.base64EncodedString() == evidence else { throw ObservationSubmissionError.invalidEnvelope }
            evidenceBytes = decoded
        } else { evidenceBytes = nil }
        guard ObservationTranscript.hashEvidence(evidenceBytes) == t.evidenceHash else { throw ObservationSubmissionError.invalidEnvelope }
        try zk.proof.validate()
    }

    public func hashHex() throws -> String {
        try validate()
        return try ObservationTranscript.decode(Data(base64Encoded: transcript)!).transcriptHash().map { String(format: "%02x", $0) }.joined()
    }
}

public struct ObservationReceipt: Codable, Sendable, Equatable {
    public let status: String
    public let transcript_hash: String
    public let policy_validated: Bool
    public init(hash: String, validated: Bool = false) {
        status = validated ? "validated" : "received"; transcript_hash = hash; policy_validated = validated
    }
}

@MainActor public protocol ObservationProver {
    func prove(_ witness: ObservationWitness) async throws -> ObservationZK
}

@MainActor public protocol ObservationAssertionProvider {
    func assertion(for transcriptHash: Data) async throws -> (keyID: String, object: Data)
}

@MainActor public enum ObservationSubmission {
    public static func prepare(capture: ObservationCapture, credential: ObserverCredential, enrollment: ObserverMerklePath,
                               prover: any ObservationProver, attester: any ObservationAssertionProvider) async throws -> ObservationEnvelope {
        let t = try ObservationTranscript(capture: capture, credential: credential, enrollment: enrollment)
        let witness = try ObservationWitness(transcript: t, credential: credential, enrollment: enrollment)
        let zk = try await prover.prove(witness)
        try Task.checkCancellation()
        guard zk.public == witness.publicInputs else { throw ObservationSubmissionError.proofMismatch }
        try zk.proof.validate()
        let attestation = try await attester.assertion(for: t.transcriptHash())
        try Task.checkCancellation()
        return try ObservationEnvelope(transcript: t.encode(), assertion: attestation.object, keyID: attestation.keyID, zk: zk)
    }
}

@MainActor public final class ObservationHTTPClient {
    public typealias Transport = (URLRequest) async throws -> (Data, HTTPURLResponse)
    public let endpoint: URL
    private let transport: Transport

    public init(baseURL: URL, allowLocalHTTP: Bool = false, transport: Transport? = nil) throws {
        guard let host = baseURL.host, !host.isEmpty, baseURL.user == nil, baseURL.password == nil,
              baseURL.query == nil, baseURL.fragment == nil,
              baseURL.scheme == "https" || (allowLocalHTTP && baseURL.scheme == "http" &&
                (host == "localhost" || host == "127.0.0.1" || host == "::1" || host.hasSuffix(".local")))
        else { throw ObservationSubmissionError.invalidEndpoint }
        endpoint = baseURL.appending(path: "observations")
        self.transport = transport ?? { request in
        let session = URLSession(configuration: .ephemeral, delegate: ObservationNoRedirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (bytes, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ObservationSubmissionError.invalidReceipt }
        return (bytes, response)
        }
    }

    public func send(_ envelope: ObservationEnvelope) async throws -> ObservationReceipt {
        try envelope.validate()
        var request = URLRequest(url: endpoint); request.httpMethod = "POST"; request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        request.httpBody = try encoder.encode(envelope)
        let (bytes, response) = try await transport(request)
        guard response.url == endpoint else { throw ObservationSubmissionError.invalidReceipt }
        guard response.statusCode == 202 else { throw ObservationSubmissionError.http(response.statusCode) }
        guard bytes.count <= 4096, let receipt = try? JSONDecoder().decode(ObservationReceipt.self, from: bytes),
              ((receipt.status == "received" && !receipt.policy_validated) ||
               (receipt.status == "validated" && receipt.policy_validated)), receipt.transcript_hash == (try envelope.hashHex())
        else { throw ObservationSubmissionError.invalidReceipt }
        return receipt
    }
}

private final class ObservationNoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// One serial queue per service URL. Retries send identical bytes/assertion (no new Apple counter).
@MainActor public final class ObservationOutbox {
    public struct Entry: Codable, Sendable, Equatable {
        public let endpoint: URL
        public let envelope: ObservationEnvelope
        public var attempts: Int = 0
        public var nextAttempt: Date = .distantPast
        public var rejected: Bool = false
    }
    private let url: URL
    private var draining = false
    private struct State: Codable {
        var version = 0
        var pending: [Entry] = []
        var received: [String] = []
        // Optional preserves compatibility with existing DEV-32 queue files.
        var validated: [String]? = nil
    }
    public init(url: URL) { self.url = url }

    public func entries() throws -> [Entry] { try load().pending }

    public func wasReceived(hash: String, endpoint: URL) throws -> Bool {
        try load().received.contains(endpoint.absoluteString + ":" + hash)
    }

    public func wasValidated(hash: String, endpoint: URL) throws -> Bool {
        try load().validated?.contains(endpoint.absoluteString + ":" + hash) ?? false
    }

    private func load() throws -> State {
        guard FileManager.default.fileExists(atPath: url.path) else { return State() }
        do {
            let data = try Data(contentsOf: url)
            guard data.count <= 8_388_608 else { throw ObservationSubmissionError.corruptQueue }
            let state = try JSONDecoder().decode(State.self, from: data)
            guard state.version == 0, state.pending.count <= 128, state.received.count <= 1024,
                  state.received.allSatisfy({ $0.utf8.count <= 4096 }),
                  (state.validated?.count ?? 0) <= 1024,
                  (state.validated ?? []).allSatisfy({ state.received.contains($0) }) else { throw ObservationSubmissionError.corruptQueue }
            for entry in state.pending {
                try entry.envelope.validate()
                guard entry.attempts >= 0, entry.attempts <= 64 else { throw ObservationSubmissionError.corruptQueue }
            }
            return state
        } catch { throw ObservationSubmissionError.corruptQueue }
    }

    public func enqueue(_ envelope: ObservationEnvelope, endpoint: URL) throws {
        try envelope.validate()
        var pending = try entries()
        let hash = try envelope.hashHex()
        guard try !wasReceived(hash: hash, endpoint: endpoint) else { throw ObservationSubmissionError.alreadyReceived }
        if try pending.contains(where: { try $0.endpoint == endpoint && $0.envelope.hashHex() == hash }) { return }
        guard pending.count < 128 else { throw ObservationSubmissionError.queueFull }
        pending.append(Entry(endpoint: endpoint, envelope: envelope)); try save(pending)
    }

    @discardableResult public func drain(client: ObservationHTTPClient, now: Date = Date()) async throws -> Int {
        guard !draining else { return 0 }; draining = true; defer { draining = false }
        let snapshot = try entries()
        var received = 0
        for entry in snapshot where entry.endpoint == client.endpoint && !entry.rejected && entry.nextAttempt <= now {
            try Task.checkCancellation()
            let hash = try entry.envelope.hashHex()
            let receipt: ObservationReceipt
            do {
                receipt = try await client.send(entry.envelope)
            } catch {
                if error is CancellationError { throw error }
                var pending = try entries()
                if let i = try pending.firstIndex(where: { try $0.endpoint == entry.endpoint && $0.envelope.hashHex() == hash }) {
                    if case ObservationSubmissionError.http(let status) = error,
                       (400..<500).contains(status), ![408, 429].contains(status) { pending[i].rejected = true }
                    pending[i].attempts = min(64, pending[i].attempts + 1)
                    pending[i].nextAttempt = now.addingTimeInterval(min(3600, pow(2, Double(min(12, pending[i].attempts)))))
                    try save(pending)
                }
                // Apple assertions must reach the service serially; stop after any ambiguous failure.
                throw error
            }
            var pending = try entries()
            try pending.removeAll { try $0.endpoint == entry.endpoint && $0.envelope.hashHex() == hash }
            var state = try load(); state.pending = pending
            state.received.append(entry.endpoint.absoluteString + ":" + hash)
            state.received = Array(state.received.suffix(1024))
            if receipt.policy_validated { state.validated = (state.validated ?? []) + [entry.endpoint.absoluteString + ":" + hash] }
            state.validated = (state.validated ?? []).filter { state.received.contains($0) }
            try saveState(state); received += 1
        }
        return received
    }

    private func save(_ entries: [Entry]) throws {
        var state = try load(); state.pending = entries; try saveState(state)
    }

    private func saveState(_ state: State) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let bytes = try JSONEncoder().encode(state)
        #if os(iOS)
        try bytes.write(to: url, options: [.atomic, .completeFileProtection])
        var protected = url; var values = URLResourceValues(); values.isExcludedFromBackup = true
        try protected.setResourceValues(values)
        #else
        try bytes.write(to: url, options: [.atomic])
        #endif
    }
}
