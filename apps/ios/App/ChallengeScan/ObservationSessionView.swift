import Foundation
import PathnodAppAttest
import PathnodObservationCore
import PathnodObserverEnrollment
import SwiftUI
import UIKit

@MainActor
struct ObservationSessionView: View {
    @ObservedObject var controller: ChallengeBLEController
    @StateObject private var sensors = ObservationSensors()
    @StateObject private var submission = ObservationSubmissionModel()
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("observationSubmissionPrivacyV0") private var submissionReviewed = false
    @AppStorage("observerEnrollmentServerURL") private var serverURL = ""
    @AppStorage("observationPrivacyPreviewV1") private var privacyReviewed = false
    @State private var includeLocation = false
    @State private var includeMotion = false
    @State private var allowUnpaid = false
    @State private var preparationError: String?

    var body: some View {
        List {
            Section("What is collected") {
                Text("The device identity and three signed replies, challenge timing, Bluetooth signal samples, and an observer identifier scoped to this protocol.")
                Text("Only the device ID and epoch are sent to check available slots. The completed session stays on this iPhone. Your private observer secret and precise GPS coordinates are never included.")
                    .font(.footnote).foregroundStyle(.secondary)
                Toggle("I have reviewed this information", isOn: $privacyReviewed)
                    .accessibilityIdentifier("observationPrivacyConsent")
                    .onChange(of: privacyReviewed) { if !$0 && controller.isRunning { controller.cancel() } }
            }
            Section("Optional signals") {
                Toggle("Include approximate location", isOn: $includeLocation)
                    .onChange(of: includeLocation) { if $0 { sensors.requestLocationPermission() } }
                Text("Location is reduced to a six-character geohash, with GPS accuracy. You can observe without it.")
                    .font(.footnote).foregroundStyle(.secondary)
                Toggle("Include motion and barometer", isOn: $includeMotion)
                    .onChange(of: includeMotion) { if $0 { sensors.requestMotionPermission() } }
                Toggle("Allow unpaid observations", isOn: $allowUnpaid)
                if sensors.permissionsPending { ProgressView("Waiting for sensor permission…") }
            }.disabled(controller.isRunning)
            Section("Observation service") {
                TextField("https://enrollment.example.org", text: $serverURL)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    .disabled(controller.isRunning)
                Text("The available reward is a quote. Collection does not reserve a paid slot or transfer funds.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section("Session") {
                Text(controller.status).accessibilityIdentifier("observationStatus")
                if let error = preparationError ?? controller.errorMessage { Text(error).foregroundStyle(.red) }
                if controller.isRunning {
                    Button("Stop observation", role: .destructive) { controller.cancel() }
                } else {
                    Button("Observe nearby device", action: start)
                        .accessibilityIdentifier("startObservation")
                        .disabled(!privacyReviewed || sensors.permissionsPending || serverURL.isEmpty)
                }
            }
            if let quote = controller.eligibilityQuote {
                Section("Eligibility") {
                    LabeledContent("Registered", value: quote.registered ? "Yes" : "No")
                    LabeledContent("Available paid slots", value: String(quote.openSlots))
                    LabeledContent("Quoted reward", value: quote.reward)
                    LabeledContent("Policy version", value: String(quote.policyVersion))
                }
            }
            if let device = controller.device {
                Section("Device") {
                    Text("0x" + device.deviceIDHex).font(.caption.monospaced()).textSelection(.enabled)
                        .accessibilityIdentifier("observationDeviceID")
                    DisclosureGroup("Public registration key") {
                        Text(device.publicKeyHex).font(.caption.monospaced()).textSelection(.enabled)
                    }
                }
            }
            if let capture = controller.observationCapture {
                Section(controller.restoredObservation ? "Saved session" : "Collected session") {
                    LabeledContent("Epoch", value: String(capture.epoch))
                    LabeledContent("Verified signatures", value: String(capture.challenges.count))
                    LabeledContent("Median RTT", value: "\(capture.challenges.map(\.roundTripMilliseconds).sorted()[1]) ms")
                    LabeledContent("Connection → collection", value: String(format: "%.3f s", capture.durationMilliseconds / 1000))
                    if let overall = controller.overallDurationMilliseconds {
                        LabeledContent("Preparation + discovery + collection", value: String(format: "%.3f s", overall / 1000))
                    }
                    LabeledContent("RSSI samples", value: String(capture.local.rssiSamples.count))
                    LabeledContent("Geohash", value: capture.local.geohash6.allSatisfy { $0 == 0 } ? "Not included" :
                        String(data: capture.local.geohash6, encoding: .ascii) ?? "Unavailable")
                    LabeledContent("GPS accuracy", value: capture.local.gpsAccuracyMeters == 0 ? "Not included" : "\(capture.local.gpsAccuracyMeters) m")
                    LabeledContent("Pressure", value: capture.local.barometerHPATimes10 == 0 ? "Not included" :
                        String(format: "%.1f hPa", Double(capture.local.barometerHPATimes10) / 10))
                    LabeledContent("Motion", value: ["Unknown", "Stationary", "Walking", "Vehicle"][Int(capture.local.motionClass)])
                    Text("Saved locally. This is not an on-chain observation or a payment receipt.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("Copy session summary") { UIPasteboard.general.string = controller.observationReport }
                }.accessibilityIdentifier("completedObservation")
                Section("Send to the verifier") {
                    Text("The verifier receives the signed device replies, timings, signal samples, optional approximate location, scoped pseudonym, nullifier, membership proof and your opaque App Attest key ID/assertion. Your observer secret and precise coordinates are not sent. Receipts report policy validation separately from on-chain confirmation and payment.")
                        .font(.footnote)
                    Toggle("I agree to send this observation", isOn: $submissionReviewed)
                        .onChange(of: submissionReviewed) { if !$0 { submission.cancelPreparation() } }
                    Button(submission.busy ? "Preparing…" : "Prove and queue observation") {
                        submission.prepare(capture: capture, serverURL: serverURL)
                    }.disabled(!submissionReviewed || submission.busy || controller.isRunning)
                        .accessibilityIdentifier("submitObservation")
                    Text(submission.status).accessibilityIdentifier("submissionStatus")
                }
            }
            Section("Submission queue") {
                Text("\(submission.pending) queued, \(submission.rejected) rejected. Pending envelopes are retried when this screen returns to the foreground; failed sends keep the original assertion. Rejected envelopes remain local for diagnosis.")
                    .font(.footnote)
                Text("Retry and preparation use the selected service only. Envelopes for previous services remain saved; restore their original URL to retry them. Changing the URL never transfers an envelope.")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("Retry due observations") { Task { await submission.retry(serverURL: serverURL) } }
                    .disabled(submission.busy || serverURL.isEmpty)
            }
        }
        .navigationTitle("Observe a device")
        .onDisappear { if controller.isRunning { controller.cancel() } }
        .task { await submission.retry(serverURL: serverURL) }
        .onChange(of: scenePhase) { if $0 == .active { Task { await submission.retry(serverURL: serverURL) } } }
    }

    private func start() {
        do {
            guard privacyReviewed, let url = URL(string: serverURL), let host = url.host else { throw ObservationError.invalidInput }
            #if DEBUG
            let local = url.scheme == "http" && (host.hasSuffix(".local") || host == "localhost")
            #else
            let local = false
            #endif
            guard url.scheme == "https" || local else { throw ObservationError.invalidInput }
            guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
                throw ObservationError.cacheUnavailable
            }
            let request = ObservationRequest(client: try EligibilityClient(baseURL: url),
                credential: try ObserverCredentialManager().loadOrCreate(),
                cache: FileObservationCache(url: support.appending(path: "Pathnod/observation-sessions-v1.json")),
                sensors: sensors, useLocation: includeLocation, useMotion: includeMotion, allowUnpaid: allowUnpaid)
            preparationError = nil; controller.startObservation(request)
        } catch { preparationError = error.localizedDescription }
    }
}

@MainActor
private struct ObservationAppAttester: ObservationAssertionProvider {
    let client = AppAttestClient(service: SystemAppAttestService(),
        store: KeychainAppAttestKeyStore(service: "xyz.pathnod.challengescan.appattest"))
    func assertion(for transcriptHash: Data) async throws -> (keyID: String, object: Data) {
        let result = try await client.assert(clientDataHash: transcriptHash)
        return (result.keyID, result.object)
    }
}

@MainActor
private struct ObservationMoproProver: ObservationProver {
    func prove(_ witness: ObservationWitness) async throws -> ObservationZK {
        #if PATHNOD_MOPRO
        guard let zkey = Bundle.main.path(forResource: "observation_final", ofType: "zkey") else {
            throw ObservationSubmissionError.proverUnavailable
        }
        let input = String(decoding: try JSONEncoder().encode(witness.inputs), as: UTF8.self)
        return try await Task.detached(priority: .userInitiated) {
            let result = try generateCircomProof(zkeyPath: zkey, circuitInputs: input, proofLib: .arkworks)
            guard result.inputs == witness.publicInputs,
                  try verifyCircomProof(zkeyPath: zkey, proofResult: result, proofLib: .arkworks),
                  result.proof.protocol == "groth16", ["bn128", "bn254"].contains(result.proof.curve) else {
                throw ObservationSubmissionError.proofMismatch
            }
            return ObservationZK(proof: ObservationGroth16Proof(
                a: [result.proof.a.x, result.proof.a.y, result.proof.a.z],
                b: [result.proof.b.x, result.proof.b.y, result.proof.b.z],
                c: [result.proof.c.x, result.proof.c.y, result.proof.c.z]), publicInputs: result.inputs)
        }.value
        #else
        throw ObservationSubmissionError.proverUnavailable
        #endif
    }
}

@MainActor
private final class ObservationSubmissionModel: ObservableObject {
    @Published var busy = false
    @Published var pending = 0
    @Published var rejected = 0
    @Published var status = "Not sent."
    private var queue: ObservationOutbox?
    private var preparationTask: Task<Void, Never>?

    private func outbox() throws -> ObservationOutbox {
        if let queue { return queue }
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw ObservationError.cacheUnavailable
        }
        let value = ObservationOutbox(url: support.appending(path: "Pathnod/observation-outbox-v0.json"))
        queue = value; return value
    }
    private func client(_ server: String) throws -> ObservationHTTPClient {
        guard let url = URL(string: server) else { throw ObservationSubmissionError.invalidEndpoint }
        #if DEBUG
        let local = true
        #else
        let local = false
        #endif
        return try ObservationHTTPClient(baseURL: url, allowLocalHTTP: local)
    }
    private func refresh() {
        do {
            let entries = try outbox().entries()
            pending = entries.filter { !$0.rejected }.count; rejected = entries.filter(\.rejected).count
        } catch { status = "Queue could not be read: \(error.localizedDescription)" }
    }
    func cancelPreparation() { preparationTask?.cancel() }
    func prepare(capture: ObservationCapture, serverURL: String) {
        guard !busy else { return }; busy = true
        preparationTask = Task { await prepareImpl(capture: capture, serverURL: serverURL) }
    }
    private func prepareImpl(capture: ObservationCapture, serverURL: String) async {
        defer { busy = false; preparationTask = nil; refresh() }
        do {
            #if !PATHNOD_MOPRO
            throw ObservationSubmissionError.proverUnavailable
            #else
            let http = try client(serverURL), queue = try outbox()
            if try queue.hasPending(endpoint: http.endpoint) {
                _ = try await queue.drain(client: http)
                guard try !queue.hasPending(endpoint: http.endpoint) else {
                    status = "Retry previous envelopes before creating another assertion."; return
                }
            }
            let credential = try ObserverCredentialManager().loadOrCreate()
            status = "Refreshing membership path…"
            let enrollment = try await ObserverEnrollmentClient(serverURL: serverURL).refreshPath(commitment: "0x" + credential.commitmentHex)
            let transcript = try ObservationTranscript(capture: capture, credential: credential, enrollment: enrollment)
            let hash = try transcript.transcriptHash().hexString
            if try queue.wasReceived(hash: hash, endpoint: http.endpoint) {
                status = try queue.wasValidated(hash: hash, endpoint: http.endpoint)
                    ? "This observation was already policy-validated. This receipt does not confirm on-chain submission or payment."
                    : "This observation was already received by the development sink. Not policy-validated or paid."
                return
            }
            status = "Proving and signing the original transcript…"
            let envelope = try await ObservationSubmission.prepare(capture: capture, credential: credential, enrollment: enrollment,
                prover: ObservationMoproProver(), attester: ObservationAppAttester())
            try Task.checkCancellation()
            try queue.enqueue(envelope, endpoint: http.endpoint)
            status = "Queued locally. Sending…"
            let received = try await queue.drain(client: http)
            if received > 0 {
                status = try queue.wasValidated(hash: hash, endpoint: http.endpoint)
                    ? "Policy-validated by the verifier. This receipt does not confirm on-chain submission or payment."
                    : "Received by development verifier. Not policy-validated or paid."
            } else { status = "Queued; waiting for retry." }
            #endif
        } catch ObservationSubmissionError.proverUnavailable {
            status = "Mopro is not bundled in this build. Use the DEV-32 Mopro build; no fake proof or assertion was sent."
        } catch { status = "Not confirmed received; session/envelope retained locally: \(error.localizedDescription)" }
    }
    func retry(serverURL: String) async {
        guard !busy else { return }; busy = true; defer { busy = false; refresh() }
        do {
            let queue = try outbox()
            guard try !queue.entries().isEmpty else { return }
            let count = try await queue.drain(client: client(serverURL))
            if count > 0 { status = "\(count) receipt(s) confirmed. Validation status is stored per observation; no on-chain submission or payment." }
        } catch { status = "Retry not confirmed; envelope retained locally: \(error.localizedDescription)" }
    }
}
