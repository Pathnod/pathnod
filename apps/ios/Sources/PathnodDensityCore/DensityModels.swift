import Foundation

/// The categories a density session reports.
///
/// `unknown` is the default and the only honest answer when no documented
/// signature matched: the study counts what CoreBluetooth reported during a
/// foreground scan, and a category never claims network membership, ownership,
/// online status, or location.
public enum DensityCategory: String, Codable, CaseIterable, Sendable {
  case helium
  case wifi
  case ev
  case unknown
}

/// How much a rule author trusts the signature itself, not the sighting.
public enum ClassificationConfidence: String, Codable, Sendable {
  case high
  case medium

  /// Higher wins when two rules of the same category and priority match.
  var rank: Int {
    switch self {
    case .high: return 1
    case .medium: return 0
    }
  }
}

/// Where the signature came from. Both values require a written reference; a
/// guess, an observation, or a vendor rumour is not a source kind.
public enum ClassificationSourceKind: String, Codable, Sendable {
  case publishedSpec = "published-spec"
  case partnerConfirmed = "partner-confirmed"
}

/// A 128-bit Bluetooth service UUID, normalised so that the 16-bit, 32-bit and
/// 128-bit spellings of the same service compare equal.
///
/// This type carries advertised *service* UUIDs from rules and advertisements.
/// It is never used for a peripheral identifier: see ``PeripheralKey``.
public struct ServiceUUID: Hashable, Sendable, CustomStringConvertible {
  /// Suffix of the Bluetooth SIG base UUID, used to widen short UUIDs.
  public static let baseUUIDSuffix = "-0000-1000-8000-00805F9B34FB"

  /// ASCII hexadecimal digits. `Character.isHexDigit` also accepts full-width
  /// and other Unicode hex forms, which would let a decorative string through
  /// and produce a UUID that no advertisement can ever equal.
  private static let hexDigits = Set("0123456789ABCDEF")

  /// Upper-case canonical 128-bit form.
  public let rawValue: String

  /// Accepts the 4-, 8- and 36-character spellings, and rejects everything
  /// else rather than guessing.
  public init?(_ value: String) {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()

    switch trimmed.count {
    case 4, 8:
      guard trimmed.allSatisfy(Self.hexDigits.contains) else { return nil }
      let padded = String(repeating: "0", count: 8 - trimmed.count) + trimmed
      rawValue = padded + Self.baseUUIDSuffix
    case 36:
      guard let uuid = UUID(uuidString: trimmed) else { return nil }
      rawValue = uuid.uuidString
    default:
      return nil
    }
  }

  public var description: String { rawValue }
}

/// The manufacturer-specific payload of one advertisement, already split into
/// the company identifier and the bytes that follow it.
public struct ManufacturerData: Hashable, Sendable {
  public let companyIdentifier: UInt16
  public let payload: [UInt8]

  public init(companyIdentifier: UInt16, payload: [UInt8]) {
    self.companyIdentifier = companyIdentifier
    self.payload = payload
  }

  /// Parses the raw `CBAdvertisementDataManufacturerDataKey` bytes: a
  /// little-endian company identifier followed by company-defined data.
  /// Returns `nil` for anything shorter than the mandatory two bytes.
  public init?(rawAdvertisementBytes bytes: [UInt8]) {
    guard bytes.count >= 2 else { return nil }
    companyIdentifier = UInt16(bytes[0]) | (UInt16(bytes[1]) << 8)
    payload = Array(bytes.dropFirst(2))
  }
}

/// An exact manufacturer signature: a company identifier *and* a non-empty
/// prefix of the company-defined bytes.
///
/// A company identifier alone is never a signature. Companies ship unrelated
/// products behind one identifier, so matching on it would classify devices
/// that have nothing to do with the study.
public struct ManufacturerSignature: Hashable, Sendable {
  public let companyIdentifier: UInt16
  public let dataPrefix: [UInt8]

  public init(companyIdentifier: UInt16, dataPrefix: [UInt8]) {
    self.companyIdentifier = companyIdentifier
    self.dataPrefix = dataPrefix
  }

  public func matches(_ data: ManufacturerData) -> Bool {
    guard !dataPrefix.isEmpty else { return false }
    guard data.companyIdentifier == companyIdentifier else { return false }
    guard data.payload.count >= dataPrefix.count else { return false }
    return Array(data.payload.prefix(dataPrefix.count)) == dataPrefix
  }
}

/// The only advertisement facts the core is allowed to see.
///
/// Deliberately absent: the peripheral identifier, the local name, the RSSI,
/// the transmit power, the connectable flag, solicited services, and the raw
/// advertisement dictionary. `carriesLocalName` is a boolean used by the tests
/// to prove that a name-only advertisement stays `unknown`; the name itself
/// never reaches this type.
public struct AdvertisementSnapshot: Hashable, Sendable {
  public let serviceUUIDs: Set<ServiceUUID>
  public let manufacturerData: ManufacturerData?
  public let carriesLocalName: Bool

  public init(
    serviceUUIDs: Set<ServiceUUID> = [],
    manufacturerData: ManufacturerData? = nil,
    carriesLocalName: Bool = false
  ) {
    self.serviceUUIDs = serviceUUIDs
    self.manufacturerData = manufacturerData
    self.carriesLocalName = carriesLocalName
  }
}

/// One documented signature.
///
/// Every criterion the rule declares must match: a rule that names both a
/// service UUID set and a manufacturer signature matches only advertisements
/// carrying both. That is the fail-closed reading of "service UUID and/or
/// manufacturer identifier plus data prefix".
public struct ClassificationRule: Hashable, Sendable {
  public let id: String
  public let category: DensityCategory
  public let confidence: ClassificationConfidence
  public let sourceKind: ClassificationSourceKind
  public let sourceReference: String
  public let serviceUUIDs: Set<ServiceUUID>
  public let manufacturerSignature: ManufacturerSignature?
  public let priority: Int

  public init(
    id: String,
    category: DensityCategory,
    confidence: ClassificationConfidence,
    sourceKind: ClassificationSourceKind,
    sourceReference: String,
    serviceUUIDs: Set<ServiceUUID> = [],
    manufacturerSignature: ManufacturerSignature? = nil,
    priority: Int
  ) {
    self.id = id
    self.category = category
    self.confidence = confidence
    self.sourceKind = sourceKind
    self.sourceReference = sourceReference
    self.serviceUUIDs = serviceUUIDs
    self.manufacturerSignature = manufacturerSignature
    self.priority = priority
  }

  public func matches(_ advertisement: AdvertisementSnapshot) -> Bool {
    if !serviceUUIDs.isEmpty {
      guard !serviceUUIDs.isDisjoint(with: advertisement.serviceUUIDs) else { return false }
    }

    if let signature = manufacturerSignature {
      guard let data = advertisement.manufacturerData, signature.matches(data) else {
        return false
      }
    }

    return !serviceUUIDs.isEmpty || manufacturerSignature != nil
  }
}

/// Everything a registry can reject, fail-closed, at construction time.
public enum ClassificationRegistryError: Error, Equatable, Sendable {
  case emptyVersion
  case emptyRuleIdentifier
  case duplicateRuleIdentifier(String)
  case reservedCategory(ruleID: String)
  case emptySourceReference(ruleID: String)
  case missingSignature(ruleID: String)
  case emptyManufacturerDataPrefix(ruleID: String)
  case negativePriority(ruleID: String)
  case duplicateSignature(ruleIDs: [String])
}

/// A deterministic, versioned set of rules.
///
/// Construction validates the whole set and throws on the first problem; a
/// registry that exists is a registry that was accepted in full. An empty rule
/// list is valid and classifies every advertisement as `unknown`, which is the
/// intended state whenever no trustworthy signature has been documented.
public struct ClassificationRegistry: Sendable {
  public let version: String

  /// Sorted by descending priority, then ascending identifier, so that
  /// iteration order — and therefore every classification — is reproducible.
  public let rules: [ClassificationRule]

  /// True when at least one rule needs the advertised service UUID list.
  public let inspectsServiceUUIDs: Bool

  /// Company identifiers that at least one rule needs. Manufacturer data for
  /// any other company is never read.
  public let inspectedCompanyIdentifiers: Set<UInt16>

  private let rulesByID: [String: ClassificationRule]
  private let manufacturerPrefixLengths: [UInt16: Int]

  public init(version: String, rules: [ClassificationRule]) throws {
    let trimmedVersion = version.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedVersion.isEmpty else { throw ClassificationRegistryError.emptyVersion }

    var identifiers: Set<String> = []
    var criteriaOwners: [Criteria: String] = [:]
    var prefixLengths: [UInt16: Int] = [:]
    var companies: Set<UInt16> = []
    var indexedRules: [String: ClassificationRule] = [:]

    for rule in rules {
      guard !rule.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw ClassificationRegistryError.emptyRuleIdentifier
      }
      guard identifiers.insert(rule.id).inserted else {
        throw ClassificationRegistryError.duplicateRuleIdentifier(rule.id)
      }
      guard rule.category != .unknown else {
        throw ClassificationRegistryError.reservedCategory(ruleID: rule.id)
      }
      guard !rule.sourceReference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw ClassificationRegistryError.emptySourceReference(ruleID: rule.id)
      }
      guard rule.priority >= 0 else {
        throw ClassificationRegistryError.negativePriority(ruleID: rule.id)
      }
      guard !rule.serviceUUIDs.isEmpty || rule.manufacturerSignature != nil else {
        throw ClassificationRegistryError.missingSignature(ruleID: rule.id)
      }
      if let signature = rule.manufacturerSignature {
        guard !signature.dataPrefix.isEmpty else {
          throw ClassificationRegistryError.emptyManufacturerDataPrefix(ruleID: rule.id)
        }
        companies.insert(signature.companyIdentifier)
        let known = prefixLengths[signature.companyIdentifier] ?? 0
        prefixLengths[signature.companyIdentifier] = max(known, signature.dataPrefix.count)
      }

      let criteria = Criteria(
        serviceUUIDs: rule.serviceUUIDs,
        manufacturerSignature: rule.manufacturerSignature
      )
      if let owner = criteriaOwners[criteria] {
        throw ClassificationRegistryError.duplicateSignature(ruleIDs: [owner, rule.id].sorted())
      }
      criteriaOwners[criteria] = rule.id
      indexedRules[rule.id] = rule
    }

    self.version = trimmedVersion
    self.rules = rules.sorted { lhs, rhs in
      lhs.priority == rhs.priority ? lhs.id < rhs.id : lhs.priority > rhs.priority
    }
    self.rulesByID = indexedRules
    self.inspectsServiceUUIDs = rules.contains { !$0.serviceUUIDs.isEmpty }
    self.inspectedCompanyIdentifiers = companies
    self.manufacturerPrefixLengths = prefixLengths
  }

  /// A valid registry that matches nothing.
  public static func empty(version: String) throws -> ClassificationRegistry {
    try ClassificationRegistry(version: version, rules: [])
  }

  /// The registry to fall back to when a shipped ruleset is rejected.
  ///
  /// Building it cannot fail, so a rejected ruleset degrades the session to
  /// "every advertiser is `unknown`" instead of crashing the app or, worse,
  /// letting it fall back to a guess. The version string is deliberately
  /// recognisable in an export.
  public static let unavailable = ClassificationRegistry(acceptedVersion: "unavailable")

  /// Only reachable from ``unavailable``: it skips validation because there is
  /// nothing to validate.
  private init(acceptedVersion version: String) {
    self.version = version
    self.rules = []
    self.rulesByID = [:]
    self.inspectsServiceUUIDs = false
    self.inspectedCompanyIdentifiers = []
    self.manufacturerPrefixLengths = [:]
  }

  public func rule(id: String) -> ClassificationRule? {
    rulesByID[id]
  }

  /// Narrows a raw manufacturer-data field without first copying its complete
  /// payload. The company identifier is read in place and undeclared companies
  /// are rejected before any payload byte is copied.
  public func manufacturerDataToInspect(rawAdvertisement data: Data) -> ManufacturerData? {
    guard data.count >= 2 else { return nil }
    let lowIndex = data.startIndex
    let highIndex = data.index(after: lowIndex)
    let company = UInt16(data[lowIndex]) | (UInt16(data[highIndex]) << 8)
    guard let length = manufacturerPrefixLengths[company] else { return nil }

    let payloadStart = data.index(after: highIndex)
    let payloadEnd = data.index(payloadStart, offsetBy: min(length, data.count - 2))
    return ManufacturerData(
      companyIdentifier: company,
      payload: [UInt8](data[payloadStart..<payloadEnd])
    )
  }

  private struct Criteria: Hashable {
    let serviceUUIDs: Set<ServiceUUID>
    let manufacturerSignature: ManufacturerSignature?
  }
}
