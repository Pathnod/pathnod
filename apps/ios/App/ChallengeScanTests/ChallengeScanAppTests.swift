import CoreBluetooth
import CryptoKit
import Foundation
import PathnodChallengeCore
import PathnodObservationCore
import PathnodObserverEnrollment
import SwiftUI
import Testing

@testable import PathnodChallengeScan

@MainActor
private final class CentralDouble: ChallengeCentral {
    var state: CBManagerState
    var scannedServices: [CBUUID]?
    var scanOptions: [String: Any]?
    var scanCount = 0
    var stopCount = 0

    init(state: CBManagerState) { self.state = state }

    func scanForPeripherals(withServices serviceUUIDs: [CBUUID]?, options: [String: Any]?) {
        scannedServices = serviceUUIDs
        scanOptions = options
        scanCount += 1
    }

    func stopScan() { stopCount += 1 }
    func connect(_ peripheral: CBPeripheral, options: [String: Any]?) {}
    func cancelPeripheralConnection(_ peripheral: CBPeripheral) {}
}

private struct SecretDouble: ObserverSecretStore {
    func load() throws -> Data? { Data(repeating: 7, count: 31) }
    func insertIfAbsent(_ secret: Data) throws -> Bool { false }
}

@Suite("S1 app radio lifecycle")
@MainActor
struct ChallengeScanAppTests {
    @Test("A cancelled service preparation cannot start a later scan")
    func cancelledObservationPreparation() async throws {
        let central = CentralDouble(state: .poweredOn)
        let controller = ChallengeBLEController(makeCentral: { _ in central })
        let client = try EligibilityClient(baseURL: URL(string: "https://example.org")!, transport: { request in
            try? await Task.sleep(for: .milliseconds(100))
            return (Data("{}".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        let cache = FileObservationCache(url: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
        controller.startObservation(ObservationRequest(client: client, credential: try ObserverCredentialManager(store: SecretDouble()).loadOrCreate(),
            cache: cache, sensors: ObservationSensors(), useLocation: false, useMotion: false, allowUnpaid: false))
        controller.cancel()
        try await Task.sleep(for: .milliseconds(200))
        #expect(!controller.isRunning); #expect(central.scanCount == 0)
        #expect(controller.observationCapture == nil)
    }

    @Test("DEV-30 physical observation", .enabled(if: ProcessInfo.processInfo.environment["PATHNOD_DEV30_HARDWARE"] == "1"))
    func physicalObservation() async throws {
        let environment = ProcessInfo.processInfo.environment
        let server = try #require(environment["PATHNOD_DEV30_SERVER_URL"])
        let url = try #require(URL(string: server))
        let support = try #require(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
        let cacheURL = support.appending(path: "Pathnod/dev30-hardware-sessions.json")
        if environment["PATHNOD_DEV30_CLEAR_CACHE"] == "1", FileManager.default.fileExists(atPath: cacheURL.path) {
            try FileManager.default.removeItem(at: cacheURL)
        }
        let request = ObservationRequest(client: try EligibilityClient(baseURL: url), credential: try ObserverCredentialManager().loadOrCreate(),
            cache: FileObservationCache(url: cacheURL), sensors: ObservationSensors(), useLocation: false, useMotion: false, allowUnpaid: true)
        let controller = ChallengeBLEController()
        controller.startObservation(request)
        let deadline = ProcessInfo.processInfo.systemUptime + 40
        while controller.isRunning, ProcessInfo.processInfo.systemUptime < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        #expect(!controller.isRunning)
        if let device = controller.device {
            print("DEV30_PUBLIC_INFO key=\(device.publicKeyHex) device=\(device.deviceIDHex) capabilities=\(device.capabilitiesHex)")
        }
        if environment["PATHNOD_DEV30_PROBE"] == "1" {
            #expect(controller.eligibilityQuote?.registered == false)
            #expect(controller.results.isEmpty)
            #expect(controller.observationCapture == nil)
            print("DEV30_PROBE eligibility blocked challenge writes: \(controller.status)")
        } else {
            let capture = try #require(controller.observationCapture, Comment(rawValue: controller.errorMessage ?? controller.status))
            #expect(capture.challenges.count == 3)
            #expect((5...20).contains(capture.local.rssiSamples.count))
            #expect(capture.local.geohash6.allSatisfy { $0 == 0 })
            #expect(capture.challenges.map(\.roundTripMilliseconds).sorted()[1] <= 400)
            #expect(controller.restoredObservation == (environment["PATHNOD_DEV30_EXPECT_CACHED"] == "1"))
            if controller.restoredObservation { #expect(controller.results.isEmpty) }
            else { #expect(capture.durationMilliseconds > 0) }
            print("DEV30_REPORT\n\(controller.observationReport)")
        }
        controller.cancel()
    }

    @Test("Start scans for only the provisional Pathnod service and Stop cancels it")
    func filteredScanAndStop() {
        let central = CentralDouble(state: .poweredOn)
        var creations = 0
        let controller = ChallengeBLEController(makeCentral: { _ in
            creations += 1
            return central
        })
        #expect(creations == 0)

        controller.start()
        controller.start()
        #expect(creations == 1)
        #expect(central.scanCount == 1)
        #expect(central.scannedServices == [CBUUID(string: DeviceProtocolV0.serviceUUID)])
        // The ESP32 sends its device ID prefix in a scan response reported separately.
        #expect(central.scanOptions?[CBCentralManagerScanOptionAllowDuplicatesKey] as? Bool == true)
        // Wait for at least two further 1 Hz advertising events before giving up on it.
        #expect(ChallengeBLEController.serviceDataGraceSeconds >= 2.5)
        #expect(controller.isRunning)

        controller.cancel()
        #expect(!controller.isRunning)
        #expect(central.stopCount >= 1)
        #expect(controller.results.isEmpty)
    }

    @Test("Leaving the foreground interrupts a requested scan")
    func foregroundInterruption() {
        let central = CentralDouble(state: .poweredOn)
        let controller = ChallengeBLEController(makeCentral: { _ in central })
        controller.start()
        controller.handleScenePhase(.background)
        #expect(!controller.isRunning)
        #expect(controller.status.contains("Interrupted"))
        #expect(central.stopCount >= 1)
    }

    @Test("The first Bluetooth permission alert pauses Start until the scene is active")
    func permissionPromptInterruption() {
        let central = CentralDouble(state: .unknown)
        let controller = ChallengeBLEController(makeCentral: { _ in central })
        controller.start()
        controller.handleScenePhase(.inactive)
        central.state = .poweredOn
        controller.handleRadioState(.poweredOn)
        #expect(controller.isRunning)
        #expect(central.scanCount == 0)

        controller.handleScenePhase(.active)
        #expect(central.scanCount == 1)
        #expect(controller.isRunning)
        controller.cancel()
    }

    @Test("Unavailable radio is reported and a later Start can retry")
    func unavailableRadio() {
        let central = CentralDouble(state: .poweredOff)
        let controller = ChallengeBLEController(makeCentral: { _ in central })
        controller.start()
        #expect(!controller.isRunning)
        #expect(controller.errorMessage?.contains("Bluetooth is off") == true)
        #expect(central.scanCount == 0)

        central.state = .poweredOn
        controller.start()
        #expect(controller.isRunning)
        #expect(central.scanCount == 1)
        controller.cancel()
    }

    @Test("The app declares foreground Bluetooth access")
    func permissionAndBackgroundConfiguration() {
        let usage = Bundle.main.object(forInfoDictionaryKey: "NSBluetoothAlwaysUsageDescription") as? String
        #expect(usage?.contains("three signed challenges") == true)
        #expect(Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") == nil)
    }

    @Test("The device summary decodes capabilities, a non-zero hint and the ID prefix")
    func deviceSummary() throws {
        func info(capabilities: UInt8, hint: Data) throws -> DeviceProtocolV0.Info {
            var wire = Data([0, 1])
            wire.append(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation)
            wire.append(contentsOf: [0, 0, 0, capabilities])
            wire.append(hint)
            return try DeviceProtocolV0.Info(wireData: wire)
        }
        let plain = try info(capabilities: 0x0a, hint: Data(repeating: 0, count: 32))
        let summary = DeviceSummary(info: plain, advertisedIdentity: .matched, maximumWriteLength: 182)
        #expect(summary.capabilitiesHex == "0x0000000a")
        #expect(summary.capabilityNames == ["monotonic counter", "challenge rate limit"])
        #expect(summary.protocolHint == nil)
        #expect(summary.deviceIDPrefix == plain.deviceID.prefix(8).hexString)
        #expect(summary.deviceIDPrefix.count == 16)

        let emulated = try info(capabilities: 0x2a, hint: Data(0..<32))
        let helium = DeviceSummary(info: emulated, advertisedIdentity: .notAdvertised, maximumWriteLength: 20)
        #expect(helium.capabilityNames.last == "external identity")
        #expect(helium.protocolHint == Data(0..<32).hexString)
    }
}
