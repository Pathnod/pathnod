import Foundation
import Testing
import PathnodDensityCore

@Suite("Service UUID normalisation")
struct ServiceUUIDTests {
    @Test("the 16-, 32- and 128-bit spellings of one service compare equal")
    func equivalentSpellings() throws {
        let short = try serviceUUID("180a")
        let medium = try serviceUUID("0000180A")
        let long = try serviceUUID("0000180A-0000-1000-8000-00805F9B34FB")

        #expect(short == medium)
        #expect(medium == long)
        #expect(short.rawValue == "0000180A-0000-1000-8000-00805F9B34FB")
    }

    @Test("rejects malformed spellings instead of guessing", arguments: [
        "",
        "18",
        "180",
        "180AZ",
        "0000180",
        "0000180AA",
        "not-a-uuid-at-all-0000-000000000000",
        "0000180A-0000-1000-8000-00805F9B34F",
        "１８０Ａ",
    ])
    func rejectsMalformedValues(_ value: String) {
        #expect(ServiceUUID(value) == nil)
    }

    @Test("accepts surrounding whitespace")
    func trimsWhitespace() throws {
        let padded = try serviceUUID("  180A \n")
        let plain = try serviceUUID("180A")

        #expect(padded == plain)
    }
}

@Suite("Manufacturer signatures")
struct ManufacturerSignatureTests {
    @Test("parses the little-endian company identifier")
    func parsesCompanyIdentifier() throws {
        let data = try #require(ManufacturerData(rawAdvertisementBytes: [0x4C, 0x00, 0x10, 0x20, 0x30]))

        #expect(data.companyIdentifier == 0x004C)
        #expect(data.payload == [0x10, 0x20, 0x30])
    }

    @Test("rejects payloads shorter than the mandatory company identifier", arguments: [
        [] as [UInt8],
        [0x4C] as [UInt8],
    ])
    func rejectsTruncatedPayloads(_ bytes: [UInt8]) {
        #expect(ManufacturerData(rawAdvertisementBytes: bytes) == nil)
    }

    @Test("a company identifier alone never matches")
    func companyIdentifierAloneDoesNotMatch() throws {
        let signature = ManufacturerSignature(companyIdentifier: 0x004C, dataPrefix: [0x10, 0x20])
        let sameCompanyDifferentProduct = try #require(
            ManufacturerData(rawAdvertisementBytes: [0x4C, 0x00, 0x99, 0x99])
        )

        #expect(signature.matches(sameCompanyDifferentProduct) == false)
    }

    @Test("an empty prefix matches nothing, even for the right company")
    func emptyPrefixMatchesNothing() throws {
        let signature = ManufacturerSignature(companyIdentifier: 0x004C, dataPrefix: [])
        let data = try #require(ManufacturerData(rawAdvertisementBytes: [0x4C, 0x00, 0x10]))

        #expect(signature.matches(data) == false)
    }

    @Test("a payload shorter than the prefix does not match")
    func shortPayloadDoesNotMatch() throws {
        let signature = ManufacturerSignature(companyIdentifier: 0x004C, dataPrefix: [0x10, 0x20])
        let data = try #require(ManufacturerData(rawAdvertisementBytes: [0x4C, 0x00, 0x10]))

        #expect(signature.matches(data) == false)
    }
}

@Suite("Classification registry validation")
struct ClassificationRegistryTests {
    @Test("an empty ruleset is valid and classifies everything as unknown")
    func emptyRegistryIsValid() throws {
        let registry = try ClassificationRegistry.empty(version: "empty-1")
        let classifier = AdvertisementClassifier(registry: registry)

        #expect(registry.rules.isEmpty)
        #expect(registry.inspectsServiceUUIDs == false)
        #expect(registry.inspectedCompanyIdentifiers.isEmpty)

        let outcome = classifier.classify(
            advertisement(
                services: [try serviceUUID(TestUUIDs.heliumService)],
                manufacturer: ManufacturerData(companyIdentifier: 0x004C, payload: [0x10, 0x20]),
                carriesLocalName: true
            )
        )

        #expect(outcome.category == .unknown)
        #expect(outcome.reason == .noMatch)
        #expect(outcome.ruleID == nil)
    }

    @Test("rejects a blank version")
    func rejectsBlankVersion() {
        #expect(throws: ClassificationRegistryError.emptyVersion) {
            try ClassificationRegistry(version: "   ", rules: [])
        }
    }

    @Test("rejects a blank rule identifier")
    func rejectsBlankRuleIdentifier() throws {
        let broken = rule(
            id: " ",
            category: .helium,
            serviceUUIDs: [try serviceUUID(TestUUIDs.heliumService)],
            priority: 1
        )

        #expect(throws: ClassificationRegistryError.emptyRuleIdentifier) {
            try ClassificationRegistry(version: "v1", rules: [broken])
        }
    }

    @Test("rejects duplicate rule identifiers")
    func rejectsDuplicateIdentifiers() throws {
        let first = rule(
            id: "duplicated",
            category: .helium,
            serviceUUIDs: [try serviceUUID(TestUUIDs.heliumService)],
            priority: 10
        )
        let second = rule(
            id: "duplicated",
            category: .ev,
            serviceUUIDs: [try serviceUUID(TestUUIDs.evService)],
            priority: 20
        )

        #expect(throws: ClassificationRegistryError.duplicateRuleIdentifier("duplicated")) {
            try ClassificationRegistry(version: "v1", rules: [first, second])
        }
    }

    @Test("rejects two rules carrying the same signature")
    func rejectsDuplicateSignatures() throws {
        let service = try serviceUUID(TestUUIDs.heliumService)
        let first = rule(id: "b-rule", category: .helium, serviceUUIDs: [service], priority: 10)
        let second = rule(id: "a-rule", category: .helium, serviceUUIDs: [service], priority: 20)

        #expect(throws: ClassificationRegistryError.duplicateSignature(ruleIDs: ["a-rule", "b-rule"])) {
            try ClassificationRegistry(version: "v1", rules: [first, second])
        }
    }

    @Test("rejects a rule that claims the reserved unknown category")
    func rejectsReservedCategory() throws {
        let broken = rule(
            id: "unknown-rule",
            category: .unknown,
            serviceUUIDs: [try serviceUUID(TestUUIDs.heliumService)],
            priority: 1
        )

        #expect(throws: ClassificationRegistryError.reservedCategory(ruleID: "unknown-rule")) {
            try ClassificationRegistry(version: "v1", rules: [broken])
        }
    }

    @Test("rejects a rule without a written source reference")
    func rejectsMissingSourceReference() throws {
        let broken = rule(
            id: "undocumented",
            category: .helium,
            sourceReference: "  ",
            serviceUUIDs: [try serviceUUID(TestUUIDs.heliumService)],
            priority: 1
        )

        #expect(throws: ClassificationRegistryError.emptySourceReference(ruleID: "undocumented")) {
            try ClassificationRegistry(version: "v1", rules: [broken])
        }
    }

    @Test("rejects a rule with no signature at all")
    func rejectsSignatureLessRule() {
        let broken = rule(id: "empty", category: .wifi, priority: 1)

        #expect(throws: ClassificationRegistryError.missingSignature(ruleID: "empty")) {
            try ClassificationRegistry(version: "v1", rules: [broken])
        }
    }

    @Test("rejects a manufacturer rule with an empty data prefix")
    func rejectsEmptyManufacturerPrefix() {
        let broken = rule(
            id: "company-only",
            category: .wifi,
            manufacturerSignature: ManufacturerSignature(companyIdentifier: 0x004C, dataPrefix: []),
            priority: 1
        )

        #expect(throws: ClassificationRegistryError.emptyManufacturerDataPrefix(ruleID: "company-only")) {
            try ClassificationRegistry(version: "v1", rules: [broken])
        }
    }

    @Test("rejects a negative priority")
    func rejectsNegativePriority() throws {
        let broken = rule(
            id: "negative",
            category: .helium,
            serviceUUIDs: [try serviceUUID(TestUUIDs.heliumService)],
            priority: -1
        )

        #expect(throws: ClassificationRegistryError.negativePriority(ruleID: "negative")) {
            try ClassificationRegistry(version: "v1", rules: [broken])
        }
    }

    @Test("orders rules by descending priority then identifier")
    func deterministicOrder() throws {
        let registry = try referenceRegistry()

        #expect(registry.rules.map(\.id) == ["helium-service", "ev-service", "wifi-manufacturer"])
        #expect(registry.version == "test-1")
    }

    @Test("trims the declared version")
    func trimsVersion() throws {
        let registry = try ClassificationRegistry(version: "  v9  ", rules: [])

        #expect(registry.version == "v9")
    }

    @Test("narrows manufacturer bytes to what a rule actually needs")
    func narrowsManufacturerData() throws {
        let registry = try referenceRegistry()

        #expect(registry.inspectedCompanyIdentifiers == [0x004C])

        let inspected = try #require(
            registry.manufacturerDataToInspect(
                rawAdvertisementBytes: [0x4C, 0x00, 0x10, 0x20, 0xDE, 0xAD, 0xBE, 0xEF]
            )
        )

        // The two bytes the rule declares, and nothing that follows them.
        #expect(inspected.companyIdentifier == 0x004C)
        #expect(inspected.payload == [0x10, 0x20])
    }

    @Test("never reads manufacturer bytes for a company no rule declares")
    func ignoresUndeclaredCompanies() throws {
        let registry = try referenceRegistry()

        #expect(registry.manufacturerDataToInspect(rawAdvertisementBytes: [0x99, 0x00, 0x01]) == nil)
    }

    @Test("an empty registry inspects no manufacturer data at all")
    func emptyRegistryInspectsNothing() throws {
        let registry = try ClassificationRegistry.empty(version: "empty-1")

        #expect(registry.manufacturerDataToInspect(rawAdvertisementBytes: [0x4C, 0x00, 0x10, 0x20]) == nil)
    }
}

@Suite("Advertisement classification")
struct AdvertisementClassifierTests {
    @Test("matches a documented service-UUID rule")
    func matchesServiceRule() throws {
        let classifier = AdvertisementClassifier(registry: try referenceRegistry())

        let outcome = classifier.classify(
            advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
        )

        #expect(outcome.category == .helium)
        #expect(outcome.ruleID == "helium-service")
        #expect(outcome.confidence == .high)
        #expect(outcome.priority == 100)
        #expect(outcome.reason == .matched)
    }

    @Test("matches a documented manufacturer rule")
    func matchesManufacturerRule() throws {
        let classifier = AdvertisementClassifier(registry: try referenceRegistry())

        let outcome = classifier.classify(
            advertisement(manufacturer: ManufacturerData(companyIdentifier: 0x004C, payload: [0x10, 0x20]))
        )

        #expect(outcome.category == .wifi)
        #expect(outcome.ruleID == "wifi-manufacturer")
        #expect(outcome.sourceIsDocumented)
    }

    @Test("an advertisement carrying only a local name stays unknown")
    func localNameOnlyStaysUnknown() throws {
        let classifier = AdvertisementClassifier(registry: try referenceRegistry())

        let outcome = classifier.classify(advertisement(carriesLocalName: true))

        #expect(outcome.category == .unknown)
        #expect(outcome.reason == .noMatch)
        #expect(outcome.ruleID == nil)
    }

    @Test("an unrelated service UUID stays unknown")
    func unrelatedServiceStaysUnknown() throws {
        let classifier = AdvertisementClassifier(registry: try referenceRegistry())

        let outcome = classifier.classify(
            advertisement(services: [try serviceUUID(TestUUIDs.unrelatedService)], carriesLocalName: true)
        )

        #expect(outcome.category == .unknown)
        #expect(outcome.reason == .noMatch)
    }

    @Test("a rule declaring both criteria needs both of them")
    func conjunctiveRuleNeedsBoth() throws {
        let service = try serviceUUID(TestUUIDs.heliumService)
        let registry = try ClassificationRegistry(
            version: "v1",
            rules: [
                rule(
                    id: "both",
                    category: .helium,
                    serviceUUIDs: [service],
                    manufacturerSignature: ManufacturerSignature(
                        companyIdentifier: 0x004C,
                        dataPrefix: [0x10]
                    ),
                    priority: 10
                ),
            ]
        )
        let classifier = AdvertisementClassifier(registry: registry)

        #expect(classifier.classify(advertisement(services: [service])).category == .unknown)
        #expect(
            classifier.classify(
                advertisement(manufacturer: ManufacturerData(companyIdentifier: 0x004C, payload: [0x10]))
            ).category == .unknown
        )
        #expect(
            classifier.classify(
                advertisement(
                    services: [service],
                    manufacturer: ManufacturerData(companyIdentifier: 0x004C, payload: [0x10])
                )
            ).category == .helium
        )
    }

    @Test("the highest priority wins when rules of different categories both match")
    func highestPriorityWins() throws {
        let classifier = AdvertisementClassifier(registry: try referenceRegistry())

        let outcome = classifier.classify(
            advertisement(
                services: [try serviceUUID(TestUUIDs.heliumService)],
                manufacturer: ManufacturerData(companyIdentifier: 0x004C, payload: [0x10, 0x20])
            )
        )

        #expect(outcome.category == .helium)
        #expect(outcome.priority == 100)
    }

    @Test("conflicting categories at equal priority become unknown/ambiguous-match")
    func conflictingEqualPriorityIsAmbiguous() throws {
        let service = try serviceUUID(TestUUIDs.heliumService)
        let registry = try ClassificationRegistry(
            version: "conflict-1",
            rules: [
                rule(id: "a-helium", category: .helium, serviceUUIDs: [service], priority: 50),
                rule(
                    id: "b-ev",
                    category: .ev,
                    manufacturerSignature: ManufacturerSignature(
                        companyIdentifier: 0x00E0,
                        dataPrefix: [0xAA]
                    ),
                    priority: 50
                ),
            ]
        )
        let classifier = AdvertisementClassifier(registry: registry)

        let outcome = classifier.classify(
            advertisement(
                services: [service],
                manufacturer: ManufacturerData(companyIdentifier: 0x00E0, payload: [0xAA])
            )
        )

        #expect(outcome.category == .unknown)
        #expect(outcome.reason == .ambiguousMatch)
        #expect(outcome.ruleID == nil)
        #expect(outcome.confidence == nil)
    }

    @Test("two rules of the same category at equal priority resolve by confidence")
    func sameCategoryEqualPriorityResolvesByConfidence() throws {
        let service = try serviceUUID(TestUUIDs.heliumService)
        let registry = try ClassificationRegistry(
            version: "agree-1",
            rules: [
                rule(
                    id: "a-medium",
                    category: .helium,
                    confidence: .medium,
                    serviceUUIDs: [service],
                    priority: 50
                ),
                rule(
                    id: "b-high",
                    category: .helium,
                    confidence: .high,
                    manufacturerSignature: ManufacturerSignature(
                        companyIdentifier: 0x00E0,
                        dataPrefix: [0xAA]
                    ),
                    priority: 50
                ),
            ]
        )
        let classifier = AdvertisementClassifier(registry: registry)

        let outcome = classifier.classify(
            advertisement(
                services: [service],
                manufacturer: ManufacturerData(companyIdentifier: 0x00E0, payload: [0xAA])
            )
        )

        #expect(outcome.category == .helium)
        #expect(outcome.ruleID == "b-high")
        #expect(outcome.confidence == .high)
    }

    @Test("classification ignores the local-name flag entirely")
    func localNameFlagChangesNothing() throws {
        let classifier = AdvertisementClassifier(registry: try referenceRegistry())
        let services = [try serviceUUID(TestUUIDs.heliumService)]

        let withName = classifier.classify(advertisement(services: services, carriesLocalName: true))
        let withoutName = classifier.classify(advertisement(services: services, carriesLocalName: false))

        #expect(withName == withoutName)
    }
}

private extension ClassificationOutcome {
    /// A matched outcome always names the rule that produced it.
    var sourceIsDocumented: Bool {
        reason == .matched && ruleID != nil && confidence != nil && priority != nil
    }
}
