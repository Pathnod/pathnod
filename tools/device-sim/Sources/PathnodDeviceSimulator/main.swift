@preconcurrency import CoreBluetooth
import CryptoKit
import Foundation
import OSLog
import PathnodDeviceProtocol

private let simulatorLogger = Logger(subsystem: "xyz.pathnod.device-sim", category: "simulator")

private func simLog(_ message: String) {
    simulatorLogger.notice("\(message, privacy: .public)")
}

private struct Configuration {
    let responseDelayMilliseconds: Int

    init(arguments: [String]) throws {
        guard arguments.count == 1 || arguments.count == 3 else { throw ConfigurationError.usage }
        if arguments.count == 1 {
            responseDelayMilliseconds = 0
            return
        }
        guard arguments[1] == "--delay-ms",
              let delay = Int(arguments[2]),
              (0...10_000).contains(delay) else { throw ConfigurationError.usage }
        responseDelayMilliseconds = delay
    }

    enum ConfigurationError: Error { case usage }
}

@MainActor
private final class DevicePeripheral: NSObject, @preconcurrency CBPeripheralManagerDelegate {
    private let key = Curve25519.Signing.PrivateKey()
    private let delayMilliseconds: Int
    private var manager: CBPeripheralManager!
    private var infoCharacteristic: CBMutableCharacteristic!
    private var challengeCharacteristic: CBMutableCharacteristic!
    private var responseCharacteristic: CBMutableCharacteristic!
    private var counter: UInt32 = 0
    private var generationByCentral: [UUID: UInt64] = [:]
    private var responseByCentral: [UUID: Data] = [:]
    private var queuedNotifications: [UUID: Data] = [:]

    init(delayMilliseconds: Int) {
        self.delayMilliseconds = delayMilliseconds
        super.init()
        manager = CBPeripheralManager(delegate: self, queue: .main)
        simLog("Pathnod device simulator started; response delay: \(delayMilliseconds) ms")
        simLog("Development-only ephemeral Ed25519 key; no private key is persisted or logged")
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        switch peripheral.state {
        case .poweredOn:
            publishService()
        case .poweredOff:
            clearRuntimeState()
            simLog("Bluetooth is off; advertising unavailable")
        case .unauthorized:
            clearRuntimeState()
            simLog("Bluetooth permission denied; allow Bluetooth for PathnodDeviceSimulator in System Settings")
        case .unsupported:
            clearRuntimeState()
            simLog("Bluetooth peripheral mode is unsupported on this Mac")
        case .resetting:
            clearRuntimeState()
            simLog("Bluetooth is resetting")
        case .unknown:
            simLog("Bluetooth state is unknown")
        @unknown default:
            simLog("Bluetooth entered an unknown state")
        }
    }

    private func clearRuntimeState() {
        manager.stopAdvertising()
        manager.removeAllServices()
        infoCharacteristic = nil
        challengeCharacteristic = nil
        responseCharacteristic = nil
        generationByCentral.removeAll()
        responseByCentral.removeAll()
        queuedNotifications.removeAll()
    }

    private func publishService() {
        manager.removeAllServices()
        responseByCentral.removeAll()
        queuedNotifications.removeAll()
        do {
            let info = try DeviceProtocolV0.info(publicKey: key.publicKey.rawRepresentation)
            infoCharacteristic = CBMutableCharacteristic(
                type: CBUUID(string: DeviceProtocolV0.infoUUID),
                properties: [.read], value: info, permissions: [.readable]
            )
            challengeCharacteristic = CBMutableCharacteristic(
                type: CBUUID(string: DeviceProtocolV0.challengeUUID),
                properties: [.write], value: nil, permissions: [.writeable]
            )
            responseCharacteristic = CBMutableCharacteristic(
                type: CBUUID(string: DeviceProtocolV0.responseUUID),
                properties: [.read, .notify], value: nil, permissions: [.readable]
            )
            let service = CBMutableService(
                type: CBUUID(string: DeviceProtocolV0.provisionalServiceUUID), primary: true
            )
            service.characteristics = [infoCharacteristic, challengeCharacteristic, responseCharacteristic]
            manager.add(service)
        } catch {
            simLog("Could not encode INFO characteristic: \(error)")
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error {
            simLog("Could not publish GATT service: \(error)")
            return
        }
        peripheral.startAdvertising([
            CBAdvertisementDataLocalNameKey: "Pathnod DEV-09 Simulator",
            CBAdvertisementDataServiceUUIDsKey: [CBUUID(string: DeviceProtocolV0.provisionalServiceUUID)],
        ])
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error {
            simLog("Advertising failed: \(error)")
        } else {
            simLog("Advertising provisional Pathnod service UUID; ready for a BLE central")
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        simLog("Central subscribed to RESPONSE notifications")
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        let id = central.identifier
        generationByCentral[id, default: 0] &+= 1
        responseByCentral.removeValue(forKey: id)
        queuedNotifications.removeValue(forKey: id)
        simLog("Central unsubscribed; pending response cleared")
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        guard request.characteristic.uuid == responseCharacteristic.uuid else {
            peripheral.respond(to: request, withResult: .requestNotSupported)
            return
        }
        guard let response = responseByCentral[request.central.identifier] else {
            peripheral.respond(to: request, withResult: .unlikelyError)
            return
        }
        guard request.offset <= response.count else {
            peripheral.respond(to: request, withResult: .invalidOffset)
            return
        }
        request.value = response.subdata(in: request.offset..<response.count)
        peripheral.respond(to: request, withResult: .success)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard let first = requests.first else { return }
        guard let challengeCharacteristic,
              requests.allSatisfy({
                  $0.characteristic.uuid == challengeCharacteristic.uuid &&
                  $0.central.identifier == first.central.identifier
              }) else {
            peripheral.respond(to: first, withResult: .requestNotSupported)
            return
        }

        let fragments = requests.compactMap { request in
            request.value.map { DeviceProtocolV0.ChallengeFragment(offset: request.offset, value: $0) }
        }
        guard fragments.count == requests.count,
              let challenge = try? DeviceProtocolV0.Challenge(fragments: fragments) else {
            peripheral.respond(to: first, withResult: .invalidAttributeValueLength)
            simLog("Malformed challenge rejected")
            return
        }

        let id = first.central.identifier
        generationByCentral[id, default: 0] &+= 1
        let generation = generationByCentral[id]!
        responseByCentral.removeValue(forKey: id)
        queuedNotifications.removeValue(forKey: id)
        peripheral.respond(to: first, withResult: .success)
        simLog("Challenge received; response scheduled after \(delayMilliseconds) ms")
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(delayMilliseconds)) { [weak self] in
            self?.emitResponse(for: challenge, central: first.central, generation: generation)
        }
    }

    private func emitResponse(for challenge: DeviceProtocolV0.Challenge, central: CBCentral, generation: UInt64) {
        let id = central.identifier
        guard generationByCentral[id] == generation else { return }
        do {
            // The development simulator has no trusted clock or persistent monotone counter.
            let timestamp = UInt64(Date().timeIntervalSince1970)
            counter &+= 1
            let signature = try DeviceProtocolV0.sign(
                challenge: challenge, deviceTimestamp: timestamp, deviceCounter: counter, using: key
            )
            let response = try DeviceProtocolV0.response(
                signature: signature, deviceTimestamp: timestamp, deviceCounter: counter
            )
            responseByCentral[id] = response
            queuedNotifications[id] = response
            flushNotification(for: central)
            simLog("Response emitted; configured delay: \(delayMilliseconds) ms")
        } catch {
            simLog("Could not encode response: \(error)")
        }
    }

    private func flushNotification(for central: CBCentral) {
        let id = central.identifier
        guard let response = queuedNotifications[id] else { return }
        if manager.updateValue(response, for: responseCharacteristic, onSubscribedCentrals: [central]) {
            queuedNotifications.removeValue(forKey: id)
        }
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        for central in responseCharacteristic.subscribedCentrals ?? [] {
            flushNotification(for: central)
        }
    }
}

do {
    let config = try Configuration(arguments: CommandLine.arguments)
    let device = DevicePeripheral(delayMilliseconds: config.responseDelayMilliseconds)
    withExtendedLifetime(device) { RunLoop.main.run() }
} catch {
    fputs("Usage: pathnod-device-sim [--delay-ms 0...10000]\n", stderr)
    exit(2)
}
