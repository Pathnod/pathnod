#if DEBUG
import CryptoKit
import Foundation
import PathnodAppAttest
import PathnodObservationCore
import PathnodObserverEnrollment
import SwiftUI

private final class FreshAttackCaptureCache: ObservationCache {
    func completed(for key: ObservationCacheKey) throws -> ObservationCapture? { nil }
    func save(_ capture: ObservationCapture, for key: ObservationCacheKey) throws { try capture.validate() }
}

@MainActor
struct AttackDemoView: View {
    @ObservedObject var controller: ChallengeBLEController
    @StateObject private var sensors = ObservationSensors()
    @StateObject private var demo = AttackDemoModel()
    @AppStorage("observerEnrollmentServerURL") private var serverURL = ""
    @State private var enabled = false
    @State private var collectionError: String?

    var body: some View {
        List {
            Section("Development demo only") {
                Text("Replay spends a devnet transaction fee. Latency simulation adds 600 ms to the reported RTT of fresh signed Bluetooth replies; it does not test a real relay.")
                Toggle("Enable attack tests on this device", isOn: $enabled)
                TextField("Service URL", text: $serverURL).textInputAutocapitalization(.never)
                    .autocorrectionDisabled().keyboardType(.URL).disabled(controller.isRunning || demo.busy)
                Button("Check demo availability") { Task { await demo.check(serverURL) } }
                    .disabled(demo.busy || serverURL.isEmpty)
                Text(demo.availability)
            }
            Section("Replay last finalized proof") {
                Text("This sends the original proof and verifier authorization in a new transaction. A reused HTTP receipt does not count as an on-chain rejection.")
                    .font(.footnote)
                Button("Re-submit last proof") { Task { await demo.replay(serverURL) } }
                    .disabled(!enabled || !demo.available || demo.busy || controller.isRunning)
                    .accessibilityIdentifier("replayLastProof")
                Button("Refresh replay confirmation") { Task { await demo.refreshReplay(serverURL) } }
                    .disabled(!demo.available || demo.busy || serverURL.isEmpty)
                Text(demo.replayMessage).accessibilityIdentifier("attackReplayStatus")
                if let replay = demo.replayStatus, replay.status == "rejected", replay.unchanged == true {
                    LabeledContent("Independent observers", value: String(replay.independent_observers ?? 0))
                    LabeledContent("Paid slots used", value: String(replay.paid_slots_used ?? 0))
                    if replay.network == "devnet", let signature = replay.transaction_signature,
                       let url = URL(string: "https://explorer.solana.com/tx/\(signature)?cluster=devnet") {
                        Link("View finalized rejected transaction", destination: url)
                    }
                }
            }
            Section("Simulated latency") {
                Text("Collect three new ESP32 replies, then sign and prove a test transcript with an added 600 ms per RTT. The normal observation cache and 400 ms acceptance limit are preserved.")
                    .font(.footnote)
                Button(controller.isRunning ? "Collecting…" : "Collect fresh challenges") { collect() }
                    .disabled(!enabled || !demo.available || demo.busy || controller.isRunning)
                Text(controller.status)
                if let error = collectionError ?? controller.errorMessage { Text(error).foregroundStyle(.red) }
                if let capture = controller.observationCapture, demo.isFresh(capture) {
                    LabeledContent("Verified signatures", value: String(capture.challenges.count))
                    let measured = capture.challenges.map(\.roundTripMilliseconds).sorted()[1]
                    LabeledContent("Measured BLE median RTT", value: "\(measured) ms")
                    LabeledContent("Added simulated delay", value: "600 ms")
                    LabeledContent("Submitted test median RTT", value: "\(UInt32(measured) + 600) ms")
                    Button("Submit latency test") { Task { await demo.latency(capture, serverURL: serverURL) } }
                        .disabled(!enabled || !demo.available || demo.busy || controller.isRunning)
                        .accessibilityIdentifier("submitLatencyAttack")
                }
                Text(demo.latencyMessage).accessibilityIdentifier("attackLatencyStatus")
            }
        }
        .navigationTitle("Attack rejection demo")
        .task { await demo.check(serverURL) }
        .onDisappear { if controller.isRunning { controller.cancel() } }
        .onChange(of: serverURL) { _ in demo.clear() }
    }

    private func collect() {
        do {
            let base = try demo.base(serverURL)
            collectionError = nil; demo.beginCapture()
            controller.startObservation(ObservationRequest(client: try EligibilityClient(baseURL: base),
                credential: try ObserverCredentialManager().loadOrCreate(), cache: FreshAttackCaptureCache(),
                sensors: sensors, useLocation: false, useMotion: false, allowUnpaid: true))
        } catch { collectionError = error.localizedDescription }
    }
}

private struct AttackReplayResponse: Decodable {
    let transcript_hash: String
    let status: String
    let network: String
    let transaction_signature: String?
    let error: String?
    let unchanged: Bool?
    let independent_observers: Int?
    let paid_slots_used: Int?
}
private struct AttackServerError: Decodable { let error: String }

@MainActor
private final class AttackDemoModel: ObservableObject {
    @Published var busy = false
    @Published var available = false
    @Published var availability = "Demo not checked."
    @Published var replayMessage = "No replay requested."
    @Published var replayStatus: AttackReplayResponse?
    @Published var latencyMessage = "No latency test sent."
    @Published var hasFreshCapture = false
    private var captureStartedAt: UInt64 = 0
    private var latencyEnvelope: ObservationEnvelope?
    private var latencyEndpoint: URL?
    private let attest = AppAttestClient(service: SystemAppAttestService(),
        store: KeychainAppAttestKeyStore(service: "xyz.pathnod.challengescan.appattest"))

    func base(_ raw: String) throws -> URL {
        guard let url = URL(string: raw), let host = url.host, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              url.scheme == "https" || (url.scheme == "http" && host.hasSuffix(".local"))
        else { throw ObservationSubmissionError.invalidEndpoint }
        return url
    }
    func clear() { available = false; replayStatus = nil; latencyEnvelope = nil; latencyEndpoint = nil; hasFreshCapture = false }
    func beginCapture() { latencyEnvelope = nil; latencyEndpoint = nil; latencyMessage = "Waiting for fresh physical replies."; hasFreshCapture = true; captureStartedAt = UInt64(Date().timeIntervalSince1970 * 1000) }
    func isFresh(_ capture: ObservationCapture) -> Bool { hasFreshCapture && capture.observationTimeMilliseconds >= captureStartedAt }

    func check(_ server: String) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            struct Availability: Decodable { let enabled: Bool; let network: String }
            let response: Availability = try await request(try base(server).appending(path: "demo/attacks"))
            available = response.enabled && response.network == "devnet"
            availability = available ? "Devnet attack demo enabled on the server." : "Attack demo is disabled on the server."
        } catch { available = false; availability = "Demo unavailable: \(error.localizedDescription)" }
    }
    private func hash(_ server: String) throws -> String {
        let endpoint = try base(server).appending(path: "observations")
        let bindings = UserDefaults.standard.dictionary(forKey: "observationChainBindingsV0") as? [String: [String: String]] ?? [:]
        guard let hash = bindings[endpoint.absoluteString]?["hash"], hash.count == 64,
              hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
        else { throw ObservationSubmissionError.invalidReceipt }
        return hash
    }
    func replay(_ server: String) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            let base = try base(server), hash = try hash(server)
            guard let key = try attest.currentKey(), key.attestationReturned else { throw AppAttestClientError.missingKey }
            struct Challenge: Decodable { let id: String; let challenge: String; let transcript_hash: String }
            let challenge: Challenge = try await request(base.appending(path: "demo/attacks/challenge"),
                body: ["transcript_hash": hash, "key_id": key.keyID])
            guard challenge.transcript_hash == hash, let bytes = Data(base64Encoded: challenge.challenge), bytes.count == 32
            else { throw ObservationSubmissionError.invalidReceipt }
            let assertion = try await attest.assert(clientDataHash: Data(SHA256.hash(data: bytes)))
            let response: AttackReplayResponse = try await request(base.appending(path: "demo/attacks/replay"), body: [
                "transcript_hash": hash, "key_id": assertion.keyID, "challenge_id": challenge.id,
                "assertion": assertion.object.base64EncodedString()])
            try show(response, expected: hash)
        } catch { replayMessage = "Replay not confirmed: \(error.localizedDescription)" }
    }
    func refreshReplay(_ server: String) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            let hash = try hash(server)
            let response: AttackReplayResponse = try await request(try base(server).appending(path: "demo/attacks/replay/\(hash)"))
            try show(response, expected: hash)
        } catch { replayMessage = "Replay not confirmed: \(error.localizedDescription)" }
    }
    private func show(_ response: AttackReplayResponse, expected: String) throws {
        guard response.transcript_hash == expected, response.network == "devnet" else { throw ObservationSubmissionError.invalidReceipt }
        replayStatus = response
        if response.status == "rejected", response.error == "E_NULLIFIER", response.unchanged == true,
           response.transaction_signature != nil {
            replayMessage = "Finalized on-chain rejection: E_NULLIFIER. Counters and rewards unchanged."
        } else if response.status == "needs_inspection" {
            replayMessage = "Replay outcome needs inspection. The saved transaction is preserved."
        } else { replayMessage = "Replay \(response.status). Refresh until finalized rejection is confirmed." }
    }
    func latency(_ capture: ObservationCapture, serverURL: String) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            guard isFresh(capture) else { throw ObservationSubmissionError.invalidEnvelope }
            let endpoint = try base(serverURL).appending(path: "observations")
            if latencyEnvelope == nil {
                latencyMessage = "Preparing the simulated-latency transcript, mobile proof and assertion…"
                let credential = try ObserverCredentialManager().loadOrCreate()
                let enrollment = try await ObserverEnrollmentClient(serverURL: serverURL).refreshPath(commitment: "0x" + credential.commitmentHex)
                let transcript = try ObservationLatencySimulation.transcript(capture: capture, credential: credential, enrollment: enrollment)
                let witness = try ObservationWitness(transcript: transcript, credential: credential, enrollment: enrollment)
                let zk = try await ObservationMoproProver().prove(witness)
                let assertion = try await ObservationAppAttester().assertion(for: transcript.transcriptHash())
                latencyEnvelope = try ObservationEnvelope(transcript: transcript.encode(), assertion: assertion.object, keyID: assertion.keyID, zk: zk)
                latencyEndpoint = endpoint
            }
            guard latencyEndpoint == endpoint, let envelope = latencyEnvelope else { throw ObservationSubmissionError.invalidEndpoint }
            var request = URLRequest(url: endpoint); request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONEncoder().encode(envelope); request.timeoutInterval = 15
            let (data, response) = try await URLSession.shared.data(for: request)
            guard data.count <= 4096, let http = response as? HTTPURLResponse else { throw ObservationSubmissionError.invalidReceipt }
            struct Rejection: Decodable { let error: String }
            let rejection = try? JSONDecoder().decode(Rejection.self, from: data)
            if http.statusCode == 422, rejection?.error == "E_RTT" {
                latencyMessage = "Verifier rejected simulated latency: E_RTT. No observation accepted or reward allocated."
            } else { latencyMessage = "Expected E_RTT; received HTTP \(http.statusCode): \(rejection?.error ?? "unexpected response")." }
        } catch { latencyMessage = "Latency test not confirmed: \(error.localizedDescription)" }
    }
    private func request<T: Decodable>(_ url: URL, body: [String: String]? = nil) async throws -> T {
        var request = URLRequest(url: url); request.timeoutInterval = 15
        if let body { request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "content-type"); request.httpBody = try JSONEncoder().encode(body) }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard data.count <= 4096, let http = response as? HTTPURLResponse else { throw ObservationSubmissionError.invalidReceipt }
        guard (200..<300).contains(http.statusCode) else {
            let code = (try? JSONDecoder().decode(AttackServerError.self, from: data).error) ?? "HTTP \(http.statusCode)"
            throw NSError(domain: "PathnodAttackDemo", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: code])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
#endif
