import CryptoKit
import Foundation

public enum PayoutError: Error { case invalidClaim, untrustedMessage, invalidBalance }

public enum WithdrawalTransactionStatus: Sendable { case absent, failed, pending, finalized }
public enum WithdrawalRecoveryAction: Equatable, Sendable { case completed, retry, wait, replace }

/// Replacement requires finalized block height AND a freshly reconciled payout nonce.
/// Missing validity metadata (older saved withdrawals) never permits replacement.
public enum WithdrawalRecovery {
    public static func action(status: WithdrawalTransactionStatus, finalizedHeight: UInt64,
                              lastValidBlockHeight: UInt64?, savedNonce: UInt64,
                              finalizedNonce: UInt64) throws -> WithdrawalRecoveryAction {
        guard finalizedNonce >= savedNonce else { throw PayoutError.invalidBalance }
        if finalizedNonce > savedNonce { return .completed }
        if status == .pending || status == .finalized { return .wait }
        guard let boundary = lastValidBlockHeight else { return .wait }
        if finalizedHeight > boundary { return .replace }
        return status == .failed ? .wait : .retry
    }
}

public struct PayoutBalance: Codable, Sendable {
    public let status: String
    public let network: String
    public let program: String
    public let protocolID: String
    public let pseudonym: String
    public let payout: String
    public let mint: String
    public let withdrawalKey: String
    public let gross: String
    public let fees: String
    public let available: String
    public let withdrawn: String
    public let nonce: String
    enum CodingKeys: String, CodingKey {
        case status, network, program, pseudonym, payout, mint, gross, fees, available, withdrawn, nonce
        case protocolID = "protocol", withdrawalKey = "withdrawal_key"
    }
    public func validate(program expectedProgram: String, pseudonym expectedPseudonym: String) throws {
        guard network == "devnet", program == expectedProgram, pseudonym == expectedPseudonym,
              mint == "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
              ["pending", "finalized"].contains(status) else { throw PayoutError.invalidBalance }
        let g = try Self.baseUnits(gross), f = try Self.baseUnits(fees), a = try Self.baseUnits(available), w = try Self.baseUnits(withdrawn)
        guard f <= g, a <= g - f, w == g - f - a else { throw PayoutError.invalidBalance }
    }
    public static func baseUnits(_ value: String) throws -> UInt64 {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[1].count == 6,
              parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy { $0.isASCII && $0.isNumber } }),
              let whole = UInt64(parts[0]), let fraction = UInt64(parts[1]), whole <= UInt64.max / 1_000_000 else {
            throw PayoutError.invalidBalance
        }
        let (result, overflow) = (whole * 1_000_000).addingReportingOverflow(fraction)
        guard !overflow else { throw PayoutError.invalidBalance }; return result
    }
}

public struct PayoutAuthorization: Codable, Equatable, Sendable {
    public let program: String
    public let payout: String
    public let mint: String
    public let withdrawalKey: String
    public let destination: String
    public let amount: String
    public let nonce: String
    public let expiresAt: String
    public let policyVersion: UInt32

    public func digest() throws -> Data {
        guard let amount = UInt64(amount), amount > 0, let nonce = UInt64(nonce),
              let expiry = UInt64(expiresAt), expiry <= UInt64(Int64.max), policyVersion > 0 else { throw PayoutError.invalidClaim }
        var data = Data("Pathnod/claim/v0".utf8)
        for key in [program, payout, mint, withdrawalKey, destination] { data += try SolanaBase58.decode32(key) }
        for number in [amount, nonce, expiry] { data += Self.littleEndian(number) }
        var policy = policyVersion.littleEndian
        data += withUnsafeBytes(of: &policy) { Data($0) }
        return Data(SHA256.hash(data: data))
    }
    private static func littleEndian(_ value: UInt64) -> Data {
        var little = value.littleEndian; return withUnsafeBytes(of: &little) { Data($0) }
    }
    /// Sign only an exact legacy Ed25519+claim transaction, never arbitrary server-provided bytes.
    public func signedWire(message: Data, verifier: String, signature: Data,
                           privateKey: Curve25519.Signing.PrivateKey, expectedProgram: String, now: UInt64) throws -> Data {
        guard program == expectedProgram, mint == "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
              try SolanaBase58.decode32(withdrawalKey) == privateKey.publicKey.rawRepresentation,
              let expiry = UInt64(expiresAt), expiry >= now, expiry <= now + 300,
              signature.count == 64 else { throw PayoutError.invalidClaim }
        let digest = try digest(), verifierBytes = try SolanaBase58.decode32(verifier)
        guard try Curve25519.Signing.PublicKey(rawRepresentation: verifierBytes).isValidSignature(signature, for: digest) else { throw PayoutError.invalidClaim }
        var reader = MessageReader(bytes: Array(message))
        guard try reader.take(3) == [1, 0, 6] else { throw PayoutError.untrustedMessage }
        let keyCount = try reader.short()
        guard keyCount == 10 else { throw PayoutError.untrustedMessage }
        var keys: [Data] = []
        for _ in 0..<keyCount { keys.append(Data(try reader.take(32))) }
        guard keys[0] == privateKey.publicKey.rawRepresentation else { throw PayoutError.untrustedMessage }
        _ = try reader.take(32) // recent blockhash; only its expiry affects this permitted claim
        guard try reader.short() == 2 else { throw PayoutError.untrustedMessage }
        let ed = try reader.instruction(), claim = try reader.instruction()
        guard reader.offset == message.count,
              ed.accounts.isEmpty, ed.program < keys.count, claim.program < keys.count,
              keys[ed.program] == (try SolanaBase58.decode32("Ed25519SigVerify111111111111111111111111111")),
              keys[claim.program] == (try SolanaBase58.decode32(program)),
              ed.data == Data([1,0,48,0,255,255,16,0,255,255,112,0,32,0,255,255]) + verifierBytes + signature + digest,
              claim.accounts.count == 8, claim.accounts.allSatisfy({ $0 < keys.count }) else { throw PayoutError.untrustedMessage }
        let accounts = claim.accounts.map { keys[$0] }
        guard accounts[1] == (try SolanaBase58.decode32(payout)), accounts[2] == (try SolanaBase58.decode32(mint)),
              accounts[4] == (try SolanaBase58.decode32(destination)), accounts[5] == privateKey.publicKey.rawRepresentation,
              accounts[6] == (try SolanaBase58.decode32("Sysvar1nstructions1111111111111111111111111")),
              accounts[7] == (try SolanaBase58.decode32("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")),
              claim.accounts[1] < 4, claim.accounts[3] < 4, claim.accounts[4] < 4,
              [claim.accounts[0],claim.accounts[2],claim.accounts[6],claim.accounts[7],claim.program,ed.program].allSatisfy({ $0 >= 4 }),
              Set(claim.accounts + [ed.program,claim.program]).count == 10 else { throw PayoutError.untrustedMessage }
        let expected = Data(SHA256.hash(data: Data("global:claim_payout".utf8)).prefix(8)) +
            Self.littleEndian(UInt64(amount)!) + Self.littleEndian(UInt64(nonce)!) + Self.littleEndian(expiry)
        guard claim.data == expected else { throw PayoutError.untrustedMessage }
        return Data([1]) + (try privateKey.signature(for: message)) + message
    }
}

private struct MessageReader {
    let bytes: [UInt8]
    var offset = 0
    mutating func take(_ count: Int) throws -> [UInt8] {
        guard count >= 0, offset + count <= bytes.count else { throw PayoutError.untrustedMessage }
        defer { offset += count }; return Array(bytes[offset..<(offset+count)])
    }
    mutating func short() throws -> Int {
        var result = 0
        for shift in [0,7,14] {
            let byte = try take(1)[0]; result |= Int(byte & 127) << shift
            if byte & 128 == 0 { guard shift == 0 || byte > 0 else { throw PayoutError.untrustedMessage }; return result }
        }
        throw PayoutError.untrustedMessage
    }
    mutating func instruction() throws -> (program: Int, accounts: [Int], data: Data) {
        let program = Int(try take(1)[0]), count = try short()
        let accounts = try take(count).map(Int.init), size = try short()
        return (program,accounts,Data(try take(size)))
    }
}

public enum SolanaBase58 {
    private static let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".utf8)
    public static func decode32(_ text: String) throws -> Data {
        guard !text.isEmpty, text.count <= 44 else { throw PayoutError.invalidClaim }
        var bytes = [UInt8](repeating: 0, count: 32)
        for char in text.utf8 {
            guard let index = alphabet.firstIndex(of: char) else { throw PayoutError.invalidClaim }
            var carry = index
            for i in bytes.indices.reversed() { carry += Int(bytes[i]) * 58; bytes[i] = UInt8(carry & 255); carry >>= 8 }
            guard carry == 0 else { throw PayoutError.invalidClaim }
        }
        let data = Data(bytes)
        guard encode(data) == text else { throw PayoutError.invalidClaim }; return data
    }
    public static func encode(_ data: Data) -> String {
        var digits = [Int](repeating: 0, count: data.count * 138 / 100 + 1)
        for byte in data { var carry = Int(byte); for i in digits.indices.reversed() { carry += digits[i] * 256; digits[i] = carry % 58; carry /= 58 } }
        let zeroes = data.prefix(while: { $0 == 0 }).count
        return String(repeating: "1", count: zeroes) + String(bytes: digits.drop(while: { $0 == 0 }).map { alphabet[$0] }, encoding: .ascii)!
    }
}
