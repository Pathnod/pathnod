import Foundation

/// The full response stays readable even when a notification must be short.
public struct ResponseNotification: Equatable {
    public let value: Data
    public let requiresRead: Bool

    public init(response: Data, maximumUpdateValueLength: Int) {
        let length = min(response.count, max(0, maximumUpdateValueLength))
        value = response.prefix(length)
        requiresRead = length < response.count
    }
}
