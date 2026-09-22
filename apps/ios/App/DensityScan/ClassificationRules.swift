import Foundation
import PathnodDensityCore

/// The ruleset this build ships.
///
/// A rule may only exist here when a published specification or a written
/// partner confirmation states that a specific device advertises a specific
/// service UUID, or a specific company identifier followed by specific bytes.
/// One signature met that bar when this build was prepared, and it is the only
/// rule below. Nothing is inferred from a local name, an RSSI, undocumented
/// bytes, or a company identifier on its own.
///
/// What is deliberately absent:
///
/// - Wi-Fi access points advertise, when they advertise at all, under
///   provisioning profiles shared with unrelated products from the same vendor,
///   so only a company identifier would be available — and a company identifier
///   alone is not a signature.
/// - EV charging over BLE is a vendor extension in practice; OCPP defines no
///   advertising signature.
///
/// Every advertiser that does not match the Helium rule is reported as
/// `unknown`, which is the honest answer: the study measures BLE density, not
/// network membership.
///
/// Adding a rule is a documented change: fill in `sourceKind` and
/// `sourceReference` with what was actually read, bump ``version``, and let the
/// registry reject anything malformed.
enum ClassificationRules {
  /// Bumped whenever ``candidates`` changes. It is carried in every export, so
  /// a result can be tied back to the rules that produced it.
  static let version = "1.0.0"

  /// The Helium Hotspot BLE configuration service.
  ///
  /// Helium Hotspots expose this service so the owner's phone can configure
  /// them over BLE. Three limits come with it, and they are repeated in the
  /// source reference because the reference travels into the export:
  ///
  /// - it is advertised only while a Hotspot is offering configuration, so a
  ///   session that counts zero of them has not shown that no Hotspot is
  ///   nearby;
  /// - anything at all can advertise this UUID, so a match is spoofable;
  /// - it describes a configuration window, never network membership,
  ///   activity, ownership or location.
  static let heliumConfigurationService = ClassificationRule(
    id: "helium-hotspot-config-service-v1",
    category: .helium,
    confidence: .high,
    sourceKind: .publishedSpec,
    sourceReference: """
      Official Helium client and peripheral sources at immutable revisions: \
      https://github.com/helium/react-native-helium/blob/40caf0c70af8955a62712f742a7f2a1c2678610c/src/HotspotBle/bleTypes.ts ; \
      https://github.com/helium/react-native-helium/blob/40caf0c70af8955a62712f742a7f2a1c2678610c/src/HotspotBle/useHotspotBle.tsx ; \
      https://github.com/helium/gateway-config/blob/f2b93c8d09f9c39a122edc38082ef83d716c67da/src/gateway_gatt.hrl ; \
      https://github.com/helium/gateway-config/blob/f2b93c8d09f9c39a122edc38082ef83d716c67da/src/gateway_ble_advertisement.erl . \
      The UUID is advertised only while a Hotspot offers configuration over \
      BLE and can be spoofed; a match is not evidence of network membership, \
      activity, ownership or location.
      """,
    serviceUUIDs: Set([ServiceUUID("0fda92b2-44a2-4af2-84f5-fa682baa2b8d")].compactMap { $0 }),
    priority: 100
  )

  /// The documented signatures. One entry, by review; see the type
  /// documentation for what was rejected and why.
  static let candidates: [ClassificationRule] = [heliumConfigurationService]

  /// Builds the registry, letting it validate the whole set.
  ///
  /// Throws ``ClassificationRegistryError`` rather than dropping a bad rule, so
  /// a mistake is visible instead of silently narrowing the ruleset.
  static func makeRegistry() throws -> ClassificationRegistry {
    try ClassificationRegistry(version: version, rules: candidates)
  }
}
