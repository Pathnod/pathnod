import CryptoKit
import Foundation
import PathnodAppAttest
import PathnodObservationCore
import PathnodObserverEnrollment
import Security
import SwiftUI

@MainActor
struct EarningsView: View {
    @AppStorage("observerEnrollmentServerURL") private var server = ""
    @AppStorage("payoutProgramV0") private var program = ""
    @AppStorage("payoutProtocolV0") private var protocolID = ""
    @State private var destination = ""
    @State private var balance: PayoutBalance?
    @State private var address = ""
    @State private var status = "Refresh to read finalized balances."
    @State private var busy = false
    @State private var consent = false
    private let rpc = URL(string: "https://api.devnet.solana.com")!

    var body: some View {
        List {
            Section("Devnet test assets only") {
                Text("These USDC have no monetary value. A validated observation is not a payment. Only finalized payout accounts are shown below.")
                TextField("Deployment program ID", text: $program)
                TextField("Protocol ID (32-byte hex)", text: $protocolID)
                Button("Refresh gains") { run { try await refresh() } }
            }
            if let balance {
                Section(balance.status == "pending" ? "Pending registration" : "Finalized gains") {
                    LabeledContent("Gross USDC", value: balance.gross)
                    LabeledContent("Pathnod fees USDC", value: balance.fees)
                    LabeledContent("Available USDC", value: balance.available)
                    LabeledContent("Withdrawn USDC", value: balance.withdrawn)
                }
            }
            Section("Withdrawal key — this device") {
                Text(address).font(.caption.monospaced()).textSelection(.enabled)
                Text("Fund this address with devnet SOL for transaction fees and create a devnet USDC token account owned by it. Paste that token account below. The private key stays in this device's Keychain; deleting it loses access to withdrawals.")
                    .font(.footnote)
                TextField("Destination USDC token account", text: $destination)
                Toggle("I understand the wallet–pseudonym link is public in v0", isOn: $consent)
                Button("Withdraw available devnet USDC") { run { try await withdraw() } }
                    .disabled(!consent || destination.isEmpty || balance?.status != "finalized")
                Button("Reconcile / retry saved withdrawal") { run { try await retrySaved() } }
            }
            Section("Status") { Text(status).accessibilityIdentifier("earningsStatus") }
        }
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .disabled(busy)
        .navigationTitle("Devnet gains")
    }
    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }; busy = true
        Task { defer { busy = false }; do { try await action() } catch { status = "Withdrawal not confirmed: \(error.localizedDescription). Refresh or retry saved bytes; do not assume payment." } }
    }
    private func identity() throws -> (pseudonym: String, key: Curve25519.Signing.PrivateKey, pending: URL) {
        _ = try SolanaBase58.decode32(program)
        let protocolBytes = try ObservationEncoding.id(protocolID)
        let context = try ObservationContext(protocolID: protocolBytes, secret: ObserverCredentialManager().loadOrCreate().secretBytes,
            timeMilliseconds: 0, epochSeconds: 604800)
        let pseudonym = context.pseudonym.map { String(format: "%02x", $0) }.joined()
        // The withdrawal identity must survive verifier URL changes.
        let namespace = Data(SHA256.hash(data: Data("\(program)/\(pseudonym)".utf8))).map { String(format: "%02x", $0) }.joined()
        let query: [CFString: Any] = [kSecClass:kSecClassGenericPassword,kSecAttrService:"xyz.pathnod.withdrawal.v0",kSecAttrAccount:namespace]
        var read = query; read[kSecReturnData] = true; read[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?; let code = SecItemCopyMatching(read as CFDictionary,&result)
        let key: Curve25519.Signing.PrivateKey
        if code == errSecItemNotFound {
            key = Curve25519.Signing.PrivateKey()
            var insert = query; insert[kSecValueData] = key.rawRepresentation
            insert[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(insert as CFDictionary,nil) == errSecSuccess else { throw PayoutError.invalidClaim }
        } else {
            guard code == errSecSuccess, let data = result as? Data else { throw PayoutError.invalidClaim }
            key = try Curve25519.Signing.PrivateKey(rawRepresentation:data)
        }
        guard let support = FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask).first else { throw PayoutError.invalidClaim }
        let folder = support.appending(path:"Pathnod/withdrawals")
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
        return (pseudonym,key,folder.appending(path:namespace+".json"))
    }
    private func request<T: Decodable>(_ path: String, body: [String:String]? = nil) async throws -> T {
        guard let base = URL(string:server), let host = base.host, base.user == nil, base.password == nil, base.query == nil, base.fragment == nil else { throw PayoutError.invalidClaim }
        var allowed = base.scheme == "https"
        #if DEBUG
        allowed = allowed || base.scheme == "http" && (host == "localhost" || host.hasSuffix(".local"))
        #endif
        guard allowed else { throw PayoutError.invalidClaim }
        var req = URLRequest(url:base.appending(path:path)); req.timeoutInterval = 15
        if let body { req.httpMethod = "POST"; req.setValue("application/json",forHTTPHeaderField:"Content-Type"); req.httpBody = try JSONSerialization.data(withJSONObject:body) }
        let session = URLSession(configuration:.ephemeral,delegate:NoPayoutRedirect(),delegateQueue:nil)
        defer { session.invalidateAndCancel() }
        let (data,response) = try await session.data(for:req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, data.count <= 16384 else { throw PayoutError.invalidClaim }
        return try JSONDecoder().decode(T.self,from:data)
    }
    private func refresh() async throws {
        let id = try identity()
        let read: PayoutBalance = try await request("payouts/"+id.pseudonym)
        try read.validate(program:program,pseudonym:id.pseudonym)
        guard read.protocolID == (try ObservationEncoding.id(protocolID)).map({ String(format:"%02x",$0) }).joined() else { throw PayoutError.invalidBalance }
        balance = read; address = SolanaBase58.encode(id.key.publicKey.rawRepresentation)
        status = read.status == "pending" ? "Pending on-chain registration; no credited gains yet." : "Finalized balances refreshed."
    }
    private struct Authorized: Decodable {
        let authorization: PayoutAuthorization
        let verifier: String
        let signature: String
        let message: String
        let lastValidBlockHeight: UInt64
    }
    private struct Pending: Codable {
        let authorization: PayoutAuthorization
        let verifier: String
        let signature: Data
        let message: Data
        // Optional only to decode pre-fix files without discarding an ambiguous outcome.
        let wire: Data?
        let transactionSignature: String?
        let lastValidBlockHeight: UInt64?
    }
    private func withdraw() async throws {
        let id = try identity()
        guard !FileManager.default.fileExists(atPath:id.pending.path) else { try await retrySaved(); return }
        try await refresh()
        let quote: PayoutAuthorization = try await request("payouts/quote",body:["pseudonym":id.pseudonym,"withdrawal_key":address,"destination":destination])
        guard let balance, quote.program == program, quote.payout == balance.payout, quote.withdrawalKey == address,
              quote.destination == destination, quote.amount == String(try PayoutBalance.baseUnits(balance.available)), quote.nonce == balance.nonce else { throw PayoutError.invalidClaim }
        let attest = AppAttestClient(service:SystemAppAttestService(),store:KeychainAppAttestKeyStore(service:"xyz.pathnod.challengescan.appattest"))
        let assertion = try await attest.assert(clientDataHash:quote.digest())
        let approved: Authorized = try await request("payouts/authorize",body:["pseudonym":id.pseudonym,"withdrawal_key":address,"destination":destination,
            "key_id":assertion.keyID,"assertion":assertion.object.base64EncodedString(),"expires_at":quote.expiresAt])
        guard approved.authorization == quote, let message = Data(base64Encoded:approved.message), approved.signature.count == 128 else { throw PayoutError.invalidClaim }
        var signature = Data(); var index = approved.signature.startIndex
        for _ in 0..<64 { let end = approved.signature.index(index,offsetBy:2); guard let byte = UInt8(approved.signature[index..<end],radix:16) else { throw PayoutError.invalidClaim }; signature.append(byte); index = end }
        let wire = try quote.signedWire(message:message,verifier:approved.verifier,signature:signature,privateKey:id.key,expectedProgram:program,now:UInt64(Date().timeIntervalSince1970))
        let pending = Pending(authorization:quote,verifier:approved.verifier,signature:signature,message:message,
            wire:wire,transactionSignature:SolanaBase58.encode(Data(wire[1..<65])),lastValidBlockHeight:approved.lastValidBlockHeight)
        try JSONEncoder().encode(pending).write(to:id.pending,options:[.atomic,.completeFileProtectionUnlessOpen])
        try await retrySaved()
    }
    private func retrySaved() async throws {
        let id = try identity(); try await refresh()
        guard FileManager.default.fileExists(atPath:id.pending.path) else { status = "No saved withdrawal."; return }
        let pending = try JSONDecoder().decode(Pending.self,from:Data(contentsOf:id.pending))
        guard let balance, pending.authorization.program == program, pending.authorization.payout == balance.payout else { throw PayoutError.invalidClaim }
        guard let initialNonce = UInt64(balance.nonce), let savedNonce = UInt64(pending.authorization.nonce), initialNonce >= savedNonce else { throw PayoutError.invalidBalance }
        if balance.status == "finalized", initialNonce > savedNonce {
            try FileManager.default.removeItem(at:id.pending); status = "Withdrawal finalized; balances refreshed."; return
        }
        let now = UInt64(Date().timeIntervalSince1970)
        // Reconstruct legacy bytes only while their authorization can still be validated.
        let wire: Data
        if let saved = pending.wire { wire = saved }
        else { wire = try pending.authorization.signedWire(message:pending.message,verifier:pending.verifier,signature:pending.signature,
            privateKey:id.key,expectedProgram:program,now:now) }
        guard wire.count > 65, wire[0] == 1, Data(wire.dropFirst(65)) == pending.message,
              id.key.publicKey.isValidSignature(Data(wire[1..<65]),for:pending.message) else { throw PayoutError.invalidClaim }
        let signature = SolanaBase58.encode(Data(wire[1..<65]))
        guard pending.transactionSignature == nil || pending.transactionSignature == signature else { throw PayoutError.invalidClaim }
        let result = try await rpcRequest("getSignatureStatuses", params:[[signature],["searchTransactionHistory":true]])
        guard let statuses = result as? [String:Any], let values = statuses["value"] as? [Any], values.count == 1 else { throw PayoutError.invalidClaim }
        let transactionStatus: WithdrawalTransactionStatus
        if values[0] is NSNull { transactionStatus = .absent }
        else {
            guard let value = values[0] as? [String:Any], let confirmation = value["confirmationStatus"] as? String,
                  let error = value["err"], ["processed","confirmed","finalized"].contains(confirmation) else { throw PayoutError.invalidClaim }
            transactionStatus = !(error is NSNull) ? .failed : confirmation == "finalized" ? .finalized : .pending
        }
        guard let height = try await rpcRequest("getBlockHeight",params:[["commitment":"finalized"]]) as? NSNumber,
              let finalizedHeight = UInt64(height.stringValue) else { throw PayoutError.invalidClaim }
        // Read finalized payout state after the finalized expiry boundary, not before it.
        try await refresh()
        guard let current = self.balance, current.status == "finalized", current.payout == pending.authorization.payout,
              let nonce = UInt64(current.nonce), let previous = UInt64(pending.authorization.nonce) else { throw PayoutError.invalidClaim }
        switch try WithdrawalRecovery.action(status:transactionStatus,finalizedHeight:finalizedHeight,
            lastValidBlockHeight:pending.lastValidBlockHeight,savedNonce:previous,finalizedNonce:nonce) {
        case .completed:
            try FileManager.default.removeItem(at:id.pending); status = "Withdrawal finalized; balances refreshed."; return
        case .replace:
            try FileManager.default.removeItem(at:id.pending)
            status = "Previous transaction expired without advancing the finalized nonce. You may request a new withdrawal."; return
        case .wait:
            status = "Saved withdrawal outcome is unresolved. No replacement sent; refresh and reconcile again."; return
        case .retry:
            guard let expiry = UInt64(pending.authorization.expiresAt), expiry >= now else {
                status = "Authorization expired; retaining the transaction until its outcome or blockhash expiry is reconciled."; return
            }
        }
        guard let broadcast = try await rpcRequest("sendTransaction",params:[wire.base64EncodedString(),
            ["encoding":"base64","skipPreflight":false,"preflightCommitment":"finalized","maxRetries":0]]) as? String,
              broadcast == signature else { throw PayoutError.invalidClaim }
        status = "Withdrawal submitted, not finalized. Refresh gains to confirm. Retry reuses the exact same bytes."
    }
    private func rpcRequest(_ method: String, params: [Any]) async throws -> Any {
        var req = URLRequest(url:rpc); req.httpMethod = "POST"; req.timeoutInterval = 15
        req.setValue("application/json",forHTTPHeaderField:"Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject:["jsonrpc":"2.0","id":1,"method":method,"params":params])
        let session = URLSession(configuration:.ephemeral,delegate:NoPayoutRedirect(),delegateQueue:nil)
        defer { session.invalidateAndCancel() }
        let (data,response) = try await session.data(for:req)
        guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 16384,
              let result = try JSONSerialization.jsonObject(with:data) as? [String:Any],
              result["error"] == nil, let value = result["result"] else { throw PayoutError.invalidClaim }
        return value
    }
}

private final class NoPayoutRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
