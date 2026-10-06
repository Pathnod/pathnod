import Foundation

public enum ObserverMerklePathError: Error { case invalidResponse }

public struct ObserverMerklePath: Decodable {
    public let commitment: String
    public let observerClass: Int
    public let leaf: String
    public let leafIndex: Int
    public let siblings: [String]
    public let directions: [Int]
    public let root: String
    public let rootRevision: Int

    public func validate(expectedCommitment: String) throws {
        do {
            func decode(_ value: String) throws -> Data {
                guard value.count == 66, value.hasPrefix("0x"), value.dropFirst(2).allSatisfy({ "0123456789abcdef".contains($0) }) else {
                    throw ObserverMerklePathError.invalidResponse
                }
                let text = value.dropFirst(2)
                var bytes = Data(); var cursor = text.startIndex
                for _ in 0..<32 {
                    let next = text.index(cursor, offsetBy: 2)
                    guard let byte = UInt8(text[cursor..<next], radix: 16) else { throw ObserverMerklePathError.invalidResponse }
                    bytes.append(byte); cursor = next
                }
                guard PoseidonCommitment.isCanonicalField(bytes) else { throw ObserverMerklePathError.invalidResponse }
                return bytes
            }
            guard commitment == expectedCommitment, observerClass == 1, leafIndex >= 0, leafIndex < 1 << 20,
                  rootRevision > 0, siblings.count == 20, directions.count == 20,
                  directions.enumerated().allSatisfy({ $0.element == ((leafIndex >> $0.offset) & 1) }) else {
                throw ObserverMerklePathError.invalidResponse
            }
            let committed = try decode(commitment), expectedLeaf = try decode(leaf), expectedRoot = try decode(root)
            let path = try siblings.map(decode)
            let hardwareClass = Data(repeating: 0, count: 31) + Data([UInt8(observerClass)])
            var current = try PoseidonCommitment.hashTwo(committed, hardwareClass)
            guard current == expectedLeaf else { throw ObserverMerklePathError.invalidResponse }
            for level in 0..<20 {
                current = directions[level] == 0 ? try PoseidonCommitment.hashTwo(current, path[level]) :
                    try PoseidonCommitment.hashTwo(path[level], current)
            }
            guard current == expectedRoot else { throw ObserverMerklePathError.invalidResponse }
        } catch { throw ObserverMerklePathError.invalidResponse }
    }
}
