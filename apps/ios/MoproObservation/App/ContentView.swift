import Darwin
import SwiftUI

private struct ProofRun {
    let seconds: Double
    let peakResidentBytes: UInt64
    let publicInputs: [String]
    let verified: Bool
}

struct ContentView: View {
    @State private var running = false
    @State private var status = "Ready to prove the DEV-13 synthetic observation."
    @State private var run: ProofRun?

    var body: some View {
        NavigationStack {
            Form {
                Section("Observation proof") {
                    Button(running ? "Proving…" : "Generate and verify proof") {
                        Task { await prove() }
                    }
                    .disabled(running)
                    .accessibilityIdentifier("proveObservation")
                    Text(status)
                        .accessibilityIdentifier("proofStatus")
                }

                if let run {
                    Section("On-device result") {
                        LabeledContent("Proof time") {
                            Text(String(format: "%.3f s", run.seconds))
                                .accessibilityIdentifier("proofSeconds")
                        }
                        LabeledContent("Peak resident memory") {
                            Text(String(format: "%.1f MB", Double(run.peakResidentBytes) / 1_000_000))
                                .accessibilityIdentifier("peakMemoryMB")
                        }
                        LabeledContent("Verification", value: run.verified ? "Valid" : "Invalid")
                        LabeledContent("Public inputs", value: "\(run.publicInputs.count) matched")
                    }
                }
            }
            .navigationTitle("Pathnod Observation")
        }
    }

    @MainActor
    private func prove() async {
        running = true
        run = nil
        status = "Generating proof on this device…"
        defer { running = false }

        do {
            let zkey = try resourcePath("observation_final", "zkey")
            let input = try String(contentsOfFile: resourcePath("mopro-input", "json"), encoding: .utf8)
            let expected = try JSONDecoder().decode(
                [String].self,
                from: Data(contentsOf: URL(fileURLWithPath: resourcePath("public", "json")))
            )

            let result = try await Task.detached(priority: .userInitiated) {
                let start = ProcessInfo.processInfo.systemUptime
                let proof = try generateCircomProof(
                    zkeyPath: zkey,
                    circuitInputs: input,
                    proofLib: .arkworks
                )
                let seconds = ProcessInfo.processInfo.systemUptime - start
                let verified = try verifyCircomProof(
                    zkeyPath: zkey,
                    proofResult: proof,
                    proofLib: .arkworks
                )
                return ProofRun(
                    seconds: seconds,
                    peakResidentBytes: Self.peakResidentMemory(),
                    publicInputs: proof.inputs,
                    verified: verified && !proof.proof.a.x.isEmpty
                )
            }.value

            guard result.publicInputs == expected else {
                status = "Proof public inputs do not match the DEV-13 reference."
                return
            }
            guard result.verified else {
                status = "Mopro rejected the proof."
                return
            }
            run = result
            status = "Proof generated and verified."
        } catch {
            status = "Proof failed: \(error.localizedDescription)"
        }
    }

    private func resourcePath(_ name: String, _ extensionName: String) throws -> String {
        guard let path = Bundle.main.path(forResource: name, ofType: extensionName) else {
            throw CocoaError(.fileNoSuchFile)
        }
        return path
    }

    nonisolated private static func peakResidentMemory() -> UInt64 {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(
            MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size
        )
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? UInt64(info.resident_size_max) : 0
    }
}
