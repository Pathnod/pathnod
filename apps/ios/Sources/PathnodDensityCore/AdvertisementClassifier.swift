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

/// The result of classifying one advertisement, and the whole of what a
/// session remembers about a peripheral.
///
/// The accumulator keeps one of these per peripheral and merges each new
/// sighting into it, so the evidence it carries has to be enough to decide the
/// next merge on its own: the priority that produced the verdict is therefore
/// recorded for an ambiguity as well as for a clean match. Nothing else is
/// retained — no advertisement, no service UUID, no manufacturer byte.
public struct ClassificationOutcome: Hashable, Sendable {
  public let category: DensityCategory
  public let ruleID: String?
  public let confidence: ClassificationConfidence?
  /// The priority at which the evidence was established, for an ambiguity as
  /// much as for a match. `nil` only when nothing matched at all.
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

  /// Rules of different categories agreed on nothing at `priority`, so the
  /// sighting stays `unknown` — but the priority of the conflict is kept, because
  /// only stronger evidence is allowed to settle it.
  public static func ambiguous(priority: Int) -> ClassificationOutcome {
    ClassificationOutcome(
      category: .unknown,
      ruleID: nil,
      confidence: nil,
      priority: priority,
      reason: .ambiguousMatch
    )
  }

  /// Combines everything a session already knows about one peripheral with one
  /// fresh sighting of it, and returns what is known afterwards.
  ///
  /// The rules, in order:
  ///
  /// - an advertisement that matched nothing adds nothing;
  /// - strictly higher priority replaces what came before, and is the only
  ///   thing that can settle an ambiguity — evidence of equal or lower
  ///   priority never does;
  /// - strictly lower priority is discarded;
  /// - at equal priority, two different categories are a conflict and the
  ///   peripheral becomes ambiguous, whether the conflict arrived in one
  ///   advertisement or in several;
  /// - confidence, then the lexicographically smaller rule identifier, only
  ///   ever separates rules of one and the same category.
  ///
  /// Merging is therefore commutative and idempotent over a peripheral's
  /// sightings: a session reaches the same verdict however the advertisements
  /// were grouped or ordered.
  public func merging(_ sighting: ClassificationOutcome) -> ClassificationOutcome {
    guard let incomingPriority = sighting.priority else { return self }
    guard let ownPriority = priority else { return sighting }

    if incomingPriority > ownPriority { return sighting }
    if incomingPriority < ownPriority { return self }

    // Equal priority from here on: neither side outranks the other, so a
    // disagreement between them can only be reported, never resolved.
    if reason == .ambiguousMatch { return self }
    if sighting.reason == .ambiguousMatch { return sighting }
    guard category == sighting.category else {
      return .ambiguous(priority: ownPriority)
    }

    let ownConfidence = confidence?.rank ?? -1
    let incomingConfidence = sighting.confidence?.rank ?? -1
    if incomingConfidence != ownConfidence {
      return incomingConfidence > ownConfidence ? sighting : self
    }

    guard let ownRuleID = ruleID, let incomingRuleID = sighting.ruleID else { return self }
    return incomingRuleID < ownRuleID ? sighting : self
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
    guard Set(contenders.map(\.category)).count == 1 else {
      return .ambiguous(priority: strongest.priority)
    }

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
