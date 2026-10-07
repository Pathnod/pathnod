import CoreBluetooth
import Foundation
import PathnodChallengeCore
import PathnodObservationCore
import PathnodObserverEnrollment
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
    let publicKeyHex: String
    let deviceIDHex: String
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
        deviceIDHex = info.deviceID.hexString
        publicKeyHex = info.publicKey.hexString
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
struct ObservationRequest {
    let client: EligibilityClient
    let credential: ObserverCredential
    let cache: any ObservationCache
    let sensors: ObservationSensors
    let useLocation: Bool
    let useMotion: Bool
    let allowUnpaid: Bool
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
    @Published private(set) var observationCapture: ObservationCapture?
    @Published private(set) var eligibilityQuote: ObservationEligibility?
    @Published private(set) var restoredObservation = false
    @Published private(set) var overallDurationMilliseconds: Double?

    private enum Stage {
        case idle, preparingService, waitingForRadio, scanning, connecting, services, characteristics
        case info, preflight, subscribing, pacing, challenge, readFallback, finished, failed, interrupted
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
    private var observationRequest: ObservationRequest?
    private var observationContext: ObservationContext?
    private var cacheKey: ObservationCacheKey?
    private var preflightTask: Task<Void, Never>?
    private var generation = UUID()
    private var notificationReady = false
    private var connectedStartedAt: Double?
    private var rssiTimer: Timer?
    private var rssiSamples: [Int8] = []
    private var latestRSSI: Int8?
    private var challengeRSSI: [Int8] = []
    private var servicePrepared = false
    private var requestStartedAt: Double?

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

    var observationReport: String {
        guard let capture = observationCapture else { return "No completed observation session." }
        return ["Pathnod local observation session",
            "device_id prefix: \(capture.deviceID.prefix(8).hexString)",
            "epoch: \(capture.epoch)", "epoch seconds: \(capture.epochSeconds)",
            "verified signatures: \(capture.challenges.count)",
            "median notification RTT: \(capture.challenges.map(\.roundTripMilliseconds).sorted()[1]) ms",
            String(format: "connection-to-collection: %.1f ms", capture.durationMilliseconds),
            String(format: "preparation + discovery + collection: %.1f ms", overallDurationMilliseconds ?? 0),
            "RSSI samples: \(capture.local.rssiSamples.count)",
            "GPS included: \(!capture.local.geohash6.allSatisfy { $0 == 0 })",
            "barometer included: \(capture.local.barometerHPATimes10 != 0)",
            "motion class: \(capture.local.motionClass)",
            "restored from cache: \(restoredObservation)"].joined(separator: "\n")
    }

    func start() {
        startSession(observation: nil)
    }

    func startObservation(_ request: ObservationRequest) {
        startSession(observation: request)
    }

    private func startSession(observation: ObservationRequest?) {
        guard !isRunning, isSceneActive else { return }
        stopConnection()
        requestStartedAt = ProcessInfo.processInfo.systemUptime
        overallDurationMilliseconds = nil; servicePrepared = false
        observationRequest = observation
        observationCapture = nil; eligibilityQuote = nil; restoredObservation = false
        notificationReady = false; rssiSamples = []; latestRSSI = nil; challengeRSSI = []
        results = []
        device = nil
        medianNotificationRTTMilliseconds = nil
        errorMessage = nil
        session = nil
        advertisedServiceData = nil
        isRunning = true
        if let observation {
            stage = .preparingService; status = "Preparing the service connection before scanning…"; setTimeout(10)
            let token = generation
            preflightTask = Task { [weak self] in
                do {
                    try await observation.client.prepareConnection()
                    guard let self, self.isRunning, self.generation == token else { return }
                    self.servicePrepared = true
                    if self.isSceneActive { self.beginBluetooth() }
                } catch {
                    guard let self, self.isRunning, self.generation == token else { return }
                    self.fail(error.localizedDescription)
                }
            }
            return
        }
        beginBluetooth()
    }

    private func beginBluetooth() {
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
        if phase == .active, isRunning, stage == .preparingService, servicePrepared {
            beginBluetooth()
        } else if phase == .active, isRunning, stage == .waitingForRadio {
            setTimeout(10)
            if let central { handleRadioState(central.state) }
        } else if phase == .inactive, isRunning, (stage == .waitingForRadio || stage == .preparingService) {
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
        generation = UUID()
        preflightTask?.cancel(); preflightTask = nil
        rssiTimer?.invalidate(); rssiTimer = nil
        observationRequest?.sensors.stop()
        observationRequest = nil; observationContext = nil; cacheKey = nil
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
        let isObservation = observationRequest != nil
        if let request = observationRequest {
            do {
                guard let info = session?.info, let context = observationContext, let cacheKey,
                      let started = connectedStartedAt else { throw ObservationError.invalidCapture }
                let capture = try ObservationCapture(info: info, context: context, results: results, challengeRSSI: challengeRSSI,
                    local: request.sensors.snapshot(rssi: rssiSamples),
                    durationMilliseconds: (ProcessInfo.processInfo.systemUptime - started) * 1000)
                try request.cache.save(capture, for: cacheKey)
                observationCapture = capture
                overallDurationMilliseconds = requestStartedAt.map { (ProcessInfo.processInfo.systemUptime - $0) * 1000 }
            } catch { fail(error.localizedDescription); return }
        }
        stage = .finished
        isRunning = false
        status = isObservation ? "Session collected and saved; three signatures verified." : "Three signatures verified on this iPhone."
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
            traceObservation("write-\(session.results.count + 1)")
            let nonce = try randomNonce()
            stage = .challenge
            status = "Challenge \(session.results.count + 1) of 3…"
            setTimeout(15)
            let wire = try session.beginChallenge(
                nonce: nonce, observationEpoch: observationContext?.epoch ?? 0,
                observationHint: observationContext?.observationHint ?? Data(repeating: 0, count: 8),
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
            if observationRequest != nil {
                fail("A complete notification is required for an observation. Retry with the device nearby.")
                return
            }
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
                traceObservation("verified-\(result.attempt)")
                if observationRequest != nil {
                    guard let latestRSSI else { fail(ObservationError.invalidSignals.localizedDescription); return }
                    challengeRSSI.append(latestRSSI)
                }
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
        guard peripheral.state == .disconnected else {
            self.peripheral = nil
            return
        }
        discoveryGrace?.invalidate()
        discoveryGrace = nil
        central?.stopScan()
        advertisedServiceData = serviceData
        self.peripheral = peripheral
        peripheral.delegate = self
        stage = .connecting
        status = "Connecting to the device…"
        setTimeout(10)
        connectedStartedAt = ProcessInfo.processInfo.systemUptime
        traceObservation("connect")
        central?.connect(peripheral, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard stage == .connecting, self.peripheral === peripheral else { return }
        traceObservation("connected")
        if let request = observationRequest {
            request.sensors.start(useLocation: request.useLocation, useMotion: request.useMotion)
            peripheral.readRSSI()
            rssiTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.isRunning, self.rssiSamples.count < 20 else { return }
                    self.peripheral?.readRSSI()
                }
            }
        }
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
        if isRunning, stage != .scanning, stage != .waitingForRadio, self.peripheral === peripheral {
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
                if observationRequest != nil { beginObservationPreflight(info: info); return }
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
        guard (stage == .subscribing || stage == .preflight), self.peripheral === peripheral,
              characteristic.uuid == responseUUID else { return }
        guard error == nil, characteristic.isNotifying else {
            fail("Could not subscribe to signed responses.")
            return
        }
        notificationReady = true
        if stage == .preflight { return }
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

    func peripheral(_ peripheral: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
        guard isRunning, observationRequest != nil, self.peripheral === peripheral, error == nil,
              (-127...0).contains(RSSI.intValue) else { return }
        latestRSSI = Int8(RSSI.intValue)
        if rssiSamples.count < 20 { rssiSamples.append(Int8(RSSI.intValue)) }
    }

    private func beginObservationPreflight(info: DeviceProtocolV0.Info) {
        traceObservation("info")
        guard let request = observationRequest, let characteristic = responseCharacteristic else {
            fail("The observation configuration is incomplete."); return
        }
        stage = .preflight; status = "Checking device eligibility…"; setTimeout(15)
        peripheral?.setNotifyValue(true, for: characteristic)
        let token = generation
        preflightTask = Task { [weak self] in
            do {
                let quote = try await request.client.resolve(deviceID: info.deviceID,
                    timeMilliseconds: ObservationEncoding.timeMilliseconds(Date()))
                guard let self, self.isRunning, self.generation == token else { return }
                self.traceObservation("eligibility")
                self.eligibilityQuote = quote.quote
                guard quote.quote.registered else { throw ObservationError.unknownDevice }
                let context = try ObservationContext(protocolID: ObservationEncoding.id(quote.quote.protocolID),
                    secret: request.credential.secretBytes, timeMilliseconds: quote.observationTimeMilliseconds, epochSeconds: quote.epochSeconds)
                let key = try ObservationCacheKey(commitment: request.credential.commitmentBytes,
                    protocolID: context.protocolID, deviceID: info.deviceID, epoch: context.epoch)
                if let stored = try request.cache.completed(for: key) {
                    guard stored.protocolID == context.protocolID, stored.deviceID == info.deviceID,
                          stored.epoch == context.epoch, stored.pseudonym == context.pseudonym else { throw ObservationError.invalidCapture }
                    self.observationCapture = stored; self.restoredObservation = true
                    self.stage = .finished; self.isRunning = false
                    self.status = "Already collected this epoch. Restored the saved session without sending challenges."
                    self.overallDurationMilliseconds = self.requestStartedAt.map { (ProcessInfo.processInfo.systemUptime - $0) * 1000 }
                    self.stopConnection(); self.session = nil; return
                }
                try quote.requireCollectionPermission(allowUnpaid: request.allowUnpaid)
                self.observationContext = context; self.cacheKey = key
                self.stage = .subscribing; self.status = "Preparing signed challenges…"; self.setTimeout(10)
                if self.notificationReady { self.scheduleNextChallenge() }
            } catch {
                guard let self, self.isRunning, self.generation == token else { return }
                self.fail(error.localizedDescription)
            }
        }
    }

    private func traceObservation(_ stage: String) {
        #if DEBUG
        if ProcessInfo.processInfo.environment["PATHNOD_DEV30_HARDWARE"] == "1", let start = connectedStartedAt {
            print(String(format: "DEV30_TIMING %@ %.1f ms", stage, (ProcessInfo.processInfo.systemUptime - start) * 1000))
        }
        #endif
    }
}
