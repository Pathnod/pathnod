import CoreBluetooth
import Foundation
import PathnodChallengeCore
import Security
import SwiftUI

@MainActor
protocol ChallengeCentral: AnyObject {
    var state: CBManagerState { get }
    func scanForPeripherals(withServices serviceUUIDs: [CBUUID]?, options: [String: Any]?)
    func stopScan()
    func connect(_ peripheral: CBPeripheral, options: [String: Any]?)
    func cancelPeripheralConnection(_ peripheral: CBPeripheral)
}

extension CBCentralManager: ChallengeCentral {}

@MainActor
final class ChallengeBLEController: NSObject, ObservableObject,
    @preconcurrency CBCentralManagerDelegate, @preconcurrency CBPeripheralDelegate {
    @Published private(set) var status = "Ready to scan for the Pathnod simulator."
    @Published private(set) var results: [ChallengeResult] = []
    @Published private(set) var medianNotificationRTTMilliseconds: Double?
    @Published private(set) var errorMessage: String?
    @Published private(set) var isRunning = false

    private enum Stage {
        case idle, waitingForRadio, scanning, connecting, services, characteristics
        case info, subscribing, challenge, readFallback, finished, failed, interrupted
    }

    private let serviceUUID = CBUUID(string: DeviceProtocolV0.serviceUUID)
    private let infoUUID = CBUUID(string: DeviceProtocolV0.infoUUID)
    private let challengeUUID = CBUUID(string: DeviceProtocolV0.challengeUUID)
    private let responseUUID = CBUUID(string: DeviceProtocolV0.responseUUID)
    private var stage: Stage = .idle
    typealias CentralFactory = (CBCentralManagerDelegate) -> ChallengeCentral
    private let makeCentral: CentralFactory
    private var central: ChallengeCentral?
    private var peripheral: CBPeripheral?
    private var infoCharacteristic: CBCharacteristic?
    private var challengeCharacteristic: CBCharacteristic?
    private var responseCharacteristic: CBCharacteristic?
    private var session: ChallengeSession?
    private var timeout: Timer?
    private var isSceneActive = true

    init(makeCentral: @escaping CentralFactory = {
        CBCentralManager(delegate: $0, queue: .main)
    }) {
        self.makeCentral = makeCentral
        super.init()
    }

    func start() {
        guard !isRunning, isSceneActive else { return }
        stopConnection()
        results = []
        medianNotificationRTTMilliseconds = nil
        errorMessage = nil
        session = nil
        isRunning = true
        stage = .waitingForRadio
        status = "Checking Bluetooth…"
        setTimeout(10)
        if central == nil {
            central = makeCentral(self)
            if let central, central.state != .unknown {
                handleRadioState(central.state)
            }
        } else if let central {
            handleRadioState(central.state)
        }
    }

    func cancel() {
        guard isRunning else { return }
        session?.interrupt()
        stage = .interrupted
        isRunning = false
        status = "Stopped. Start again for three fresh challenges."
        stopConnection()
        session = nil
    }

    func handleScenePhase(_ phase: ScenePhase) {
        isSceneActive = phase == .active
        if phase == .active, isRunning, stage == .waitingForRadio {
            setTimeout(10)
            if let central { handleRadioState(central.state) }
        } else if phase == .inactive, isRunning, stage == .waitingForRadio {
            // The first Bluetooth permission alert can make the scene inactive.
            timeout?.invalidate()
            timeout = nil
        } else if phase != .active && isRunning {
            cancel()
            status = "Interrupted when the app left the foreground."
        }
    }

    func handleRadioState(_ state: CBManagerState) {
        guard isRunning else { return }
        switch state {
        case .poweredOn:
            guard stage == .waitingForRadio, isSceneActive else { return }
            stage = .scanning
            status = "Scanning for the provisional Pathnod service…"
            central?.scanForPeripherals(withServices: [serviceUUID], options: nil)
            setTimeout(15)
        case .unknown, .resetting:
            if stage != .waitingForRadio {
                fail("Bluetooth became unavailable during the exchange.")
            }
        case .poweredOff:
            fail("Bluetooth is off. Turn it on and try again.")
        case .unauthorized:
            fail("Bluetooth access was denied. Allow it in Settings and try again.")
        case .unsupported:
            fail("This device does not support Bluetooth Low Energy.")
        @unknown default:
            fail("Bluetooth entered an unsupported state.")
        }
    }

    private func setTimeout(_ seconds: TimeInterval) {
        timeout?.invalidate()
        let expected = stage
        timeout = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.isRunning, self.stage == expected else { return }
                if expected == .challenge || expected == .readFallback {
                    _ = try? self.session?.expirePending(
                        at: ProcessInfo.processInfo.systemUptime, after: seconds
                    )
                }
                self.fail("The Bluetooth exchange timed out. Try again with the simulator nearby.")
            }
        }
    }

    private func stopConnection() {
        timeout?.invalidate()
        timeout = nil
        central?.stopScan()
        if let peripheral, peripheral.state != .disconnected {
            central?.cancelPeripheralConnection(peripheral)
        }
        peripheral?.delegate = nil
        peripheral = nil
        infoCharacteristic = nil
        challengeCharacteristic = nil
        responseCharacteristic = nil
    }

    private func fail(_ message: String) {
        guard isRunning else { return }
        session?.interrupt()
        stage = .failed
        isRunning = false
        errorMessage = message
        status = "Challenge session failed."
        stopConnection()
        session = nil
    }

    private func finish() {
        stage = .finished
        isRunning = false
        status = "Three signatures verified on this iPhone."
        medianNotificationRTTMilliseconds = session?.medianNotificationRTTMilliseconds
        stopConnection()
        session = nil
    }

    private func randomNonce() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw NSError(domain: "PathnodChallengeScan", code: 1)
        }
        return Data(bytes)
    }

    private func sendNextChallenge() {
        guard let peripheral, let characteristic = challengeCharacteristic,
              var session, session.results.count < 3 else {
            fail("The challenge session is incomplete.")
            return
        }
        do {
            let nonce = try randomNonce()
            stage = .challenge
            status = "Challenge \(session.results.count + 1) of 3…"
            setTimeout(15)
            // DEV-10 has no production observation epoch or hint yet.
            let wire = try session.beginChallenge(
                nonce: nonce, observationEpoch: 0,
                observationHint: Data(repeating: 0, count: 8),
                startedAt: ProcessInfo.processInfo.systemUptime
            )
            self.session = session
            peripheral.writeValue(wire, for: characteristic, type: .withResponse)
        } catch {
            fail("Could not create a fresh challenge.")
        }
    }

    private func handleResponse(_ data: Data, from peripheral: CBPeripheral) {
        guard stage == .challenge || stage == .readFallback else { return }
        if data.count < DeviceProtocolV0.responseHeaderLength {
            if stage == .challenge, let responseCharacteristic {
                stage = .readFallback
                status = "Notification was too short; reading the full response…"
                setTimeout(10)
                peripheral.readValue(for: responseCharacteristic)
            } else {
                fail("The response is still incomplete after a read.")
            }
            return
        }
        guard var session else {
            fail("The response arrived without an active challenge.")
            return
        }
        do {
            let transport: ResponseTransport = stage == .readFallback ? .readFallback : .notification
            let receipt = try session.receive(
                data, at: ProcessInfo.processInfo.systemUptime, via: transport
            )
            self.session = session
            switch receipt {
            case .ignoredDuplicate:
                return
            case let .verified(result):
                results.append(result)
                if session.isComplete { finish() } else { sendNextChallenge() }
            }
        } catch {
            fail("The response did not verify for the current challenge (\(error)).")
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        handleRadioState(central.state)
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard stage == .scanning else { return }
        central.stopScan()
        self.peripheral = peripheral
        peripheral.delegate = self
        stage = .connecting
        status = "Connecting to the simulator…"
        setTimeout(10)
        central.connect(peripheral, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard stage == .connecting, self.peripheral === peripheral else { return }
        stage = .services
        status = "Discovering the Pathnod service…"
        setTimeout(10)
        peripheral.discoverServices([serviceUUID])
    }

    func centralManager(
        _ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?
    ) {
        if stage == .connecting, self.peripheral === peripheral {
            fail("Could not connect to the simulator.")
        }
    }

    func centralManager(
        _ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        if isRunning, self.peripheral === peripheral {
            fail("The simulator disconnected before all three challenges were verified.")
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard stage == .services, self.peripheral === peripheral else { return }
        guard error == nil,
              let service = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else {
            fail("The provisional Pathnod service was not found.")
            return
        }
        stage = .characteristics
        status = "Discovering GATT characteristics…"
        setTimeout(10)
        peripheral.discoverCharacteristics([infoUUID, challengeUUID, responseUUID], for: service)
    }

    func peripheral(
        _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?
    ) {
        guard stage == .characteristics, self.peripheral === peripheral else { return }
        guard error == nil, let characteristics = service.characteristics else {
            fail("Could not discover the required GATT characteristics.")
            return
        }
        infoCharacteristic = characteristics.first(where: { $0.uuid == infoUUID })
        challengeCharacteristic = characteristics.first(where: { $0.uuid == challengeUUID })
        responseCharacteristic = characteristics.first(where: { $0.uuid == responseUUID })
        guard let infoCharacteristic, let challengeCharacteristic, let responseCharacteristic,
              infoCharacteristic.properties.contains(.read),
              challengeCharacteristic.properties.contains(.write),
              responseCharacteristic.properties.contains(.read),
              responseCharacteristic.properties.contains(.notify) else {
            fail("The simulator is missing a required read, write or notify characteristic.")
            return
        }
        stage = .info
        status = "Reading the simulator's public key…"
        setTimeout(10)
        peripheral.readValue(for: infoCharacteristic)
    }

    func peripheral(
        _ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard self.peripheral === peripheral else { return }
        guard error == nil, let data = characteristic.value else {
            fail("The GATT read or notification failed.")
            return
        }
        if characteristic.uuid == infoUUID, stage == .info {
            do {
                session = ChallengeSession(info: try DeviceProtocolV0.Info(wireData: data))
                guard let responseCharacteristic else {
                    fail("The response characteristic disappeared.")
                    return
                }
                stage = .subscribing
                status = "Subscribing to signed responses…"
                setTimeout(10)
                peripheral.setNotifyValue(true, for: responseCharacteristic)
            } catch {
                fail("The simulator returned invalid or unsupported INFO data.")
            }
        } else if characteristic.uuid == responseUUID {
            handleResponse(data, from: peripheral)
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard stage == .subscribing, self.peripheral === peripheral,
              characteristic.uuid == responseUUID else { return }
        guard error == nil, characteristic.isNotifying else {
            fail("Could not subscribe to signed responses.")
            return
        }
        sendNextChallenge()
    }

    func peripheral(
        _ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard stage == .challenge || stage == .readFallback,
              self.peripheral === peripheral, characteristic.uuid == challengeUUID else { return }
        if error != nil { fail("The simulator rejected the challenge write.") }
    }
}
