import CryptoKit
import Foundation
import XCTest
import PathnodChallengeCore
import PathnodObserverEnrollment
@testable import PathnodObservationCore

final class ObservationCoreTests: XCTestCase {
    func testClockBoundsAndTooFewSignalsFailClosed() throws {
        XCTAssertThrowsError(try ObservationEncoding.timeMilliseconds(Date(timeIntervalSince1970: -1)))
        XCTAssertThrowsError(try ObservationEncoding.epoch(at: 1_000, seconds: 0))
        XCTAssertThrowsError(try ObservationLocalSignals().validate())
        var signals = ObservationLocalSignals()
        signals.setLocation(latitude: .nan, longitude: 0, accuracy: 10)
        signals.setPressure(kilopascals: .infinity)
        XCTAssertEqual(signals.geohash6, Data(repeating: 0, count: 6))
        XCTAssertEqual(signals.barometerHPATimes10, 0)
    }
    func testCircomlibContextAndFieldVectors() throws {
        struct ContextVector: Decodable { let secret: String; let protocolID: String; let pseudonym: String; let hint: String }
        struct Triple: Decodable { let inputs: [String]; let output: String }
        struct Vectors: Decodable { let contexts: [ContextVector]; let triples: [Triple] }
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let file = root.appending(path: "fixtures/poseidon/observer-context-v0.json")
        let vectors = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: file))
        for vector in vectors.contexts {
            let secret = try ObservationEncoding.id("0x00" + vector.secret.dropFirst(2)).dropFirst()
            let context = try ObservationContext(protocolID: ObservationEncoding.id(vector.protocolID), secret: secret,
                                                  timeMilliseconds: 1_000_000, epochSeconds: 60)
            XCTAssertEqual(ObservationEncoding.hex(context.pseudonym), vector.pseudonym)
            XCTAssertEqual(ObservationEncoding.hex(context.observationHint), vector.hint)
        }
        for vector in vectors.triples {
            let inputs = try vector.inputs.map(ObservationEncoding.id)
            XCTAssertEqual(ObservationEncoding.hex(try PoseidonCommitment.hashThree(inputs[0], inputs[1], inputs[2])), vector.output)
        }
    }

    func testLocalSignalsAreCoarseBoundedAndOptional() throws {
        var local = ObservationLocalSignals()
        for value in [127, -128, -70, -71, -69, -72, -68] { local.addRSSI(value) }
        XCTAssertEqual(local.rssiSamples.count, 5)
        XCTAssertEqual(local.geohash6, Data(repeating: 0, count: 6))
        try local.validate()
        local.setLocation(latitude: 42.6, longitude: -5.6, accuracy: 15.2)
        XCTAssertEqual(String(data: local.geohash6, encoding: .ascii), "ezs42e")
        XCTAssertEqual(local.gpsAccuracyMeters, 16)
        local.setPressure(kilopascals: 101.325)
        XCTAssertEqual(local.barometerHPATimes10, 10133)
        for _ in 0..<30 { local.addRSSI(-65) }
        XCTAssertEqual(local.rssiSamples.count, 20)
        try local.validate()
    }

    func testRealEpochAndProtocolPseudonym() throws {
        let secret = Data(repeating: 7, count: 31), protocolID = Data(repeating: 1, count: 32)
        let first = try ObservationContext(protocolID: protocolID, secret: secret, timeMilliseconds: 1_000_000, epochSeconds: 60)
        let later = try ObservationContext(protocolID: protocolID, secret: secret, timeMilliseconds: 2_000_000, epochSeconds: 60)
        XCTAssertEqual(first.epoch, 16)
        XCTAssertEqual(first.pseudonym, later.pseudonym)
        XCTAssertEqual(first.observationHint, first.pseudonym.prefix(8))
        let other = try ObservationContext(protocolID: Data(repeating: 2, count: 32), secret: secret, timeMilliseconds: 1_000_000, epochSeconds: 60)
        XCTAssertNotEqual(first.pseudonym, other.pseudonym)
    }

    func testCompletedCaptureSurvivesReloadAndCacheScopesAreDistinct() throws {
        let key = Curve25519.Signing.PrivateKey()
        let info = try DeviceProtocolV0.Info(wireData: Data([0, 1]) + key.publicKey.rawRepresentation +
            Data([0, 0, 0, 2]) + Data(repeating: 0, count: 32))
        let time = UInt64(Date().timeIntervalSince1970 * 1000)
        let context = try ObservationContext(protocolID: Data(repeating: 1, count: 32), secret: Data(repeating: 3, count: 31),
                                             timeMilliseconds: time, epochSeconds: 604800)
        var session = ChallengeSession(info: info)
        for attempt in 1...3 {
            let nonce = Data(repeating: UInt8(attempt), count: 32)
            _ = try session.beginChallenge(nonce: nonce, observationEpoch: context.epoch, observationHint: context.observationHint,
                                           startedAt: Double(attempt * 3))
            let challenge = try DeviceProtocolV0.Challenge(nonce: nonce, observationEpoch: context.epoch, observationHint: context.observationHint)
            var trailer = Data(repeating: 0, count: 8)
            trailer.append(contentsOf: [0, 0, 0, UInt8(attempt), 0, 0])
            let unsigned = try DeviceProtocolV0.Response(wireData: Data(repeating: 0, count: 64) + trailer)
            let signature = try key.signature(for: Data(SHA256.hash(data: DeviceProtocolV0.signedMessage(challenge: challenge, response: unsigned))))
            _ = try session.receive(signature + trailer, at: Double(attempt * 3) + 0.05, via: .notification)
        }
        var signals = ObservationLocalSignals(); for _ in 0..<5 { signals.addRSSI(-60) }
        let capture = try ObservationCapture(info: info, context: context, results: session.results, challengeRSSI: [-60, -61, -62],
                                              local: signals, durationMilliseconds: 4_800)
        let dir = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appending(path: "sessions.json")
        let cacheKey = try ObservationCacheKey(commitment: Data(repeating: 5, count: 32), protocolID: context.protocolID,
                                              deviceID: info.deviceID, epoch: context.epoch)
        try FileObservationCache(url: url).save(capture, for: cacheKey)
        let restored = try XCTUnwrap(FileObservationCache(url: url).completed(for: cacheKey))
        XCTAssertEqual(restored.challenges.count, 3)
        XCTAssertEqual(restored.challenges[0].response, capture.challenges[0].response)
        let next = try ObservationCacheKey(commitment: Data(repeating: 5, count: 32), protocolID: context.protocolID,
                                          deviceID: info.deviceID, epoch: context.epoch + 1)
        XCTAssertNil(try FileObservationCache(url: url).completed(for: next))
        let other = try ObservationCacheKey(commitment: Data(repeating: 6, count: 32), protocolID: context.protocolID,
                                           deviceID: info.deviceID, epoch: context.epoch)
        XCTAssertNotEqual(cacheKey, other)
    }
}
