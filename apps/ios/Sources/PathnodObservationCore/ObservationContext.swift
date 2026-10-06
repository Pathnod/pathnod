import Foundation
import PathnodObserverEnrollment

public enum ObservationError: Error, LocalizedError, Equatable {
    case invalidInput, invalidEligibility, unknownDevice, unpaidNotAllowed
    case invalidSignals, invalidCapture, cacheUnavailable
    case server(String)

    public var errorDescription: String? {
        switch self {
        case .invalidInput: "The observation settings are invalid."
        case .invalidEligibility: "The eligibility service returned inconsistent protocol settings."
        case .unknownDevice: "This device is not registered under the selected protocol."
        case .unpaidNotAllowed: "No paid slots are available. Enable unpaid observations to continue."
        case .invalidSignals: "At least five valid Bluetooth signal samples are required."
        case .invalidCapture: "The collected session did not satisfy the observation checks."
        case .cacheUnavailable: "The completed session could not be saved or restored."
        case .server(let code): "Eligibility service: \(code)."
        }
    }
}

public enum ObservationEncoding {
    public static func timeMilliseconds(_ date: Date) throws -> UInt64 {
        let value = date.timeIntervalSince1970 * 1000
        guard value.isFinite, value >= 0, value < Double(UInt64.max) else { throw ObservationError.invalidInput }
        return UInt64(value)
    }
    public static func hex(_ bytes: Data) -> String { "0x" + bytes.map { String(format: "%02x", $0) }.joined() }

    public static func id(_ value: String) throws -> Data {
        let body = value.hasPrefix("0x") ? String(value.dropFirst(2)) : value
        guard body.count == 64 else { throw ObservationError.invalidInput }
        var result = Data(); var cursor = body.startIndex
        for _ in 0..<32 {
            let next = body.index(cursor, offsetBy: 2)
            guard let byte = UInt8(body[cursor..<next], radix: 16) else { throw ObservationError.invalidInput }
            result.append(byte); cursor = next
        }
        return result
    }

    public static func epoch(at milliseconds: UInt64, seconds: UInt32) throws -> UInt32 {
        guard seconds > 0, let value = UInt32(exactly: milliseconds / 1000 / UInt64(seconds)) else {
            throw ObservationError.invalidInput
        }
        return value
    }

    public static func field(_ value: UInt8) -> Data { Data(repeating: 0, count: 31) + Data([value]) }
}

public struct ObservationContext: Sendable {
    public let protocolID: Data
    public let epoch: UInt32
    public let epochSeconds: UInt32
    public let observationTimeMilliseconds: UInt64
    public let pseudonym: Data
    public var observationHint: Data { Data(pseudonym.prefix(8)) }

    public init(protocolID: Data, secret: Data, timeMilliseconds: UInt64, epochSeconds: UInt32) throws {
        guard protocolID.count == 32, protocolID.contains(where: { $0 != 0 }), secret.count == 31 else {
            throw ObservationError.invalidInput
        }
        self.protocolID = protocolID
        self.epochSeconds = epochSeconds
        observationTimeMilliseconds = timeMilliseconds
        epoch = try ObservationEncoding.epoch(at: timeMilliseconds, seconds: epochSeconds)
        let high = Data(repeating: 0, count: 16) + protocolID.prefix(16)
        let low = Data(repeating: 0, count: 16) + protocolID.suffix(16)
        let field = try PoseidonCommitment.hashThree(ObservationEncoding.field(3), high, low)
        pseudonym = try PoseidonCommitment.hashThree(ObservationEncoding.field(2), Data([0]) + secret, field)
    }
}
