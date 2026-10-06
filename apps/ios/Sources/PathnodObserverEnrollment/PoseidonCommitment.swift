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
        self = Self.montgomery(value, Self.rSquared)
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
    private static let rSquared = Field(unchecked: [
        0x1bb8e645ae216da7, 0x53fe3ab1e35c59e3, 0x8c49833d53bb8085, 0x0216d0b17f4e44a5,
    ])

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
        montgomery(lhs, rhs)
    }

    // Four-limb Montgomery reduction keeps multiplication bounded without
    // the 256-bit repeated-doubling loop used by the initial commitment spike.
    private static func montgomery(_ lhs: Field, _ rhs: Field) -> Field {
        var words = [UInt64](repeating: 0, count: 9)
        func add(_ value: UInt64, at index: Int) {
            var position = index, carry = value
            while carry != 0 {
                let (sum, overflow) = words[position].addingReportingOverflow(carry)
                words[position] = sum; carry = overflow ? 1 : 0; position += 1
            }
        }
        for i in 0..<4 {
            for j in 0..<4 {
                let product = lhs.limbs[i].multipliedFullWidth(by: rhs.limbs[j])
                add(product.low, at: i + j); add(product.high, at: i + j + 1)
            }
        }
        for i in 0..<4 {
            let factor = words[i] &* 0xc2e1f593efffffff
            for j in 0..<4 {
                let product = factor.multipliedFullWidth(by: modulus.limbs[j])
                add(product.low, at: i + j); add(product.high, at: i + j + 1)
            }
        }
        let result = Field(unchecked: Array(words[4..<8]))
        return result < modulus ? result : result.subtracting(modulus)
    }

    func fifthPower() -> Field {
        let square = self * self
        return square * square * self
    }

    var bytes: Data {
        var result = Data()
        let canonical = Self.montgomery(self, Field(unchecked: [1, 0, 0, 0]))
        for word in canonical.limbs.reversed() {
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
        try hash([input])
    }

    public static func hashTwo(_ first: Data, _ second: Data) throws -> Data {
        try hash([first, second])
    }

    public static func hashThree(_ first: Data, _ second: Data, _ third: Data) throws -> Data {
        try hash([first, second, third])
    }

    public static func isCanonicalField(_ bytes: Data) -> Bool {
        (try? Field(bytes: bytes)) != nil
    }

    private static func hash(_ inputs: [Data]) throws -> Data {
        let width = inputs.count + 1
        let rounds = inputs.count == 2 ? 65 : 64
        guard let url = Bundle.module.url(forResource: "poseidon-t\(width)", withExtension: "json"),
              let parameters = try? JSONDecoder().decode(PoseidonParameters.self, from: Data(contentsOf: url)),
              parameters.parameterSet == "circom-bn254-x5",
              parameters.arity == inputs.count,
              parameters.roundConstants.count == rounds * width,
              parameters.mds.count == width,
              parameters.mds.allSatisfy({ $0.count == width }) else {
            throw ObserverCommitmentError.unavailableParameters
        }
        let constants = try parameters.roundConstants.map(Field.init(hex:))
        let matrix = try parameters.mds.map { try $0.map(Field.init(hex:)) }
        var state = [Field.zero] + (try inputs.map(Field.init(bytes:)))
        for round in 0..<rounds {
            for index in 0..<width {
                state[index] = state[index] + constants[round * width + index]
                if index == 0 || round < 4 || round >= rounds - 4 { state[index] = state[index].fifthPower() }
            }
            state = matrix.map { row in
                zip(row, state).reduce(Field.zero) { $0 + $1.0 * $1.1 }
            }
        }
        return state[0].bytes
    }
}
