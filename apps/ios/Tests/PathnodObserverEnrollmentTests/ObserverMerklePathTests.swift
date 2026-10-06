import Foundation
import PathnodObserverEnrollment
import XCTest

final class ObserverMerklePathTests: XCTestCase {
    func testScalarModulusIsExcluded() throws {
        let hex = "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001"
        var bytes = Data(); var cursor = hex.startIndex
        for _ in 0..<32 { let next = hex.index(cursor, offsetBy: 2); bytes.append(try XCTUnwrap(UInt8(hex[cursor..<next], radix: 16))); cursor = next }
        XCTAssertFalse(PoseidonCommitment.isCanonicalField(bytes))
        bytes[31] -= 1
        XCTAssertTrue(PoseidonCommitment.isCanonicalField(bytes))
    }
    private func fixture() throws -> [String: Any] {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appending(path: "fixtures/poseidon/observer-merkle-path-v0.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    private func decode(_ object: [String: Any]) throws -> ObserverMerklePath {
        try JSONDecoder().decode(ObserverMerklePath.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testValidSharedPathRecomputesToItsRoot() throws {
        let value = try fixture(), path = try decode(value)
        XCTAssertNoThrow(try path.validate(expectedCommitment: path.commitment))
    }

    func testNoncanonicalFieldValuesAreRejectedInEveryPosition() throws {
        let bad = "0x" + String(repeating: "ff", count: 32)
        for name in ["commitment", "leaf", "root", "siblings"] {
            var value = try fixture()
            if name == "siblings" { var siblings = try XCTUnwrap(value[name] as? [String]); siblings[0] = bad; value[name] = siblings }
            else { value[name] = bad }
            let path = try decode(value)
            XCTAssertThrowsError(try path.validate(expectedCommitment: path.commitment))
        }
    }

    func testModifiedSiblingLeafRootAndDirectionsAreRejected() throws {
        for name in ["leaf", "root", "siblings", "directions"] {
            var value = try fixture()
            if name == "siblings" { var values = try XCTUnwrap(value[name] as? [String]); values[0] = "0x" + String(repeating: "0", count: 63) + "1"; value[name] = values }
            else if name == "directions" { var values = try XCTUnwrap(value[name] as? [Int]); values[0] = 1; value[name] = values }
            else { value[name] = "0x" + String(repeating: "0", count: 64) }
            let path = try decode(value)
            XCTAssertThrowsError(try path.validate(expectedCommitment: path.commitment))
        }
    }
}
