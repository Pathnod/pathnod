import CoreBluetooth
import PathnodChallengeCore
import SwiftUI
import Testing

@testable import PathnodChallengeScan

@MainActor
private final class CentralDouble: ChallengeCentral {
    var state: CBManagerState
    var scannedServices: [CBUUID]?
    var scanCount = 0
    var stopCount = 0

    init(state: CBManagerState) { self.state = state }

    func scanForPeripherals(withServices serviceUUIDs: [CBUUID]?, options: [String: Any]?) {
        scannedServices = serviceUUIDs
        scanCount += 1
    }

    func stopScan() { stopCount += 1 }
    func connect(_ peripheral: CBPeripheral, options: [String: Any]?) {}
    func cancelPeripheralConnection(_ peripheral: CBPeripheral) {}
}

@Suite("S1 app radio lifecycle")
@MainActor
struct ChallengeScanAppTests {
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
}
