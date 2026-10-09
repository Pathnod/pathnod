import PathnodObserverEnrollment
import PathnodAppAttest
import SwiftUI

struct ObserverEnrollmentView: View {
    @AppStorage("observerEnrollmentServerURL") private var serverURL = ""
    @State private var commitmentHex: String?
    @State private var errorMessage: String?
    @State private var path: ObserverMerklePath?
    @State private var isWorking = false
    @State private var canResetAttestation = false

    var body: some View {
        List {
            Section("Before enrollment") {
                Text("Pathnod creates a private observer secret on this device and keeps it in this device's Keychain.")
                Text("Enrollment sends the public commitment and Apple's attestation. The secret is never sent.")
                Button("Prepare observer commitment") { prepare() }
                    .accessibilityIdentifier("prepareEnrollmentPreview")
            }

            if let commitmentHex {
                Section("Public commitment") {
                    LabeledContent("Field", value: "c_obs = Poseidon(s_obs)")
                    LabeledContent("Encoding", value: "32-byte big-endian BN254 field element")
                    Text("0x" + commitmentHex)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                        .accessibilityIdentifier("observerCommitment")
                    Text("The private observer secret stays in this device's Keychain.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Enrollment service") {
                    TextField("https://enrollment.example.org", text: $serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .disabled(isWorking)
                    Text("Use HTTPS for a hosted service. Local .local HTTP is available in development builds only.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button("Enroll this device") { Task { await enroll(commitmentHex) } }
                        .disabled(isWorking || serverURL.isEmpty)
                    if path != nil {
                        Button("Refresh Merkle path") { Task { await refresh(commitmentHex) } }
                            .disabled(isWorking)
                    }
                    if isWorking { ProgressView() }
                }
            }

            if let path {
                Section("Enrollment response") {
                    LabeledContent("Observer class", value: "\(path.observerClass)")
                    LabeledContent("Leaf index", value: "\(path.leafIndex)")
                    LabeledContent("Root revision", value: "\(path.rootRevision)")
                    LabeledContent("Merkle path", value: "\(path.siblings.count) siblings")
                    Text(path.root).font(.footnote.monospaced()).textSelection(.enabled)
                        .accessibilityIdentifier("observerMerkleRoot")
                }
            }

            if let errorMessage {
                Section("Enrollment error") {
                    Text(errorMessage).foregroundStyle(.red)
                    if canResetAttestation {
                        Button("Reset failed App Attest key") { resetAppAttestKey() }
                        Text("The observer secret and commitment stay unchanged. A new Apple attestation key will be created on the next attempt.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Observer enrollment")
        .onChange(of: serverURL) { _ in
            path = nil
            canResetAttestation = false
        }
    }

    private func prepare() {
        do {
            commitmentHex = try ObserverCredentialManager().loadOrCreate().commitmentHex
            errorMessage = nil
            canResetAttestation = false
        } catch {
            commitmentHex = nil
            errorMessage = "Could not prepare the observer credential (\(type(of: error)))."
        }
    }

    private func enroll(_ hex: String) async {
        isWorking = true
        canResetAttestation = false
        defer { isWorking = false }
        do {
            path = try await ObserverEnrollmentClient(serverURL: serverURL)
                .enroll(commitment: "0x" + hex)
            errorMessage = nil
            canResetAttestation = false
        } catch {
            errorMessage = error is AppAttestClientError ? String(describing: error) : error.localizedDescription
            if case ObserverEnrollmentClientError.initialAttestationRejected = error {
                canResetAttestation = true
            } else if let appAttestError = error as? AppAttestClientError {
                canResetAttestation = appAttestError == .alreadyAttested ||
                    appAttestError == .retryRequiresSameClientDataHash
            }
        }
    }

    private func refresh(_ hex: String) async {
        isWorking = true
        defer { isWorking = false }
        do {
            path = try await ObserverEnrollmentClient(serverURL: serverURL)
                .refreshPath(commitment: "0x" + hex)
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    private func resetAppAttestKey() {
        do {
            try KeychainAppAttestKeyStore(service: "xyz.pathnod.challengescan.appattest").clear()
            canResetAttestation = false
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }
}
