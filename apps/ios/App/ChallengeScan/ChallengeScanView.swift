import PathnodChallengeCore
import SwiftUI

struct ChallengeScanView: View {
    @ObservedObject var controller: ChallengeBLEController

    var body: some View {
        NavigationStack {
            List {
                Section("S1 development test") {
                    Text("Connect to the Pathnod macOS simulator and verify three signed Bluetooth challenges on this iPhone.")
                    Text("Keep this app open during the test. This is a protocol and timing check, not proof of physical presence or distance.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Session") {
                    Text(controller.status)
                    if let error = controller.errorMessage {
                        Text(error).foregroundStyle(.red)
                    }
                    if controller.isRunning {
                        Button("Stop test", role: .destructive) { controller.cancel() }
                    } else {
                        Button("Start three challenges") { controller.start() }
                    }
                }

                if !controller.results.isEmpty {
                    Section("Verified responses") {
                        ForEach(controller.results, id: \.attempt) { result in
                            HStack {
                                Text("Challenge \(result.attempt)")
                                Spacer()
                                VStack(alignment: .trailing) {
                                    Text(String(format: "%.1f ms", result.roundTripMilliseconds))
                                    Text(result.transport == .notification ? "notification" : "read fallback")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        if let median = controller.medianNotificationRTTMilliseconds {
                            LabeledContent("Notification RTT median", value: String(format: "%.1f ms", median))
                        } else if controller.results.count == 3 {
                            Text("No comparable notification median: at least one response needed a read fallback.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section("Test values") {
                    Text("Each challenge uses a fresh random nonce. The observation epoch and hint are zero for this development test; production values belong to the later observation flow.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Pathnod S1")
        }
    }
}
