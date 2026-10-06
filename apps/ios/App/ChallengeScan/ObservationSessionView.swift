import Foundation
import PathnodObservationCore
import PathnodObserverEnrollment
import SwiftUI
import UIKit

@MainActor
struct ObservationSessionView: View {
    @ObservedObject var controller: ChallengeBLEController
    @StateObject private var sensors = ObservationSensors()
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
            }
        }
        .navigationTitle("Observe a device")
        .onDisappear { if controller.isRunning { controller.cancel() } }
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
