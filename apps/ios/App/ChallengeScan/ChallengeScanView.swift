import PathnodChallengeCore
import SwiftUI
import UIKit

struct ChallengeScanView: View {
    @ObservedObject var controller: ChallengeBLEController

    var body: some View {
        NavigationStack {
            List {
                Section("Observation") {
                    NavigationLink("Observe a device") { ObservationSessionView(controller: controller) }
                    Text("Check eligibility, verify three signed replies, and collect a local session with your chosen signals.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Observer enrollment") {
                    NavigationLink("Enroll observer") {
                        ObserverEnrollmentView()
                    }
                    Text("Create a private observer secret, review its public commitment, and request a Merkle path from the enrollment service.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("S1 development test") {
                    Text("Connect to a Pathnod development device (ESP32 firmware or macOS simulator) and verify three signed Bluetooth challenges on this iPhone.")
                    Text("Keep this app open during the test. Challenges are spaced by more than two seconds to respect the device rate limit; that wait is not part of the RTT. This is a protocol and timing check, not proof of physical presence or distance.")
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

                if let device = controller.device {
                    Section("Device") {
                        LabeledContent("Device ID prefix", value: device.deviceIDPrefix)
                            .font(.footnote.monospaced())
                        LabeledContent("Advertised ID", value: device.advertisedIdentity == .matched
                            ? "matches INFO" : "not advertised")
                        LabeledContent("Capabilities", value: device.capabilitiesHex)
                            .font(.footnote.monospaced())
                        if !device.capabilityNames.isEmpty {
                            Text(device.capabilityNames.joined(separator: ", "))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let hint = device.protocolHint {
                            VStack(alignment: .leading) {
                                Text("Protocol hint")
                                Text(hint)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        } else {
                            LabeledContent("Protocol hint", value: "zero")
                        }
                        LabeledContent("ATT MTU", value: "\(device.maximumWriteLength + 3)")
                    }
                }

                if !controller.results.isEmpty {
                    Section("Verified responses") {
                        ForEach(controller.results, id: \.attempt) { result in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text("Challenge \(result.attempt)")
                                    Text("counter \(result.deviceCounter)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
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
                        if controller.results.count == 3 {
                            Button("Copy results") { UIPasteboard.general.string = controller.report }
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
