import CryptoKit
import Foundation
import PathnodAppAttest
import Security
import SwiftUI

private enum TrialError: Error {
    case randomGenerationFailed
    case duplicateChallenge
}

@MainActor
private final class TrialModel: ObservableObject {
    @Published var status = "Ready"
    @Published var keyDescription = "No key loaded"
    @Published var attestationDescription = "Not requested"
    @Published var assertionDescription = "Not requested"
    @Published var isRunning = false

    func run() async {
        isRunning = true
        status = "Running"
        defer { isRunning = false }

        do {
            let capture = try DeviceEvidenceCapture.isRequested ? DeviceEvidenceCapture.load() : nil
            let keychainService = capture?.keychainService
                ?? ProcessInfo.processInfo.environment["APP_ATTEST_KEYCHAIN_SERVICE"]
                ?? "xyz.pathnod.appattestspike"
            let client = AppAttestClient(
                service: SystemAppAttestService(),
                store: KeychainAppAttestKeyStore(service: keychainService)
            )
            guard client.isSupported else { throw AppAttestClientError.unsupported }
            var attestationObject: Data?
            if let record = try client.currentKey(), record.attestationReturned {
                guard capture == nil else { throw AppAttestClientError.alreadyAttested }
                keyDescription = "Reused key fingerprint \(fingerprint(record.keyID))"
                attestationDescription = "Returned on a previous run"
            } else {
                let hash = try capture.map { try $0.hash($0.attestationChallenge) } ?? freshChallengeHash()
                let attestation = try await client.attest(clientDataHash: hash)
                keyDescription = "\(attestation.reusedKey ? "Reused" : "New") key fingerprint \(fingerprint(attestation.keyID))"
                attestationDescription = "Returned \(attestation.object.count) bytes"
                attestationObject = attestation.object
            }

            let firstHash = try capture.map { try $0.hash($0.firstAssertionChallenge) } ?? freshChallengeHash()
            var secondHash = try capture.map { try $0.hash($0.secondAssertionChallenge) } ?? freshChallengeHash()
            if capture == nil {
                while secondHash == firstHash {
                    secondHash = try freshChallengeHash()
                }
            }
            guard secondHash != firstHash else { throw TrialError.duplicateChallenge }
            let first = try await client.assert(clientDataHash: firstHash)
            let second = try await client.assert(clientDataHash: secondHash)
            if let capture, let attestationObject {
                try capture.save(
                    keyID: first.keyID,
                    attestation: attestationObject,
                    firstAssertion: first.object,
                    secondAssertion: second.object
                )
            }
            assertionDescription = "Two distinct challenges: \(first.object.count) and \(second.object.count) bytes"
            status = "Succeeded"
        } catch {
            status = "Failed: \(error.localizedDescription)"
        }
    }

    private func freshChallengeHash() throws -> Data {
        var challenge = Data(count: 32)
        let status = challenge.withUnsafeMutableBytes { bytes in
            SecRandomCopyBytes(kSecRandomDefault, bytes.count, bytes.baseAddress!)
        }
        guard status == errSecSuccess else { throw TrialError.randomGenerationFailed }
        return Data(SHA256.hash(data: challenge))
    }

    private func fingerprint(_ keyID: String) -> String {
        SHA256.hash(data: Data(keyID.utf8)).prefix(4)
            .map { String(format: "%02x", $0) }.joined()
    }
}

struct AppAttestSpikeView: View {
    @StateObject private var model = TrialModel()

    var body: some View {
        NavigationStack {
            Form {
                Section("Development App Attest") {
                    Text("This harness requests real App Attest objects on a supported iPhone. Use the DEV-19 runbook for server validation.")
                    Button("Run App Attest trial") {
                        Task { await model.run() }
                    }
                    .disabled(model.isRunning)
                    .accessibilityIdentifier("runAppAttestTrial")
                }

                Section("Result") {
                    Text(model.status)
                        .accessibilityIdentifier("appAttestStatus")
                    Text(model.keyDescription)
                    Text(model.attestationDescription)
                    Text(model.assertionDescription)
                }
            }
            .navigationTitle("App Attest spike")
        }
        .task {
            if DeviceEvidenceCapture.isRequested {
                await model.run()
            }
        }
    }
}
