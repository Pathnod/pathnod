import CryptoKit
import Foundation

/// Provisional DEV-09 UUIDs and wire format.
public enum DeviceProtocolV0 {
    public static let serviceUUID = "534F5645-4C00-0000-0000-000000000001"
    public static let infoUUID = "534F5645-4C00-0000-0000-000000000002"
    public static let challengeUUID = "534F5645-4C00-0000-0000-000000000003"
    public static let responseUUID = "534F5645-4C00-0000-0000-000000000004"
    public static let domain = Data("Pathnod/challenge/v0".utf8)
    public static let challengeLength = 44
    public static let responseHeaderLength = 78

    public enum ProtocolError: Error, Equatable {
        case malformedInfo
        case unsupportedDevice
        case malformedChallenge
        case malformedResponse
        case unsupportedEvidence
        case invalidSignature
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
