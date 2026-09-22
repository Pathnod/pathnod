import Foundation

/// Why an advertisement ended up in the category it did.
public enum ClassificationReason: String, Codable, Sendable {
  /// Exactly one category won at the highest matching priority.
  case matched
  /// No rule matched.
  case noMatch = "no-match"
  /// Rules of different categories tied at the highest matching priority.
  case ambiguousMatch = "ambiguous-match"
}

/// The result of classifying one advertisement.
public struct ClassificationOutcome: Hashable, Sendable {
  public let category: DensityCategory
  public let ruleID: String?
  public let confidence: ClassificationConfidence?
  public let priority: Int?
  public let reason: ClassificationReason

  /// Nothing matched.
  public static let unmatched = ClassificationOutcome(
    category: .unknown,
    ruleID: nil,
    confidence: nil,
    priority: nil,
    reason: .noMatch
  )

  /// Rules disagreed at the same priority, so the sighting stays `unknown`.
  public static let ambiguous = ClassificationOutcome(
    category: .unknown,
    ruleID: nil,
    confidence: nil,
    priority: nil,
    reason: .ambiguousMatch
  )

  /// Ranks evidence so a later advertisement can only ever sharpen what is
  /// already known about a peripheral: a clean match beats an ambiguous one,
  /// an ambiguous one beats nothing, and between two clean matches the higher
  /// priority wins, then the higher confidence, then the lexicographically
  /// smaller rule identifier. The final tie-break makes a session independent
  /// of advertisement order.
  public func supersedes(_ other: ClassificationOutcome) -> Bool {
    guard reason.strength == other.reason.strength else {
      return reason.strength > other.reason.strength
    }
    guard reason == .matched else { return false }

    let ownPriority = priority ?? Int.min
    let otherPriority = other.priority ?? Int.min
    if ownPriority != otherPriority { return ownPriority > otherPriority }

    let ownConfidence = confidence?.rank ?? -1
    let otherConfidence = other.confidence?.rank ?? -1
    if ownConfidence != otherConfidence { return ownConfidence > otherConfidence }

    guard let ownRuleID = ruleID, let otherRuleID = other.ruleID else { return false }
    return ownRuleID < otherRuleID
  }
}

extension ClassificationReason {
  fileprivate var strength: Int {
    switch self {
    case .noMatch: return 0
    case .ambiguousMatch: return 1
    case .matched: return 2
    }
  }
}

/// Applies a registry to one advertisement at a time.
///
/// The classifier reads only the fields in ``AdvertisementSnapshot``, and never
/// the local name, the RSSI, undocumented bytes, or a company identifier on its
/// own. With an empty registry every advertisement is `unknown`.
public struct AdvertisementClassifier: Sendable {
  public let registry: ClassificationRegistry

  public init(registry: ClassificationRegistry) {
    self.registry = registry
  }

  public func classify(_ advertisement: AdvertisementSnapshot) -> ClassificationOutcome {
    // `registry.rules` is sorted by descending priority, so the first match
    // establishes the highest priority that matched at all.
    let matches = registry.rules.filter { $0.matches(advertisement) }
    guard let strongest = matches.first else { return .unmatched }

    let contenders = matches.filter { $0.priority == strongest.priority }
    guard Set(contenders.map(\.category)).count == 1 else { return .ambiguous }

    let winner = contenders.min { lhs, rhs in
      lhs.confidence.rank == rhs.confidence.rank
        ? lhs.id < rhs.id
        : lhs.confidence.rank > rhs.confidence.rank
    }
    guard let winner else { return .unmatched }

    return ClassificationOutcome(
      category: winner.category,
      ruleID: winner.id,
      confidence: winner.confidence,
      priority: winner.priority,
      reason: .matched
    )
  }
}
