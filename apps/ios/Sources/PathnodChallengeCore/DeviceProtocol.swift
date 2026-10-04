import CryptoKit
import Foundation

/// Provisional Pathnod Spec §2 UUIDs and wire format (DEV-09 simulator, DEV-20+ ESP32).
public enum DeviceProtocolV0 {
    public static let serviceUUID = "534F5645-4C00-0000-0000-000000000001"
    public static let infoUUID = "534F5645-4C00-0000-0000-000000000002"
    public static let challengeUUID = "534F5645-4C00-0000-0000-000000000003"
    public static let responseUUID = "534F5645-4C00-0000-0000-000000000004"
    public static let domain = Data("Pathnod/challenge/v0".utf8)
    public static let deviceIDDomain = Data("Pathnod/device/v0".utf8)
    public static let challengeLength = 44
    public static let responseHeaderLength = 78
    /// Spec §2.1: Service Data carries `device_id[0..8]`.
    public static let advertisedDeviceIDPrefixLength = 8
    /// Spec §2.3: at most one challenge every two seconds per connection.
    public static let minimumChallengeIntervalSeconds = 2.0

    public enum ProtocolError: Error, Equatable {
        case malformedInfo
        case unsupportedDevice
        case malformedChallenge
        case malformedResponse
        case unsupportedEvidence
        case invalidSignature
        case deviceIDMismatch
    }

    /// Spec §2.2 capability bits.
    public struct Capabilities: OptionSet, Sendable {
        public let rawValue: UInt32
        public init(rawValue: UInt32) { self.rawValue = rawValue }

        public static let trustedClock = Capabilities(rawValue: 1 << 0)
        public static let monotonicCounter = Capabilities(rawValue: 1 << 1)
        public static let serviceEvidence = Capabilities(rawValue: 1 << 2)
        public static let challengeRateLimit = Capabilities(rawValue: 1 << 3)
        public static let secureElement = Capabilities(rawValue: 1 << 4)
        public static let externalIdentity = Capabilities(rawValue: 1 << 5)

        public var names: [String] {
            [
                (Self.trustedClock, "trusted clock"),
                (Self.monotonicCounter, "monotonic counter"),
                (Self.serviceEvidence, "service evidence"),
                (Self.challengeRateLimit, "challenge rate limit"),
                (Self.secureElement, "secure element"),
                (Self.externalIdentity, "external identity"),
            ].filter { contains($0.0) }.map(\.1)
        }
    }

    /// Whether the advertised Service Data prefix was checked against INFO.
    public enum AdvertisedIdentity: Equatable, Sendable {
        case matched
        /// The macOS simulator cannot advertise Service Data.
        case notAdvertised
    }

    public struct Info: Sendable {
        public let publicKey: Data
        public let capabilities: UInt32
        public let protocolHint: Data

        public init(wireData: Data) throws {
            guard wireData.count == 70 else { throw ProtocolError.malformedInfo }
            guard wireData[0] == 0, wireData[1] == 1 else {
                throw ProtocolError.unsupportedDevice
            }
            let key = wireData.subdata(in: 2..<34)
            guard (try? Curve25519.Signing.PublicKey(rawRepresentation: key)) != nil else {
                throw ProtocolError.malformedInfo
            }
            publicKey = key
            capabilities = wireData.readBigEndian(34..<38, as: UInt32.self)
            protocolHint = wireData.subdata(in: 38..<70)
        }

        public var capabilitySet: Capabilities { Capabilities(rawValue: capabilities) }
        public var deviceID: Data { DeviceProtocolV0.deviceID(publicKey: publicKey) }
    }

    /// `device_id = SHA-256("Pathnod/device/v0" || K_dev)`.
    public static func deviceID(publicKey: Data) -> Data {
        Data(SHA256.hash(data: deviceIDDomain + publicKey))
    }

    /// Compares Service Data, when advertised, with the identity read from INFO.
    public static func checkAdvertisedIdentity(
        serviceData: Data?, info: Info
    ) throws -> AdvertisedIdentity {
        guard let serviceData else { return .notAdvertised }
        guard serviceData.count == advertisedDeviceIDPrefixLength,
              serviceData == info.deviceID.prefix(advertisedDeviceIDPrefixLength) else {
            throw ProtocolError.deviceIDMismatch
        }
        return .matched
    }

    public struct Challenge: Equatable, Sendable {
        public let nonce: Data
        public let observationEpoch: UInt32
        public let observationHint: Data

        public init(nonce: Data, observationEpoch: UInt32, observationHint: Data) throws {
            guard nonce.count == 32, observationHint.count == 8 else {
                throw ProtocolError.malformedChallenge
            }
            self.nonce = nonce
            self.observationEpoch = observationEpoch
            self.observationHint = observationHint
        }

        public func wireData() -> Data {
            var data = nonce
            data.appendBigEndian(observationEpoch)
            data.append(observationHint)
            return data
        }
    }

    public struct Response: Sendable {
        public let raw: Data
        public let signature: Data
        public let deviceTimestamp: UInt64
        public let deviceCounter: UInt32

        public init(wireData: Data) throws {
            guard wireData.count >= DeviceProtocolV0.responseHeaderLength else {
                throw ProtocolError.malformedResponse
            }
            let evidenceLength = Int(wireData.readBigEndian(76..<78, as: UInt16.self))
            guard wireData.count == DeviceProtocolV0.responseHeaderLength + evidenceLength else {
                throw ProtocolError.malformedResponse
            }
            // DEV-09 signs a zero evidence hash; other evidence is not supported here.
            guard evidenceLength == 0 else { throw ProtocolError.unsupportedEvidence }
            raw = wireData
            signature = wireData.subdata(in: 0..<64)
            deviceTimestamp = wireData.readBigEndian(64..<72, as: UInt64.self)
            deviceCounter = wireData.readBigEndian(72..<76, as: UInt32.self)
        }
    }

    public static func signedMessage(challenge: Challenge, response: Response) -> Data {
        var data = domain
        data.append(challenge.wireData())
        data.appendBigEndian(response.deviceTimestamp)
        data.appendBigEndian(response.deviceCounter)
        data.append(Data(repeating: 0, count: 32))
        return data
    }

    public static func verify(response: Response, challenge: Challenge, info: Info) throws {
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: info.publicKey)
        let digest = Data(SHA256.hash(data: signedMessage(challenge: challenge, response: response)))
        guard key.isValidSignature(response.signature, for: digest) else {
            throw ProtocolError.invalidSignature
        }
    }
}

private extension Data {
    func readBigEndian<T: FixedWidthInteger>(_ range: Range<Int>, as: T.Type) -> T {
        self[range].reduce(T.zero) { ($0 << 8) | T($1) }
    }

    mutating func appendBigEndian<T: FixedWidthInteger>(_ value: T) {
        for shift in stride(from: T.bitWidth - 8, through: 0, by: -8) {
            append(UInt8(truncatingIfNeeded: value >> shift))
        }
    }
}
