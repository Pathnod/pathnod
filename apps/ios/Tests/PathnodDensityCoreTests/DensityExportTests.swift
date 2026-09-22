import Foundation
import Testing
import PathnodDensityCore

@Suite("Schema v1 export")
struct DensityExportTests {
    /// The complete set of keys schema v1 is allowed to carry. A field added
    /// without updating this list fails the suite, which is the point.
    private static let allowedTopLevelKeys: Set<String> = [
        "schemaVersion",
        "sessionId",
        "scanMode",
        "rulesetVersion",
        "appVersion",
        "startedAt",
        "endedAt",
        "wallClockSeconds",
        "foregroundScanSeconds",
        "interruptionCount",
        "uniqueAdvertisers",
        "counts",
        "byRule",
        "limitations",
    ]

    private static let allowedRuleRowKeys: Set<String> = [
        "ruleId",
        "category",
        "confidence",
        "sourceKind",
        "sourceReference",
        "count",
    ]

    /// Runs a small mixed session and finishes it.
    private func finishedSession(
        clock: TestDensityClock = TestDensityClock(),
        sessionID: UUID = fixedSessionID()
    ) throws -> (accumulator: SessionAccumulator, peripherals: [UUID]) {
        let accumulator = SessionAccumulator(
            classifier: AdvertisementClassifier(registry: try referenceRegistry()),
            clock: clock,
            makeSessionID: { sessionID }
        )

        accumulator.start()
        clock.advance(by: 30)

        let peripherals = (0..<4).map { _ in UUID() }
        accumulator.recordChecked(
            PeripheralKey(peripherals[0]),
            advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
        )
        accumulator.recordChecked(
            PeripheralKey(peripherals[1]),
            advertisement(services: [try serviceUUID(TestUUIDs.heliumService)])
        )
        accumulator.recordChecked(
            PeripheralKey(peripherals[2]),
            advertisement(manufacturer: ManufacturerData(companyIdentifier: 0x004C, payload: [0x10, 0x20]))
        )
        accumulator.recordChecked(
            PeripheralKey(peripherals[3]),
            advertisement(services: [try serviceUUID(TestUUIDs.unrelatedService)], carriesLocalName: true)
        )

        clock.advance(by: 20)
        accumulator.interrupt()
        clock.advance(by: 10)
        accumulator.resume()
        clock.advance(by: 15)
        accumulator.finish()

        return (accumulator, peripherals)
    }

    private func object(_ data: Data) throws -> [String: Any] {
        let decoded = try JSONSerialization.jsonObject(with: data)
        return try #require(decoded as? [String: Any], "export must be a JSON object")
    }

    @Test("a finished session produces a schema-v1 document")
    func producesSchemaV1() throws {
        let clock = TestDensityClock()
        let session = try finishedSession(clock: clock)

        let document = try DensityExport.makeDocument(
            from: session.accumulator.summary,
            appVersion: "0.1.0 (3)"
        )

        #expect(document.schemaVersion == 1)
        #expect(document.scanMode == "foreground-generic-ble")
        #expect(document.sessionId == fixedSessionID().uuidString)
        #expect(document.rulesetVersion == "test-1")
        #expect(document.appVersion == "0.1.0 (3)")
        #expect(document.startedAt == "2025-09-22T00:00:00Z")
        #expect(document.endedAt == "2025-09-22T00:01:15Z")
        #expect(document.wallClockSeconds == 75)
        #expect(document.foregroundScanSeconds == 65)
        #expect(document.interruptionCount == 1)
        #expect(document.uniqueAdvertisers == 4)
        #expect(document.counts == DensityExportCounts(helium: 2, wifi: 1, ev: 0, unknown: 1))
        #expect(document.limitations == DensityExportV1.requiredLimitations)
    }

    @Test("totals reconcile inside the document")
    func totalsReconcile() throws {
        let session = try finishedSession()
        let document = try DensityExport.makeDocument(
            from: session.accumulator.summary,
            appVersion: "0.1.0"
        )

        #expect(document.counts.total == document.uniqueAdvertisers)
        #expect(document.byRule.reduce(0) { $0 + $1.count } == document.counts.classifiedTotal)
    }

    @Test("rule rows are aggregate, documented and never zero")
    func ruleRowsAreAggregate() throws {
        let session = try finishedSession()
        let document = try DensityExport.makeDocument(
            from: session.accumulator.summary,
            appVersion: "0.1.0"
        )

        #expect(document.byRule.map(\.ruleId) == ["helium-service", "wifi-manufacturer"])
        #expect(document.byRule.allSatisfy { $0.count > 0 })
        #expect(document.byRule.allSatisfy { !$0.sourceReference.isEmpty })

        let helium = try #require(document.byRule.first)
        #expect(helium.category == .helium)
        #expect(helium.confidence == .high)
        #expect(helium.sourceKind == .publishedSpec)
        #expect(helium.count == 2)
    }

    @Test("the encoded JSON carries exactly the schema-v1 keys")
    func encodedKeysAreExactlyTheSchema() throws {
        let session = try finishedSession()
        let data = try DensityExport.makeJSON(
            from: session.accumulator.summary,
            appVersion: "0.1.0"
        )
        let root = try object(data)

        #expect(Set(root.keys) == Self.allowedTopLevelKeys)

        let counts = try #require(root["counts"] as? [String: Any])
        #expect(Set(counts.keys) == ["helium", "wifi", "ev", "unknown"])

        let rows = try #require(root["byRule"] as? [[String: Any]])
        #expect(rows.isEmpty == false)
        for row in rows {
            #expect(Set(row.keys) == Self.allowedRuleRowKeys)
        }

        #expect(root["schemaVersion"] as? Int == 1)
        #expect(root["scanMode"] as? String == "foreground-generic-ble")
    }

    @Test("the encoded JSON reconciles the way the field procedure checks it")
    func encodedJSONReconciles() throws {
        let session = try finishedSession()
        let data = try DensityExport.makeJSON(
            from: session.accumulator.summary,
            appVersion: "0.1.0"
        )
        let root = try object(data)

        let counts = try #require(root["counts"] as? [String: Int])
        let unique = try #require(root["uniqueAdvertisers"] as? Int)

        #expect(counts.values.reduce(0, +) == unique)
        #expect(root["schemaVersion"] as? Int == 1)
    }

    @Test("the encoded JSON contains no peripheral identifier or local name")
    func encodedJSONLeaksNothing() throws {
        let session = try finishedSession()
        let data = try DensityExport.makeJSON(
            from: session.accumulator.summary,
            appVersion: "0.1.0"
        )
        let whole = try #require(String(data: data, encoding: .utf8))

        for identifier in session.peripherals {
            #expect(whole.localizedCaseInsensitiveContains(identifier.uuidString) == false)
        }

        // `limitations` is prose that names the things the file does not carry,
        // so it is stated separately and excluded from the substring sweep.
        var root = try object(data)
        let limitations = try #require(root.removeValue(forKey: "limitations") as? [String])
        #expect(limitations == DensityExportV1.requiredLimitations)

        let payload = try JSONSerialization.data(withJSONObject: root, options: [.sortedKeys])
        let text = try #require(String(data: payload, encoding: .utf8))

        // No advertising field, address, coordinate or per-device row survives.
        for forbidden in [
            "peripheral",
            "identifier",
            "localName",
            "deviceName",
            "address",
            "rssi",
            "manufacturerData",
            "serviceData",
            "advertisement",
            "latitude",
            "longitude",
            "geohash",
            "ssid",
            "bssid",
            "devices",
        ] {
            #expect(
                text.localizedCaseInsensitiveContains(forbidden) == false,
                "export must not mention \(forbidden)"
            )
        }
    }

    @Test("encoding is deterministic")
    func encodingIsDeterministic() throws {
        let session = try finishedSession()
        let summary = session.accumulator.summary

        let first = try DensityExport.makeJSON(from: summary, appVersion: "0.1.0")
        let second = try DensityExport.makeJSON(from: summary, appVersion: "0.1.0")

        #expect(first == second)
    }

    @Test("a document round-trips through the schema")
    func roundTrips() throws {
        let session = try finishedSession()
        let document = try DensityExport.makeDocument(
            from: session.accumulator.summary,
            appVersion: "0.1.0"
        )

        let data = try DensityExport.encode(document)
        let decoded = try JSONDecoder().decode(DensityExportV1.self, from: data)

        #expect(decoded == document)
    }

    @Test("the file name carries only the random session identifier")
    func fileNameIsIdentifierFree() throws {
        let session = try finishedSession()
        let document = try DensityExport.makeDocument(
            from: session.accumulator.summary,
            appVersion: "0.1.0"
        )

        #expect(DensityExport.fileName(for: document) == "pathnod-density-\(fixedSessionID().uuidString).json")
        for identifier in session.peripherals {
            #expect(DensityExport.fileName(for: document).contains(identifier.uuidString) == false)
        }
    }

    @Test("an empty session still exports, with zeroes and no rule rows")
    func emptySessionExports() throws {
        let clock = TestDensityClock()
        let accumulator = SessionAccumulator(
            classifier: AdvertisementClassifier(registry: try ClassificationRegistry.empty(version: "empty-1")),
            clock: clock,
            makeSessionID: { fixedSessionID() }
        )
        accumulator.start()
        clock.advance(by: 5)
        accumulator.finish()

        let document = try DensityExport.makeDocument(from: accumulator.summary, appVersion: "0.1.0")

        #expect(document.uniqueAdvertisers == 0)
        #expect(document.counts == DensityExportCounts(helium: 0, wifi: 0, ev: 0, unknown: 0))
        #expect(document.byRule.isEmpty)
        #expect(document.rulesetVersion == "empty-1")
        #expect(document.limitations.isEmpty == false)
    }

    @Test("an unfinished session cannot be exported", arguments: [
        SessionState.idle,
        SessionState.scanning,
        SessionState.interrupted,
    ])
    func refusesUnfinishedSessions(_ state: SessionState) throws {
        let accumulator = SessionAccumulator(
            classifier: AdvertisementClassifier(registry: try referenceRegistry()),
            clock: TestDensityClock(),
            makeSessionID: { fixedSessionID() }
        )

        switch state {
        case .idle:
            break
        case .scanning:
            accumulator.start()
        case .interrupted:
            accumulator.start()
            accumulator.interrupt()
        case .finished:
            Issue.record("the finished state is exercised elsewhere")
        }

        #expect(accumulator.state == state)
        #expect(throws: DensityExportError.sessionNotFinished(state)) {
            try DensityExport.makeDocument(from: accumulator.summary, appVersion: "0.1.0")
        }
    }

    @Test("a blank app version is refused")
    func refusesBlankAppVersion() throws {
        let session = try finishedSession()

        #expect(throws: DensityExportError.emptyApplicationVersion) {
            try DensityExport.makeDocument(from: session.accumulator.summary, appVersion: "   ")
        }
    }

    @Test("the app version is trimmed")
    func trimsAppVersion() throws {
        let session = try finishedSession()
        let document = try DensityExport.makeDocument(
            from: session.accumulator.summary,
            appVersion: "  0.1.0 (3)\n"
        )

        #expect(document.appVersion == "0.1.0 (3)")
    }

    @Test("counters that do not reconcile are refused rather than exported")
    func refusesUnreconciledCounters() throws {
        let summary = SessionSummary(
            sessionID: fixedSessionID(),
            rulesetVersion: "test-1",
            state: .finished,
            startedAt: Date(timeIntervalSince1970: 0),
            endedAt: Date(timeIntervalSince1970: 60),
            wallClockSeconds: 60,
            foregroundScanSeconds: 60,
            interruptionCount: 0,
            uniqueAdvertisers: 5,
            counts: [.helium: 1, .wifi: 0, .ev: 0, .unknown: 1],
            byRule: [
                RuleTally(
                    ruleID: "helium-service",
                    category: .helium,
                    confidence: .high,
                    sourceKind: .publishedSpec,
                    sourceReference: "fixture",
                    count: 1
                ),
            ]
        )

        #expect(
            throws: DensityExportError.categoryCountsDoNotReconcile(
                uniqueAdvertisers: 5,
                categoryTotal: 2
            )
        ) {
            try DensityExport.makeDocument(from: summary, appVersion: "0.1.0")
        }
    }

    @Test("rule rows that outrun the classified total are refused")
    func refusesUnreconciledRuleRows() throws {
        let summary = SessionSummary(
            sessionID: fixedSessionID(),
            rulesetVersion: "test-1",
            state: .finished,
            startedAt: Date(timeIntervalSince1970: 0),
            endedAt: Date(timeIntervalSince1970: 60),
            wallClockSeconds: 60,
            foregroundScanSeconds: 60,
            interruptionCount: 0,
            uniqueAdvertisers: 2,
            counts: [.helium: 1, .wifi: 0, .ev: 0, .unknown: 1],
            byRule: [
                RuleTally(
                    ruleID: "helium-service",
                    category: .helium,
                    confidence: .high,
                    sourceKind: .publishedSpec,
                    sourceReference: "fixture",
                    count: 2
                ),
            ]
        )

        #expect(throws: DensityExportError.ruleCountsDoNotReconcile(ruleTotal: 2, classifiedTotal: 1)) {
            try DensityExport.makeDocument(from: summary, appVersion: "0.1.0")
        }
    }

    @Test("a zero-count rule row is refused")
    func refusesZeroCountRuleRow() throws {
        let summary = SessionSummary(
            sessionID: fixedSessionID(),
            rulesetVersion: "test-1",
            state: .finished,
            startedAt: Date(timeIntervalSince1970: 0),
            endedAt: Date(timeIntervalSince1970: 60),
            wallClockSeconds: 60,
            foregroundScanSeconds: 60,
            interruptionCount: 0,
            uniqueAdvertisers: 1,
            counts: [.helium: 0, .wifi: 0, .ev: 0, .unknown: 1],
            byRule: [
                RuleTally(
                    ruleID: "helium-service",
                    category: .helium,
                    confidence: .high,
                    sourceKind: .publishedSpec,
                    sourceReference: "fixture",
                    count: 0
                ),
            ]
        )

        #expect(throws: DensityExportError.zeroCountRuleRow(ruleID: "helium-service")) {
            try DensityExport.makeDocument(from: summary, appVersion: "0.1.0")
        }
    }

    @Test("an end timestamp before the start is refused")
    func refusesReversedTimestamps() throws {
        let summary = SessionSummary(
            sessionID: fixedSessionID(),
            rulesetVersion: "test-1",
            state: .finished,
            startedAt: Date(timeIntervalSince1970: 60),
            endedAt: Date(timeIntervalSince1970: 0),
            wallClockSeconds: 0,
            foregroundScanSeconds: 0,
            interruptionCount: 0,
            uniqueAdvertisers: 0,
            counts: [.helium: 0, .wifi: 0, .ev: 0, .unknown: 0],
            byRule: []
        )

        #expect(throws: DensityExportError.endedBeforeStart) {
            try DensityExport.makeDocument(from: summary, appVersion: "0.1.0")
        }
    }

    @Test("timestamps are RFC 3339 in UTC regardless of the device time zone")
    func timestampsAreUTC() {
        let date = Date(timeIntervalSince1970: 1_758_499_200)

        #expect(DensityExport.rfc3339UTC(date) == "2025-09-22T00:00:00Z")
    }
}
