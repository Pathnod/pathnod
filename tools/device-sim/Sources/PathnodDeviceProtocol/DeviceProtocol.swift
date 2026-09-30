import CryptoKit
import Foundation

public enum DeviceProtocolV0 {
    // Provisional UUID from Pathnod Spec §2.1; a v1 UUID decision is still pending.
    public static let provisionalServiceUUID = "534F5645-4C00-0000-0000-000000000001"
    public static let infoUUID = "534F5645-4C00-0000-0000-000000000002"
    public static let challengeUUID = "534F5645-4C00-0000-0000-000000000003"
    public static let responseUUID = "534F5645-4C00-0000-0000-000000000004"

    // The literal is 20 ASCII bytes. The draft spec's "24 octets" annotation is incorrect.
    public static let signedMessageDomain = Data("Pathnod/challenge/v0".utf8)
    public static let challengeLength = 44
    public static let responseHeaderLength = 78

    public enum EncodingError: Error, Equatable {
        case invalidChallengeLength
        case invalidChallengeFragments
        case invalidNonceLength
        case invalidObservationHintLength
        case invalidEvidenceHashLength
        case invalidPublicKeyLength
        case invalidSignatureLength
        case evidenceTooLong
    }

    /// One ATT write fragment. The complete challenge is assembled before it is accepted.
    public struct ChallengeFragment: Sendable {
        public let offset: Int
        public let value: Data

        public init(offset: Int, value: Data) {
            self.offset = offset
            self.value = value
        }
    }

    public struct Challenge: Equatable, Sendable {
        public let nonce: Data
        public let observationEpoch: UInt32
        public let observationHint: Data

        public init(nonce: Data, observationEpoch: UInt32, observationHint: Data) throws {
            guard nonce.count == 32 else { throw EncodingError.invalidNonceLength }
            guard observationHint.count == 8 else { throw EncodingError.invalidObservationHintLength }
            self.nonce = nonce
            self.observationEpoch = observationEpoch
            self.observationHint = observationHint
        }

        public init(wireData: Data) throws {
            guard wireData.count == DeviceProtocolV0.challengeLength else {
                throw EncodingError.invalidChallengeLength
            }
            try self.init(
                nonce: wireData.subdata(in: 0..<32),
                observationEpoch: wireData[32..<36].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) },
                observationHint: wireData.subdata(in: 36..<44)
            )
        }

        public init(fragments: [ChallengeFragment]) throws {
            guard !fragments.isEmpty else { throw EncodingError.invalidChallengeFragments }
            var wireData = Data(repeating: 0, count: DeviceProtocolV0.challengeLength)
            var written = [Bool](repeating: false, count: DeviceProtocolV0.challengeLength)

            for fragment in fragments {
                guard fragment.offset >= 0,
                      fragment.offset < DeviceProtocolV0.challengeLength,
                      !fragment.value.isEmpty,
                      fragment.value.count <= DeviceProtocolV0.challengeLength - fragment.offset else {
                    throw EncodingError.invalidChallengeFragments
                }
                for (position, byte) in fragment.value.enumerated() {
                    let index = fragment.offset + position
                    guard !written[index] else { throw EncodingError.invalidChallengeFragments }
                    wireData[index] = byte
                    written[index] = true
                }
            }

            guard written.allSatisfy({ $0 }) else { throw EncodingError.invalidChallengeFragments }
            try self.init(wireData: wireData)
        }

        public func wireData() -> Data {
            var result = nonce
            result.appendBigEndian(observationEpoch)
            result.append(observationHint)
            return result
        }
    }

    public static func info(publicKey: Data, capabilities: UInt32 = 0, protocolHint: Data = Data(repeating: 0, count: 32)) throws -> Data {
        guard publicKey.count == 32 else { throw EncodingError.invalidPublicKeyLength }
        guard protocolHint.count == 32 else { throw EncodingError.invalidEvidenceHashLength }
        var result = Data([0x00, 0x01]) // device spec v0, Ed25519
        result.append(publicKey)
        result.appendBigEndian(capabilities)
        result.append(protocolHint)
        return result
    }

    public static func signedMessage(
        challenge: Challenge,
        deviceTimestamp: UInt64,
        deviceCounter: UInt32,
        evidenceHash: Data = Data(repeating: 0, count: 32)
    ) throws -> Data {
        guard evidenceHash.count == 32 else { throw EncodingError.invalidEvidenceHashLength }
        var result = signedMessageDomain
        result.append(challenge.wireData())
        result.appendBigEndian(deviceTimestamp)
        result.appendBigEndian(deviceCounter)
        result.append(evidenceHash)
        return result
    }

    public static func sign(
        challenge: Challenge,
        deviceTimestamp: UInt64,
        deviceCounter: UInt32,
        using key: Curve25519.Signing.PrivateKey
    ) throws -> Data {
        let message = try signedMessage(
            challenge: challenge,
            deviceTimestamp: deviceTimestamp,
            deviceCounter: deviceCounter
        )
        return try key.signature(for: Data(SHA256.hash(data: message)))
    }

    public static func verify(
        signature: Data,
        challenge: Challenge,
        deviceTimestamp: UInt64,
        deviceCounter: UInt32,
        publicKey: Curve25519.Signing.PublicKey
    ) throws -> Bool {
        guard signature.count == 64 else { throw EncodingError.invalidSignatureLength }
        let message = try signedMessage(
            challenge: challenge,
            deviceTimestamp: deviceTimestamp,
            deviceCounter: deviceCounter
        )
        return publicKey.isValidSignature(signature, for: Data(SHA256.hash(data: message)))
    }

    public static func response(
        signature: Data,
        deviceTimestamp: UInt64,
        deviceCounter: UInt32,
        evidence: Data = Data()
    ) throws -> Data {
        guard signature.count == 64 else { throw EncodingError.invalidSignatureLength }
        guard evidence.count <= Int(UInt16.max) else { throw EncodingError.evidenceTooLong }
        var result = signature
        result.appendBigEndian(deviceTimestamp)
        result.appendBigEndian(deviceCounter)
        result.appendBigEndian(UInt16(evidence.count))
        result.append(evidence)
        return result
    }
}

private extension Data {
    mutating func appendBigEndian<T: FixedWidthInteger>(_ value: T) {
        for shift in stride(from: T.bitWidth - 8, through: 0, by: -8) {
            append(UInt8(truncatingIfNeeded: value >> shift))
        }
    }
}
