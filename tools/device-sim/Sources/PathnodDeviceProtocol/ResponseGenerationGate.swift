import Foundation

/// Invalidates delayed responses without reusing a token after a radio reset.
public struct ResponseGenerationGate {
    private var nextToken: UInt64 = 0
    private var currentByCentral: [UUID: UInt64] = [:]

    public init() {}

    public mutating func beginChallenge(for central: UUID) -> UInt64 {
        nextToken &+= 1
        currentByCentral[central] = nextToken
        return nextToken
    }

    public mutating func invalidate(_ central: UUID) {
        currentByCentral.removeValue(forKey: central)
    }

    public mutating func invalidateAll() {
        currentByCentral.removeAll()
        // Delayed closures may still hold old tokens. Never reset nextToken.
    }

    public func isCurrent(_ token: UInt64, for central: UUID) -> Bool {
        currentByCentral[central] == token
    }
}
