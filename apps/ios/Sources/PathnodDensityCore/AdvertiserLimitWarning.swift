import Foundation

/// Presentation for a session whose retained-identity bound caused sightings
/// to be dropped. Keeping the predicate and wording beside `SessionSummary`
/// makes the warning deterministic and testable without SwiftUI.
public struct AdvertiserLimitWarning: Equatable, Sendable {
  public let message: String

  public init?(summary: SessionSummary) {
    guard summary.reachedAdvertiserLimit else { return nil }

    let discarded =
      summary.uncountedSightings == 1
      ? "1 sighting has"
      : "\(summary.uncountedSightings) sightings have"
    message =
      "Counts are incomplete and are lower bounds. Sightings from new identities are being discarded after the retained identity limit of \(summary.advertiserLimit) was reached. \(discarded) not been counted."
  }
}
