import CryptoKit
import Foundation
import PathnodChallengeCore
import PathnodObserverEnrollment

public enum ObservationTranscriptError: Error, Equatable {
    case invalidTranscript, invalidEncoding, enrollmentMismatch, unsupportedEvidence
}

/// Spec §4.5. Byte arrays are fixed-size; Borsh integers and lengths are little-endian.
/// This codec checks structure, not the server's DEV-33 acceptance policy.
public struct ObservationTranscript: Sendable, Equatable {
    public struct Challenge: Sendable, Equatable {
        public var nonce: Data
        public var signature: Data
        public var deviceTimestamp: UInt64
        public var deviceCounter: UInt32
        public var roundTripMilliseconds: UInt16
        public var rssiDBM: Int8

        public init(nonce: Data, signature: Data, deviceTimestamp: UInt64, deviceCounter: UInt32,
                    roundTripMilliseconds: UInt16, rssiDBM: Int8) {
            self.nonce = nonce; self.signature = signature; self.deviceTimestamp = deviceTimestamp
            self.deviceCounter = deviceCounter; self.roundTripMilliseconds = roundTripMilliseconds; self.rssiDBM = rssiDBM
        }
    }

    public var protocolID: Data
    public var deviceID: Data
    public var publicKey: Data
    public var curve: UInt8
    public var epoch: UInt32
    public var observationTimeMilliseconds: UInt64
    public var challenges: [Challenge]
    public var local: ObservationLocalSignals
    public var evidenceHash: Data
    public var pseudonym: Data
    public var nullifier: Data
    public var observerClass: UInt8

    public init(protocolID: Data, deviceID: Data, publicKey: Data, curve: UInt8, epoch: UInt32,
                observationTimeMilliseconds: UInt64, challenges: [Challenge], local: ObservationLocalSignals,
                evidenceHash: Data, pseudonym: Data, nullifier: Data, observerClass: UInt8) throws {
        self.protocolID = protocolID; self.deviceID = deviceID; self.publicKey = publicKey; self.curve = curve
        self.epoch = epoch; self.observationTimeMilliseconds = observationTimeMilliseconds
        self.challenges = challenges; self.local = local; self.evidenceHash = evidenceHash
        self.pseudonym = pseudonym; self.nullifier = nullifier; self.observerClass = observerClass
        try validate()
    }

    /// Converts only a verified capture belonging to this credential and enrollment.
    /// DEV-30 signed replies currently support absent evidence only.
    public init(capture: ObservationCapture, credential: ObserverCredential, enrollment: ObserverMerklePath,
                evidence: Data? = nil) throws {
        try capture.validate()
        try enrollment.validate(expectedCommitment: "0x" + credential.commitmentHex)
        guard evidence == nil else { throw ObservationTranscriptError.unsupportedEvidence }
        let context = try ObservationContext(protocolID: capture.protocolID, secret: credential.secretBytes,
            timeMilliseconds: capture.observationTimeMilliseconds, epochSeconds: capture.epochSeconds)
        guard context.pseudonym == capture.pseudonym else { throw ObservationTranscriptError.enrollmentMismatch }
        let info = try DeviceProtocolV0.Info(wireData: capture.infoWireData)
        let protocolField = try Self.idField(capture.protocolID, domain: 3)
        let deviceField = try Self.idField(capture.deviceID, domain: 4)
        let nullifier = try PoseidonCommitment.hashFive(ObservationEncoding.field(1), Data([0]) + credential.secretBytes,
            protocolField, deviceField, Self.field(capture.epoch))
        let challenges = try capture.challenges.map { entry in
            let response = try DeviceProtocolV0.Response(wireData: entry.response)
            return Challenge(nonce: entry.nonce, signature: response.signature, deviceTimestamp: response.deviceTimestamp,
                deviceCounter: response.deviceCounter, roundTripMilliseconds: entry.roundTripMilliseconds, rssiDBM: entry.rssiDBM)
        }
        try self.init(protocolID: capture.protocolID, deviceID: capture.deviceID, publicKey: info.publicKey,
            curve: capture.infoWireData[1], epoch: capture.epoch, observationTimeMilliseconds: capture.observationTimeMilliseconds,
            challenges: challenges, local: capture.local, evidenceHash: Self.hashEvidence(nil), pseudonym: capture.pseudonym,
            nullifier: nullifier, observerClass: UInt8(enrollment.observerClass))
    }

    public static func hashEvidence(_ evidence: Data?) -> Data {
        evidence.map { Data(SHA256.hash(data: $0)) } ?? Data(repeating: 0, count: 32)
    }

    public func validate() throws {
        guard [protocolID, deviceID, publicKey, evidenceHash, pseudonym, nullifier].allSatisfy({ $0.count == 32 }),
              protocolID.contains(where: { $0 != 0 }), (1...2).contains(curve), (1...3).contains(observerClass),
              PoseidonCommitment.isCanonicalField(pseudonym), PoseidonCommitment.isCanonicalField(nullifier),
              challenges.count == 3, challenges.allSatisfy({ $0.nonce.count == 32 && $0.signature.count == 64 && (-127...0).contains($0.rssiDBM) }),
              Set(challenges.map(\.nonce)).count == 3 else { throw ObservationTranscriptError.invalidTranscript }
        try local.validate()
    }

    public func encode() throws -> Data {
        try validate()
        var writer = BorshWriter()
        writer.integer(UInt8(0)); writer.bytes(protocolID); writer.bytes(deviceID); writer.bytes(publicKey)
        writer.integer(curve); writer.integer(epoch); writer.integer(observationTimeMilliseconds)
        writer.integer(UInt32(challenges.count))
        for challenge in challenges {
            writer.bytes(challenge.nonce); writer.bytes(challenge.signature); writer.integer(challenge.deviceTimestamp)
            writer.integer(challenge.deviceCounter); writer.integer(challenge.roundTripMilliseconds); writer.integer(challenge.rssiDBM)
        }
        writer.bytes(local.geohash6); writer.integer(local.gpsAccuracyMeters); writer.integer(local.barometerHPATimes10)
        writer.integer(local.motionClass); writer.bytes(local.wifiBSSIDHash); writer.integer(UInt32(local.rssiSamples.count))
        for rssi in local.rssiSamples { writer.integer(rssi) }
        writer.bytes(evidenceHash); writer.bytes(pseudonym); writer.bytes(nullifier); writer.integer(observerClass)
        return writer.data
    }

    public func transcriptHash() throws -> Data {
        Data(SHA256.hash(data: Data("Pathnod/transcript/v0".utf8) + (try encode())))
    }

    public static func decode(_ data: Data) throws -> Self {
        guard (596...611).contains(data.count) else { throw ObservationTranscriptError.invalidEncoding }
        var reader = BorshReader(data: Data(data))
        guard try reader.integer(UInt8.self) == 0 else { throw ObservationTranscriptError.invalidEncoding }
        let protocolID = try reader.bytes(32), deviceID = try reader.bytes(32), key = try reader.bytes(32)
        let curve = try reader.integer(UInt8.self), epoch = try reader.integer(UInt32.self), time = try reader.integer(UInt64.self)
        guard try reader.integer(UInt32.self) == 3 else { throw ObservationTranscriptError.invalidEncoding }
        var challenges: [Challenge] = []
        for _ in 0..<3 {
            challenges.append(try Challenge(nonce: reader.bytes(32), signature: reader.bytes(64), deviceTimestamp: reader.integer(UInt64.self),
                deviceCounter: reader.integer(UInt32.self), roundTripMilliseconds: reader.integer(UInt16.self), rssiDBM: reader.integer(Int8.self)))
        }
        var local = ObservationLocalSignals()
        local.geohash6 = try reader.bytes(6); local.gpsAccuracyMeters = try reader.integer(UInt16.self)
        local.barometerHPATimes10 = try reader.integer(UInt16.self); local.motionClass = try reader.integer(UInt8.self)
        local.wifiBSSIDHash = try reader.bytes(32)
        let count = try reader.integer(UInt32.self)
        guard (5...20).contains(count) else { throw ObservationTranscriptError.invalidEncoding }
        for _ in 0..<count { local.rssiSamples.append(try reader.integer(Int8.self)) }
        let evidence = try reader.bytes(32), pseudonym = try reader.bytes(32), nullifier = try reader.bytes(32)
        let hardwareClass = try reader.integer(UInt8.self)
        guard reader.offset == data.count else { throw ObservationTranscriptError.invalidEncoding }
        return try Self(protocolID: protocolID, deviceID: deviceID, publicKey: key, curve: curve, epoch: epoch,
            observationTimeMilliseconds: time, challenges: challenges, local: local, evidenceHash: evidence,
            pseudonym: pseudonym, nullifier: nullifier, observerClass: hardwareClass)
    }

    private static func idField(_ id: Data, domain: UInt8) throws -> Data {
        guard id.count == 32 else { throw ObservationTranscriptError.invalidTranscript }
        return try PoseidonCommitment.hashThree(ObservationEncoding.field(domain), Data(repeating: 0, count: 16) + id.prefix(16),
            Data(repeating: 0, count: 16) + id.suffix(16))
    }

    private static func field(_ value: UInt32) -> Data {
        Data(repeating: 0, count: 28) + Data((0..<4).reversed().map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) })
    }
}

private struct BorshWriter {
    var data = Data()
    mutating func bytes(_ bytes: Data) { data.append(bytes) }
    mutating func integer<T: FixedWidthInteger>(_ value: T) {
        for shift in stride(from: 0, to: T.bitWidth, by: 8) { data.append(UInt8(truncatingIfNeeded: value >> shift)) }
    }
}

private struct BorshReader {
    let data: Data
    var offset = 0
    mutating func bytes(_ count: Int) throws -> Data {
        guard count <= data.count - offset else { throw ObservationTranscriptError.invalidEncoding }
        defer { offset += count }
        return data.subdata(in: offset..<(offset + count))
    }
    mutating func integer<T: FixedWidthInteger>(_ type: T.Type) throws -> T {
        let bytes = try bytes(T.bitWidth / 8)
        var value: T = 0
        for (index, byte) in bytes.enumerated() { value |= T(truncatingIfNeeded: byte) << (index * 8) }
        return value
    }
}
