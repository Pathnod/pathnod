import CryptoKit
import Foundation
import XCTest
import PathnodObserverEnrollment
@testable import PathnodObservationCore

private struct TranscriptFixtures: Decodable {
    let publicTestVectors: Bool
    let vectors: [Vector]
    struct Vector: Decodable {
        let name: String
        let bytes: String
        let hash: String
        let evidence: String?
        let secret: String
        let protocolField, deviceField: String
        let transcript: Input
        let capture: ObservationCapture?
        let enrollment: ObserverMerklePath?
    }
    struct Input: Decodable {
        let protocolID, deviceID, publicKey, observationTimeMilliseconds, evidenceHash, pseudonym, nullifier: String
        let curve, observerClass: UInt8
        let epoch: UInt32
        let challenges: [Challenge]
        let local: Local
        struct Challenge: Decodable {
            let nonce, signature, deviceTimestamp: String
            let deviceCounter: UInt32
            let roundTripMilliseconds: UInt16
            let rssiDBM: Int8
        }
        struct Local: Decodable {
            let geohash6, wifiBSSIDHash: String
            let gpsAccuracyMeters, barometerHPATimes10: UInt16
            let motionClass: UInt8
            let rssiSamples: [Int8]
        }
        func value() throws -> ObservationTranscript {
            var signals = ObservationLocalSignals()
            signals.geohash6 = try hex(local.geohash6); signals.wifiBSSIDHash = try hex(local.wifiBSSIDHash)
            signals.gpsAccuracyMeters = local.gpsAccuracyMeters; signals.barometerHPATimes10 = local.barometerHPATimes10
            signals.motionClass = local.motionClass; signals.rssiSamples = local.rssiSamples
            return try ObservationTranscript(protocolID: hex(protocolID), deviceID: hex(deviceID), publicKey: hex(publicKey),
                curve: curve, epoch: epoch, observationTimeMilliseconds: XCTUnwrap(UInt64(observationTimeMilliseconds)),
                challenges: challenges.map { c in
                    try ObservationTranscript.Challenge(nonce: hex(c.nonce), signature: hex(c.signature),
                        deviceTimestamp: XCTUnwrap(UInt64(c.deviceTimestamp)), deviceCounter: c.deviceCounter,
                        roundTripMilliseconds: c.roundTripMilliseconds, rssiDBM: c.rssiDBM)
                }, local: signals, evidenceHash: hex(evidenceHash), pseudonym: hex(pseudonym), nullifier: hex(nullifier), observerClass: observerClass)
        }
    }
}

private func hex(_ value: String) throws -> Data {
    guard value.hasPrefix("0x"), value.count % 2 == 0 else { throw ObservationTranscriptError.invalidEncoding }
    let text = Array(value.dropFirst(2)); var bytes = Data()
    for i in stride(from: 0, to: text.count, by: 2) {
        bytes.append(try XCTUnwrap(UInt8(String(text[i...i + 1]), radix: 16)))
    }
    return bytes
}

private struct TranscriptSecretStore: ObserverSecretStore {
    let secret: Data
    func load() throws -> Data? { secret }
    func insertIfAbsent(_ secret: Data) throws -> Bool { false }
}

final class ObservationTranscriptTests: XCTestCase {
    private func fixtures() throws -> TranscriptFixtures {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        return try JSONDecoder().decode(TranscriptFixtures.self,
            from: Data(contentsOf: root.appending(path: "fixtures/observations/transcript-v0.json")))
    }

    func testIndependentBorshVectorsAndHashMatchTypeScript() throws {
        let fixtures = try fixtures(); XCTAssertTrue(fixtures.publicTestVectors)
        for vector in fixtures.vectors {
            let t = try vector.transcript.value(), expected = try hex(vector.bytes)
            XCTAssertEqual(try t.encode(), expected, vector.name)
            XCTAssertEqual(try ObservationTranscript.decode(expected), t)
            XCTAssertEqual(try ObservationTranscript.decode((Data([255]) + expected).dropFirst()), t)
            XCTAssertEqual(try t.transcriptHash(), try hex(vector.hash))
            XCTAssertEqual(ObservationTranscript.hashEvidence(try vector.evidence.map(hex)), t.evidenceHash)
            XCTAssertNotEqual(try t.transcriptHash(), Data(SHA256.hash(data: expected)))
            var changed = t; changed.observationTimeMilliseconds ^= 1
            XCTAssertNotEqual(try changed.transcriptHash(), try t.transcriptHash())
        }
    }

    func testFiveInputNullifierMatchesCircomlibIncludingMaximumEpoch() throws {
        for vector in try fixtures().vectors {
            let t = try vector.transcript.value()
            let epoch = Data(repeating: 0, count: 28) + Data((0..<4).reversed().map { UInt8(truncatingIfNeeded: t.epoch >> ($0 * 8)) })
            XCTAssertEqual(try PoseidonCommitment.hashFive(ObservationEncoding.field(1), Data([0]) + hex(vector.secret),
                hex(vector.protocolField), hex(vector.deviceField), epoch), t.nullifier)
        }
    }

    func testVerifiedCaptureConversionUsesCredentialEnrollmentAndOriginalData() throws {
        let vectors = try fixtures().vectors
        for vector in vectors where vector.capture != nil {
            let capture = try XCTUnwrap(vector.capture), enrollment = try XCTUnwrap(vector.enrollment)
            let credential = try ObserverCredentialManager(store: TranscriptSecretStore(secret: hex(vector.secret))).loadOrCreate()
            let transcript = try ObservationTranscript(capture: capture, credential: credential, enrollment: enrollment)
            XCTAssertEqual(try transcript.encode(), try hex(vector.bytes))
            XCTAssertEqual(transcript.observationTimeMilliseconds, capture.observationTimeMilliseconds)
            XCTAssertEqual(transcript.challenges.map(\.nonce), capture.challenges.map(\.nonce))
            XCTAssertEqual(transcript.observerClass, UInt8(enrollment.observerClass))
            XCTAssertThrowsError(try ObservationTranscript(capture: capture, credential: credential, enrollment: enrollment, evidence: Data()))
            let other = vectors[vector.name == vectors[0].name ? 1 : 0]
            let otherCredential = try ObserverCredentialManager(store: TranscriptSecretStore(secret: hex(other.secret))).loadOrCreate()
            XCTAssertThrowsError(try ObservationTranscript(capture: capture, credential: otherCredential, enrollment: enrollment))
            XCTAssertThrowsError(try ObservationTranscript(capture: capture, credential: otherCredential, enrollment: XCTUnwrap(other.enrollment)))
        }
    }

    func testLatencySimulationPreservesSignedDeviceDataAndCredentialBindings() throws {
        let vector = try XCTUnwrap(fixtures().vectors.first(where: { $0.capture != nil }))
        let capture = try XCTUnwrap(vector.capture), enrollment = try XCTUnwrap(vector.enrollment)
        let credential = try ObserverCredentialManager(store: TranscriptSecretStore(secret: hex(vector.secret))).loadOrCreate()
        let original = try ObservationTranscript(capture: capture, credential: credential, enrollment: enrollment)
        let delayed = try ObservationLatencySimulation.transcript(capture: capture, credential: credential, enrollment: enrollment)
        XCTAssertGreaterThan(delayed.challenges.map(\.roundTripMilliseconds).sorted()[1], 400)
        var normalized = delayed
        for index in normalized.challenges.indices {
            normalized.challenges[index].roundTripMilliseconds -= 600
        }
        XCTAssertEqual(normalized, original)
        XCTAssertEqual(try ObservationTranscript.decode(delayed.encode()), delayed)
        XCTAssertNoThrow(try capture.validate())
        let witness = try ObservationWitness(transcript: delayed, credential: credential, enrollment: enrollment)
        XCTAssertEqual(witness.publicInputs, try ObservationWitness(transcript: original, credential: credential, enrollment: enrollment).publicInputs)
        var otherSecret = try hex(vector.secret); otherSecret[0] ^= 1
        let other = try ObserverCredentialManager(store: TranscriptSecretStore(secret: otherSecret)).loadOrCreate()
        XCTAssertThrowsError(try ObservationLatencySimulation.transcript(capture: capture, credential: other, enrollment: enrollment))
    }

    func testMalformedLengthsVersionTrailingDataAndFieldsFailClosed() throws {
        let vector = try XCTUnwrap(fixtures().vectors.first), bytes = try hex(vector.bytes)
        for count in 0..<bytes.count { XCTAssertThrowsError(try ObservationTranscript.decode(bytes.prefix(count))) }
        XCTAssertThrowsError(try ObservationTranscript.decode(bytes + Data([0])))
        for (offset, length) in [(0, 1), (110, 4), (490, 4)] {
            var malformed = bytes
            malformed.replaceSubrange(offset..<(offset + length), with: Data(repeating: 255, count: length))
            XCTAssertThrowsError(try ObservationTranscript.decode(malformed))
        }
        var t = try vector.transcript.value(); t.pseudonym = Data(repeating: 255, count: 32)
        XCTAssertThrowsError(try t.encode())
        t = try vector.transcript.value(); t.challenges[1].nonce = t.challenges[0].nonce
        XCTAssertThrowsError(try t.encode())
        t = try vector.transcript.value(); t.local.rssiSamples[0] = -128
        XCTAssertThrowsError(try t.encode())
        t = try vector.transcript.value(); t.observerClass = 0
        XCTAssertThrowsError(try t.encode())
    }

    func testAbsentEvidenceDiffersFromPresentEmptyEvidence() {
        XCTAssertEqual(ObservationTranscript.hashEvidence(nil), Data(repeating: 0, count: 32))
        XCTAssertEqual(ObservationTranscript.hashEvidence(Data()), Data(SHA256.hash(data: Data())))
        XCTAssertNotEqual(ObservationTranscript.hashEvidence(nil), ObservationTranscript.hashEvidence(Data()))
    }
}
