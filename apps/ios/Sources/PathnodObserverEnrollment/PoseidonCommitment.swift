import Foundation

public enum ObserverCommitmentError: Error, Equatable {
    case invalidFieldElement
    case unavailableParameters
}

private struct Field: Equatable {
    private static let modulus = Field(unchecked: [
        0x43e1f593f0000001, 0x2833e84879b97091,
        0xb85045b68181585d, 0x30644e72e131a029,
    ])

    private let limbs: [UInt64]

    private init(unchecked limbs: [UInt64]) { self.limbs = limbs }

    init(bytes: Data) throws {
        guard bytes.count == 32 else { throw ObserverCommitmentError.invalidFieldElement }
        let octets = Array(bytes)
        var words = [UInt64](repeating: 0, count: 4)
        for index in 0..<32 {
            let word = (31 - index) / 8
            words[word] |= UInt64(octets[index]) << (((31 - index) % 8) * 8)
        }
        let value = Field(unchecked: words)
        guard value < Self.modulus else { throw ObserverCommitmentError.invalidFieldElement }
        self = value
    }

    init(hex: String) throws {
        guard hex.hasPrefix("0x"), hex.count == 66 else {
            throw ObserverCommitmentError.unavailableParameters
        }
        var bytes = Data()
        var cursor = hex.index(hex.startIndex, offsetBy: 2)
        for _ in 0..<32 {
            let next = hex.index(cursor, offsetBy: 2)
            guard let byte = UInt8(hex[cursor..<next], radix: 16) else {
                throw ObserverCommitmentError.unavailableParameters
            }
            bytes.append(byte)
            cursor = next
        }
        try self.init(bytes: bytes)
    }

    static let zero = Field(unchecked: [0, 0, 0, 0])

    static func < (lhs: Field, rhs: Field) -> Bool {
        for index in (0..<4).reversed() {
            if lhs.limbs[index] != rhs.limbs[index] {
                return lhs.limbs[index] < rhs.limbs[index]
            }
        }
        return false
    }

    static func + (lhs: Field, rhs: Field) -> Field {
        var sum = [UInt64](repeating: 0, count: 4)
        var carry = false
        for index in 0..<4 {
            let (partial, overflowA) = lhs.limbs[index].addingReportingOverflow(rhs.limbs[index])
            let (value, overflowB) = partial.addingReportingOverflow(carry ? 1 : 0)
            sum[index] = value
            carry = overflowA || overflowB
        }
        let result = Field(unchecked: sum)
        return result < modulus ? result : result.subtracting(modulus)
    }

    private func subtracting(_ other: Field) -> Field {
        var result = [UInt64](repeating: 0, count: 4)
        var borrow = false
        for index in 0..<4 {
            let (partial, underflowA) = limbs[index].subtractingReportingOverflow(other.limbs[index])
            let (value, underflowB) = partial.subtractingReportingOverflow(borrow ? 1 : 0)
            result[index] = value
            borrow = underflowA || underflowB
        }
        return Field(unchecked: result)
    }

    static func * (lhs: Field, rhs: Field) -> Field {
        var result = Field.zero
        var addend = lhs
        for word in rhs.limbs {
            var bits = word
            for _ in 0..<64 {
                if bits & 1 == 1 { result = result + addend }
                bits >>= 1
                addend = addend + addend
            }
        }
        return result
    }

    func fifthPower() -> Field {
        let square = self * self
        return square * square * self
    }

    var bytes: Data {
        var result = Data()
        for word in limbs.reversed() {
            for shift in stride(from: 56, through: 0, by: -8) {
                result.append(UInt8(truncatingIfNeeded: word >> shift))
            }
        }
        return result
    }
}

private struct PoseidonParameters: Decodable {
    let parameterSet: String
    let arity: Int
    let roundConstants: [String]
    let mds: [[String]]
}

public enum PoseidonCommitment {
    public static func hashOne(_ input: Data) throws -> Data {
        let value = try Field(bytes: input)
        guard let url = Bundle.module.url(forResource: "poseidon-t2", withExtension: "json"),
              let parameters = try? JSONDecoder().decode(PoseidonParameters.self, from: Data(contentsOf: url)),
              parameters.parameterSet == "circom-bn254-x5",
              parameters.arity == 1,
              parameters.roundConstants.count == 128,
              parameters.mds.count == 2,
              parameters.mds.allSatisfy({ $0.count == 2 }) else {
            throw ObserverCommitmentError.unavailableParameters
        }
        let constants = try parameters.roundConstants.map(Field.init(hex:))
        let matrix = try parameters.mds.map { try $0.map(Field.init(hex:)) }
        var state = [Field.zero, value]
        for round in 0..<64 {
            state[0] = state[0] + constants[round * 2]
            state[1] = state[1] + constants[round * 2 + 1]
            state[0] = state[0].fifthPower()
            if round < 4 || round >= 60 { state[1] = state[1].fifthPower() }
            let next0 = matrix[0][0] * state[0] + matrix[0][1] * state[1]
            let next1 = matrix[1][0] * state[0] + matrix[1][1] * state[1]
            state = [next0, next1]
        }
        return state[0].bytes
    }
}
