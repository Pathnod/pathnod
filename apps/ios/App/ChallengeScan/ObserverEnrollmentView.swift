import PathnodObserverEnrollment
import SwiftUI

struct ObserverEnrollmentView: View {
    @State private var commitmentHex: String?
    @State private var errorMessage: String?

    var body: some View {
        List {
            Section("Before enrollment") {
                Text("Pathnod creates a private observer secret on this iPhone and keeps it in this device's Keychain.")
                Text("Only the public commitment below is intended for the enrollment service. The secret is never sent.")
                Button("Prepare enrollment preview") { prepare() }
                    .accessibilityIdentifier("prepareEnrollmentPreview")
            }

            if let commitmentHex {
                Section("Exactly what will be sent") {
                    LabeledContent("Field", value: "c_obs = Poseidon(s_obs)")
                    LabeledContent("Encoding", value: "32-byte big-endian BN254 field element")
                    Text("0x" + commitmentHex)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                        .accessibilityIdentifier("observerCommitment")
                    Text("Preview only. No enrollment request has been sent; DEV-26 will add that service.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if let errorMessage {
                Section("Credential unavailable") {
                    Text(errorMessage).foregroundStyle(.red)
                    Text("The existing credential has not been replaced. Try again after resolving the Keychain error.")
                        .font(.footnote)
                }
            }
        }
        .navigationTitle("Observer enrollment")
    }

    private func prepare() {
        do {
            commitmentHex = try ObserverCredentialManager().loadOrCreate().commitmentHex
            errorMessage = nil
        } catch {
            commitmentHex = nil
            errorMessage = "Could not prepare the observer credential (\(type(of: error)))."
        }
    }
}
