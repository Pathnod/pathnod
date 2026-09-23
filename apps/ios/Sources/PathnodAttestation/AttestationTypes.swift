import Foundation

public enum AttestationPurpose: String, Codable, CaseIterable, Sendable {
    case enrollment
    case observation
}

public struct AttestationEnvelope: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let provider: String
    public let environment: String
    public let purpose: AttestationPurpose
    public let proof: String

    public init(
        schemaVersion: Int,
        provider: String,
        environment: String,
        purpose: AttestationPurpose,
        proof: String
    ) {
        self.schemaVersion = schemaVersion
        self.provider = provider
        self.environment = environment
        self.purpose = purpose
        self.proof = proof
    }
}

public enum AttestationProviderError: Error, Equatable, Sendable {
    case invalidClientDataHash
    case stubDisabled
    case stubForbiddenInRelease
    case unsupportedProvider
}

public enum AttestationBuildConfiguration: Equatable, Sendable {
    case debug
    case release

    public static var current: Self {
        #if DEBUG
        return .debug
        #else
        return .release
        #endif
    }
}

public struct AttestationWarningEvent: Equatable, Sendable {
    public let event: String
    public let message: String
    public let provider: String
    public let environment: String
    public let assurance: String
    public let purpose: AttestationPurpose

    public init(
        event: String,
        message: String,
        provider: String,
        environment: String,
        assurance: String,
        purpose: AttestationPurpose
    ) {
        self.event = event
        self.message = message
        self.provider = provider
        self.environment = environment
        self.assurance = assurance
        self.purpose = purpose
    }
}

public protocol AttestationWarningLogging: Sendable {
    func warning(_ event: AttestationWarningEvent)
}

public struct ConsoleAttestationWarningLogger: AttestationWarningLogging {
    public init() {}

    public func warning(_ event: AttestationWarningEvent) {
        let line = "WARNING \(event.message) event=\(event.event) provider=\(event.provider) environment=\(event.environment) assurance=\(event.assurance) purpose=\(event.purpose.rawValue)\n"
        FileHandle.standardError.write(Data(line.utf8))
    }
}
