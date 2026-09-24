import CryptoKit
import Foundation
import PathnodDeviceProtocol
import XCTest

final class DeviceProtocolTests: XCTestCase {
    private func challenge(epoch: UInt32 = 0x01020304) throws -> DeviceProtocolV0.Challenge {
        try .init(nonce: Data(0..<32), observationEpoch: epoch, observationHint: Data(0xa0..<0xa8))
    }

    func testCanonicalChallengeAndSignedMessageEncoding() throws {
        let challenge = try challenge()
        let wire = challenge.wireData()
        XCTAssertEqual(wire.count, 44)
        XCTAssertEqual(Array(wire[32..<36]), [1, 2, 3, 4])
        XCTAssertEqual(try DeviceProtocolV0.Challenge(wireData: wire), challenge)
        let message = try DeviceProtocolV0.signedMessage(
            challenge: challenge, deviceTimestamp: 0x0102030405060708, deviceCounter: 0x090a0b0c
        )
        XCTAssertEqual(DeviceProtocolV0.signedMessageDomain.count, 20)
        XCTAssertEqual(message.count, 20 + 44 + 8 + 4 + 32)
        XCTAssertEqual(message.prefix(20), Data("Pathnod/challenge/v0".utf8))
        XCTAssertEqual(Array(message[64..<72]), [1, 2, 3, 4, 5, 6, 7, 8])
        XCTAssertEqual(Array(message[72..<76]), [9, 10, 11, 12])
        XCTAssertEqual(message.suffix(32), Data(repeating: 0, count: 32))
    }

    func testSignatureVerifiesOnlyForMatchingChallenge() throws {
        let key = Curve25519.Signing.PrivateKey()
        let original = try challenge()
        let signature = try DeviceProtocolV0.sign(
            challenge: original, deviceTimestamp: 42, deviceCounter: 7, using: key
        )
        XCTAssertEqual(signature.count, 64)
        XCTAssertTrue(try DeviceProtocolV0.verify(
            signature: signature, challenge: original, deviceTimestamp: 42,
            deviceCounter: 7, publicKey: key.publicKey
        ))
        XCTAssertFalse(try DeviceProtocolV0.verify(
            signature: signature, challenge: challenge(epoch: 8), deviceTimestamp: 42,
            deviceCounter: 7, publicKey: key.publicKey
        ))
        XCTAssertFalse(try DeviceProtocolV0.verify(
            signature: signature, challenge: original, deviceTimestamp: 43,
            deviceCounter: 7, publicKey: key.publicKey
        ))
        let response = try DeviceProtocolV0.response(
            signature: signature, deviceTimestamp: 42, deviceCounter: 7
        )
        XCTAssertEqual(response.count, DeviceProtocolV0.responseHeaderLength)
        XCTAssertEqual(Array(response.suffix(2)), [0, 0])
    }

    func testMalformedChallengeLengthsAreRejected() throws {
        for length in [0, 1, 43, 45, 100] {
            XCTAssertThrowsError(try DeviceProtocolV0.Challenge(wireData: Data(repeating: 0, count: length))) {
                XCTAssertEqual($0 as? DeviceProtocolV0.EncodingError, .invalidChallengeLength)
            }
        }
        XCTAssertThrowsError(try DeviceProtocolV0.Challenge(
            nonce: Data(repeating: 0, count: 31), observationEpoch: 0,
            observationHint: Data(repeating: 0, count: 8)
        ))
    }

    func testChallengeFragmentsAreAssembledBeforeValidation() throws {
        let expected = try challenge()
        let wireData = expected.wireData()

        XCTAssertEqual(try DeviceProtocolV0.Challenge(fragments: [
            .init(offset: 0, value: wireData)
        ]), expected)
        XCTAssertEqual(try DeviceProtocolV0.Challenge(fragments: [
            .init(offset: 20, value: wireData.subdata(in: 20..<44)),
            .init(offset: 0, value: wireData.subdata(in: 0..<20))
        ]), expected)
    }

    func testIncompleteOrOverlappingChallengeFragmentsAreRejected() throws {
        let wireData = try challenge().wireData()
        let invalid: [[DeviceProtocolV0.ChallengeFragment]] = [
            [],
            [.init(offset: 0, value: wireData.subdata(in: 0..<43))],
            [.init(offset: 0, value: wireData), .init(offset: 0, value: Data([0]))],
            [.init(offset: -1, value: wireData)],
            [.init(offset: 1, value: wireData)],
            [.init(offset: 44, value: Data([0]))],
            [.init(offset: 0, value: Data())],
        ]

        for fragments in invalid {
            XCTAssertThrowsError(try DeviceProtocolV0.Challenge(fragments: fragments)) {
                XCTAssertEqual($0 as? DeviceProtocolV0.EncodingError, .invalidChallengeFragments)
            }
        }
    }

    func testInfoHasCanonicalLayout() throws {
        let key = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let info = try DeviceProtocolV0.info(publicKey: key)
        XCTAssertEqual(info.count, 70)
        XCTAssertEqual(Array(info.prefix(2)), [0, 1])
        XCTAssertEqual(info.subdata(in: 2..<34), key)
        XCTAssertEqual(info.suffix(36), Data(repeating: 0, count: 36))
    }
}
