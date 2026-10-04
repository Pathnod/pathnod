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

/// What the iPhone learned about the connected device, for the DEV-23 record.
struct DeviceSummary: Equatable {
    let deviceIDPrefix: String
    let advertisedIdentity: DeviceProtocolV0.AdvertisedIdentity
    let capabilities: UInt32
    let capabilityNames: [String]
    /// Hex protocol hint, or `nil` when it is all zero.
    let protocolHint: String?
    /// Largest ATT write payload (ATT MTU minus 3) negotiated by iOS.
    let maximumWriteLength: Int

    init(info: DeviceProtocolV0.Info, advertisedIdentity: DeviceProtocolV0.AdvertisedIdentity,
         maximumWriteLength: Int) {
        deviceIDPrefix = info.deviceID.prefix(8).hexString
        self.advertisedIdentity = advertisedIdentity
        capabilities = info.capabilities
        capabilityNames = info.capabilitySet.names
        protocolHint = info.protocolHint.allSatisfy { $0 == 0 } ? nil : info.protocolHint.hexString
        self.maximumWriteLength = maximumWriteLength
    }

    var capabilitiesHex: String { String(format: "0x%08x", capabilities) }
}

extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}

@MainActor
final class ChallengeBLEController: NSObject, ObservableObject,
    @preconcurrency CBCentralManagerDelegate, @preconcurrency CBPeripheralDelegate {
    @Published private(set) var status = "Ready to scan for a Pathnod device."
    @Published private(set) var device: DeviceSummary?
    @Published private(set) var results: [ChallengeResult] = []
    @Published private(set) var medianNotificationRTTMilliseconds: Double?
    @Published private(set) var errorMessage: String?
    @Published private(set) var isRunning = false

    private enum Stage {
        case idle, waitingForRadio, scanning, connecting, services, characteristics
        case info, subscribing, pacing, challenge, readFallback, finished, failed, interrupted
    }

    /// Service Data arrives in the ESP32 scan response, which can be reported in a
    /// later discovery callback than the advertisement itself. The firmware
    /// advertises at 1 Hz, so a missed scan response costs about one second; one
    /// second of grace was not enough on hardware. Three covers ~3 advertising events.
    static let serviceDataGraceSeconds: TimeInterval = 3

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
    private var advertisedServiceData: Data?
    private var timeout: Timer?
    private var discoveryGrace: Timer?
    private var pacing: Timer?
    private var isSceneActive = true

    init(makeCentral: @escaping CentralFactory = {
        CBCentralManager(delegate: $0, queue: .main)
    }) {
        self.makeCentral = makeCentral
        super.init()
    }

    /// Plain-text record of the last session, for the DEV-23 runbook.
    var report: String {
        var lines = ["Pathnod S1 challenge session"]
        if let device {
            lines.append("device_id prefix: \(device.deviceIDPrefix)")
            lines.append("advertised ID: \(device.advertisedIdentity == .matched ? "matches INFO" : "not advertised")")
            lines.append("capabilities: \(device.capabilitiesHex)")
            lines.append("protocol hint: \(device.protocolHint ?? "zero")")
            lines.append("ATT MTU: \(device.maximumWriteLength + 3)")
        }
        for result in results {
            let transport = result.transport == .notification ? "notification" : "read fallback"
            lines.append(String(
                format: "challenge %d: %.1f ms, %@, counter %u",
                result.attempt, result.roundTripMilliseconds, transport, result.deviceCounter
            ))
        }
        if let medianNotificationRTTMilliseconds {
            lines.append(String(format: "median notification RTT: %.1f ms", medianNotificationRTTMilliseconds))
        }
        return lines.joined(separator: "\n")
    }

    func start() {
        guard !isRunning, isSceneActive else { return }
        stopConnection()
        results = []
        device = nil
        medianNotificationRTTMilliseconds = nil
        errorMessage = nil
        session = nil
        advertisedServiceData = nil
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
            // Duplicates let a later scan response deliver the ESP32 Service Data.
            central?.scanForPeripherals(
                withServices: [serviceUUID],
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
            )
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
                self.fail("The Bluetooth exchange timed out. Try again with the device nearby.")
            }
        }
    }

    private func stopConnection() {
        timeout?.invalidate()
        timeout = nil
        discoveryGrace?.invalidate()
        discoveryGrace = nil
        pacing?.invalidate()
        pacing = nil
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

    /// Waits until the device's per-connection rate limit allows the next write.
    /// The wait happens before t0, so it is never part of the measured RTT.
    private func scheduleNextChallenge() {
        guard let session else {
            fail("The challenge session is incomplete.")
            return
        }
        let now = ProcessInfo.processInfo.systemUptime
        guard let allowedAt = session.nextChallengeAllowedAt, allowedAt > now else {
            sendNextChallenge()
            return
        }
        timeout?.invalidate()
        timeout = nil
        stage = .pacing
        status = "Waiting for the device rate limit before challenge \(session.results.count + 1) of 3…"
        pacing?.invalidate()
        pacing = Timer.scheduledTimer(withTimeInterval: allowedAt - now, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.isRunning, self.stage == .pacing else { return }
                self.scheduleNextChallenge()
            }
        }
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
                if session.isComplete { finish() } else { scheduleNextChallenge() }
            }
        } catch ChallengeSession.SessionError.nonIncreasingCounter {
            fail("The device counter did not increase although the device claims a monotonic counter.")
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
        let serviceData = (advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data])?[serviceUUID]
        if serviceData == nil {
            // Wait briefly for a scan response from this candidate. The macOS
            // simulator never sends one, so connect without it after the grace period.
            guard self.peripheral == nil else { return }
            self.peripheral = peripheral
            discoveryGrace = Timer.scheduledTimer(
                withTimeInterval: Self.serviceDataGraceSeconds, repeats: false
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.stage == .scanning, let candidate = self.peripheral else { return }
                    self.connect(candidate, serviceData: nil)
                }
            }
            return
        }
        connect(peripheral, serviceData: serviceData)
    }

    private func connect(_ peripheral: CBPeripheral, serviceData: Data?) {
        discoveryGrace?.invalidate()
        discoveryGrace = nil
        central?.stopScan()
        advertisedServiceData = serviceData
        self.peripheral = peripheral
        peripheral.delegate = self
        stage = .connecting
        status = "Connecting to the device…"
        setTimeout(10)
        central?.connect(peripheral, options: nil)
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
            fail("Could not connect to the device.")
        }
    }

    func centralManager(
        _ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        if isRunning, self.peripheral === peripheral {
            fail("The device disconnected before all three challenges were verified.")
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
            fail("The device is missing a required read, write or notify characteristic.")
            return
        }
        stage = .info
        status = "Reading the device's public key…"
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
                let info = try DeviceProtocolV0.Info(wireData: data)
                let identity: DeviceProtocolV0.AdvertisedIdentity
                do {
                    identity = try DeviceProtocolV0.checkAdvertisedIdentity(
                        serviceData: advertisedServiceData, info: info
                    )
                } catch {
                    fail("The advertised device ID does not match the public key read from INFO.")
                    return
                }
                device = DeviceSummary(
                    info: info, advertisedIdentity: identity,
                    maximumWriteLength: peripheral.maximumWriteValueLength(for: .withoutResponse)
                )
                session = ChallengeSession(info: info)
                guard let responseCharacteristic else {
                    fail("The response characteristic disappeared.")
                    return
                }
                stage = .subscribing
                status = "Subscribing to signed responses…"
                setTimeout(10)
                peripheral.setNotifyValue(true, for: responseCharacteristic)
            } catch {
                fail("The device returned invalid or unsupported INFO data.")
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
        scheduleNextChallenge()
    }

    func peripheral(
        _ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard stage == .challenge || stage == .readFallback,
              self.peripheral === peripheral, characteristic.uuid == challengeUUID else { return }
        if error != nil { fail("The device rejected the challenge write.") }
    }
}
