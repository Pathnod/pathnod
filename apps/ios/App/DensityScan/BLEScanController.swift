import CoreBluetooth
import Foundation
import OSLog
import PathnodDensityCore
import SwiftUI

/// Drives one foreground density session.
///
/// Everything this type does happens while the app is in the foreground. There
/// is no `bluetooth-central` background mode, no state restoration identifier,
/// no Live Activity, and no connection: ``CBCentralManager/connect(_:options:)``
/// is never called, and the discovered `CBPeripheral` is not retained. The only
/// thing taken from a peripheral is its `identifier`, immediately wrapped in a
/// ``PeripheralKey`` that cannot be printed, encoded or exported.
@MainActor
final class BLEScanController: NSObject, ObservableObject {
    /// What the radio can do right now, as far as CoreBluetooth has told us.
    enum RadioAvailability: Equatable {
        /// CoreBluetooth has not reported a state yet.
        case unknown
        case unsupported
        case unauthorized
        case poweredOff
        case resetting
        case ready

        var allowsScanning: Bool { self == .ready }
    }

    /// The disclosure the user sees before the first scan, and again in the
    /// About sheet. It states the limits of the study rather than selling it.
    static let disclosure = """
        This app counts Bluetooth Low Energy advertisers that are visible while \
        the app is open.

        • Scanning happens only while the app is in the foreground. Switching \
        apps or locking the screen stops it, and resuming is always an explicit \
        tap.
        • It never connects to a device, and never reads anything from one.
        • It never collects your location, and never asks for location access.
        • A device identifier is used only as an ephemeral in-memory \
        deduplication key. Device names and raw advertising payloads are not \
        retained. None of them is displayed, logged or exported.
        • An export contains aggregate counters only.

        "Visible" means the phone received an advertisement. It does not prove \
        that a device belongs to any network, is online, or belongs to anyone in \
        particular.
        """

    @Published private(set) var summary: SessionSummary
    @Published private(set) var availability: RadioAvailability = .unknown
    @Published private(set) var hasAcknowledgedDisclosure = false

    /// Set when the shipped ruleset was rejected. The session still runs, with
    /// every advertiser reported `unknown`.
    @Published private(set) var rulesetFailure: String?

    /// Set when an export could not be produced or written.
    @Published private(set) var exportFailure: String?

    /// The cached export of the finished session, if one was produced.
    @Published private(set) var exportURL: URL?

    /// True between the Start tap and the first usable radio state, which is
    /// also when the system asks for Bluetooth permission. The session clock has
    /// not started yet, so answering the prompt is not an interruption.
    @Published private(set) var isAwaitingRadio = false

    let rulesetVersion: String
    let applicationVersion: String

    private let accumulator: SessionAccumulator
    private let store: DensityExportStore
    private let registry: ClassificationRegistry
    private let log = Logger(subsystem: "xyz.pathnod.densityscan", category: "density-scan")

    /// Created on the first Start, so the system permission prompt appears when
    /// the user asks for a scan rather than when the app launches.
    private var central: CBCentralManager?
    private var ticker: Timer?
    private var exportData: Data?
    private var isSceneActive = true

    init(store: DensityExportStore = DensityExportStore()) {
        self.store = store

        var failure: String?
        var loaded: ClassificationRegistry
        do {
            loaded = try ClassificationRules.makeRegistry()
        } catch {
            loaded = .unavailable
            failure = "The classification ruleset was rejected (\(error)). Every advertiser is reported as unknown."
        }

        registry = loaded
        rulesetVersion = loaded.version
        accumulator = SessionAccumulator(classifier: AdvertisementClassifier(registry: loaded))
        applicationVersion = Self.readApplicationVersion()
        summary = accumulator.summary

        super.init()

        rulesetFailure = failure
        if let failure {
            log.error("ruleset_rejected \(failure, privacy: .public)")
        }

        // Nothing survives a launch: a cached export from a previous run of the
        // process is deleted before the user can reach it.
        _ = clearCachedExport()
        log.notice("launched ruleset=\(loaded.version, privacy: .public) rules=\(loaded.rules.count)")
    }

    // MARK: - Session commands

    func acknowledgeDisclosure() {
        hasAcknowledgedDisclosure = true
    }

    /// Asks for a session.
    ///
    /// The central manager is created here, so the system permission prompt
    /// appears on the first Start rather than at launch. The session itself only
    /// begins once the radio reports that it can scan: a session that started
    /// while Bluetooth was still answering a permission prompt would count an
    /// interruption the user never caused, and would report foreground seconds
    /// during which nothing was scanned.
    func start() {
        guard hasAcknowledgedDisclosure,
              accumulator.state == .idle,
              !isAwaitingRadio,
              isSceneActive
        else { return }

        exportFailure = nil
        guard clearCachedExport() else { return }
        isAwaitingRadio = true

        if central == nil {
            // No restoration identifier: this manager cannot be revived in the
            // background, by design.
            central = CBCentralManager(delegate: self, queue: .main)
        }
        if central?.state == .poweredOn {
            beginSession()
        }
    }

    private func beginSession() {
        guard isSceneActive, accumulator.state == .idle else { return }
        isAwaitingRadio = false
        accumulator.start()
        log.notice("session_started ruleset=\(self.rulesetVersion, privacy: .public)")
        beginScanIfPossible()
        startTicking()
        refresh()
    }

    /// Pauses at the user's request. Identical to a lifecycle interruption: both
    /// require an explicit Resume.
    func pause() {
        interrupt(reason: "user")
    }

    /// Resumes after an explicit tap. Refused while the radio cannot scan, so
    /// the screen never shows "Scanning" over a session that is not.
    func resume() {
        guard accumulator.state == .interrupted, availability.allowsScanning else { return }
        accumulator.resume()
        log.notice("session_resumed interruptions=\(self.summary.interruptionCount)")
        beginScanIfPossible()
        startTicking()
        refresh()
    }

    func stop() {
        guard accumulator.state == .scanning || accumulator.state == .interrupted else { return }
        stopScan()
        stopTicking()
        accumulator.finish()
        refresh()
        log.notice(
            """
            session_finished unique=\(self.summary.uniqueAdvertisers) \
            foregroundSeconds=\(self.summary.foregroundScanSeconds) \
            interruptions=\(self.summary.interruptionCount)
            """
        )
    }

    /// Delete: drops the result and every cached byte of it.
    func discardResult() {
        stopScan()
        stopTicking()
        exportFailure = nil
        guard clearCachedExport() else {
            refresh()
            return
        }
        isAwaitingRadio = false
        accumulator.reset()
        refresh()
        log.notice("session_discarded")
    }

    /// New session: discard, then start again immediately.
    func startNewSession() {
        discardResult()
        guard exportFailure == nil else { return }
        start()
    }

    // MARK: - Export

    /// Builds, validates and caches the schema-v1 export.
    ///
    /// Failure is reported, never papered over: a session whose counters do not
    /// reconcile produces no file at all.
    func exportResult() {
        guard accumulator.state == .finished else { return }

        do {
            let document = try DensityExport.makeDocument(
                from: accumulator.summary,
                appVersion: applicationVersion
            )
            let data = try DensityExport.encode(document)
            exportURL = try store.write(data, named: DensityExport.fileName(for: document))
            exportData = data
            exportFailure = nil
            log.notice("export_written bytes=\(data.count) unique=\(document.uniqueAdvertisers)")
        } catch {
            exportURL = nil
            exportData = nil
            exportFailure = Self.describe(error)
            log.error("export_failed \(Self.describe(error), privacy: .public)")
        }
    }

    /// The current export, for the system file exporter. Aggregate counters
    /// only, so keeping the bytes in memory costs nothing and discloses nothing.
    var exportDocument: DensityExportDocument? {
        exportData.map(DensityExportDocument.init(data:))
    }

    var exportFileName: String {
        exportURL?.lastPathComponent ?? "pathnod-density.json"
    }

    // MARK: - Lifecycle

    /// Stops scanning as soon as the app stops being fully foreground.
    ///
    /// `.inactive` covers the notification-centre pull, the app switcher and the
    /// moment the screen locks; `.background` covers the rest. Coming back to
    /// `.active` deliberately does nothing: the user has to tap Resume.
    func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            isSceneActive = true
            if isAwaitingRadio, central?.state == .poweredOn {
                beginSession()
            }
            refresh()
        case .inactive, .background:
            isSceneActive = false
            interrupt(reason: "lifecycle")
        @unknown default:
            isSceneActive = false
            interrupt(reason: "lifecycle")
        }
    }

    // MARK: - View helpers

    var canStart: Bool {
        hasAcknowledgedDisclosure && isSceneActive && summary.state == .idle && !isAwaitingRadio
    }
    var canPause: Bool { summary.state == .scanning }
    var canResume: Bool { summary.state == .interrupted && availability.allowsScanning }
    var canStop: Bool { summary.state == .scanning || summary.state == .interrupted }
    var canExport: Bool { summary.state == .finished }
    var canDiscard: Bool { summary.state == .finished }

    /// What the radio is doing, in the user's terms. It never claims to be
    /// scanning when it is not.
    var availabilityMessage: String? {
        switch availability {
        case .ready:
            return nil
        case .unknown:
            return central == nil
                ? "Bluetooth is checked when you start a session."
                : "Waiting for Bluetooth to report its state. If iOS is asking for permission, answer it to continue."
        case .unsupported:
            return "This device does not support Bluetooth Low Energy scanning. No session can run."
        case .unauthorized:
            return "Bluetooth access is off for this app. Allow it in Settings › Privacy & Security › Bluetooth, then start a session."
        case .poweredOff:
            return "Bluetooth is off. Turn it on in Settings or Control Centre, then start or resume the session."
        case .resetting:
            return "The Bluetooth connection is resetting. Scanning is paused until it comes back."
        }
    }

    // MARK: - Scanning

    private func beginScanIfPossible() {
        guard accumulator.state == .scanning,
              isSceneActive,
              let central,
              central.state == .poweredOn
        else { return }

        // A generic scan: no service filter, because the study counts everything
        // that advertises. Duplicates are allowed so a later, stronger
        // advertisement from a peripheral already seen can sharpen its category;
        // they cost battery, which the two-hour rehearsal is there to measure.
        central.scanForPeripherals(
            withServices: nil,
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
        )
        log.notice("scan_started")
    }

    private func stopScan() {
        guard let central, central.state == .poweredOn else { return }
        central.stopScan()
        log.notice("scan_stopped")
    }

    private func interrupt(reason: StaticString) {
        guard accumulator.state == .scanning else { return }
        stopScan()
        stopTicking()
        accumulator.interrupt()
        refresh()
        log.notice("session_interrupted reason=\(reason) count=\(self.summary.interruptionCount)")
    }

    private func refresh() {
        summary = accumulator.summary
    }

    private func startTicking() {
        stopTicking()
        // Only drives the elapsed-time labels; counters update on each sighting.
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.refresh()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        ticker = timer
    }

    private func stopTicking() {
        ticker?.invalidate()
        ticker = nil
    }

    @discardableResult
    private func clearCachedExport() -> Bool {
        do {
            try store.clear()
            exportURL = nil
            exportData = nil
            return true
        } catch {
            let message = "Cached exports could not be deleted: \(Self.describe(error))"
            exportFailure = message
            log.error("export_cache_clear_failed \(message, privacy: .public)")
            return false
        }
    }

    // MARK: - Helpers

    private static func readApplicationVersion() -> String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }

    /// Error text is for the user and the log, so it must stay free of anything
    /// a peripheral supplied. Every error surfaced here originates in this app.
    private static func describe(_ error: Error) -> String {
        if let exportError = error as? DensityExportError {
            return String(describing: exportError)
        }
        return (error as NSError).localizedDescription
    }

    /// Reduces one advertisement to the few facts an active rule needs.
    ///
    /// The shipped ruleset declares one service UUID and no company identifier,
    /// so this reads the advertised service list and no manufacturer byte at
    /// all. The local-name entry is never accessed. Everything else in the
    /// dictionary, including the RSSI passed to the delegate, is dropped here.
    nonisolated static func snapshot(
        from advertisementData: [String: Any],
        registry: ClassificationRegistry
    ) -> AdvertisementSnapshot {
        var services: Set<ServiceUUID> = []
        if registry.inspectsServiceUUIDs,
           let advertised = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] {
            for uuid in advertised {
                if let parsed = ServiceUUID(uuid.uuidString) {
                    services.insert(parsed)
                }
            }
        }

        var manufacturer: ManufacturerData?
        if !registry.inspectedCompanyIdentifiers.isEmpty,
           let raw = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data {
            manufacturer = registry.manufacturerDataToInspect(rawAdvertisementBytes: [UInt8](raw))
        }

        return AdvertisementSnapshot(
            serviceUUIDs: services,
            manufacturerData: manufacturer,
            carriesLocalName: false
        )
    }
}

// MARK: - CBCentralManagerDelegate

extension BLEScanController: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        // The manager was created with the main queue, so the callback is
        // already on the main actor.
        MainActor.assumeIsolated {
            apply(state: central.state)
        }
    }

    nonisolated func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        MainActor.assumeIsolated {
            // The peripheral is not retained, not connected to, and not named:
            // only its identifier crosses this line, wrapped so it cannot leave.
            let key = PeripheralKey(peripheral.identifier)
            let snapshot = Self.snapshot(from: advertisementData, registry: registry)
            let known = accumulator.uniqueAdvertisers
            accumulator.record(peripheral: key, advertisement: snapshot)

            // Duplicates are allowed, so in a busy street most callbacks are a
            // peripheral already counted. Rebuilding and publishing the summary
            // for each one would re-render the screen hundreds of times a second
            // for no visible change; the one-second ticker covers the rest,
            // including a reclassification.
            if accumulator.uniqueAdvertisers != known {
                refresh()
            }
        }
    }

    private func apply(state: CBManagerState) {
        switch state {
        case .poweredOn:
            availability = .ready
        case .poweredOff:
            availability = .poweredOff
        case .unauthorized:
            availability = .unauthorized
        case .unsupported:
            availability = .unsupported
        case .resetting:
            availability = .resetting
        case .unknown:
            availability = .unknown
        @unknown default:
            availability = .unknown
        }

        log.notice("radio_state \(String(describing: self.availability), privacy: .public)")

        switch availability {
        case .ready where isAwaitingRadio:
            // The user asked for a session and the radio is finally usable.
            beginSession()
        case .ready:
            // Recovering the radio never resumes a paused session on its own:
            // this only restarts the scan of a session already in `scanning`.
            beginScanIfPossible()
        case .unknown:
            // CoreBluetooth has not committed to anything yet; nothing to undo.
            break
        case .unsupported, .unauthorized, .poweredOff, .resetting:
            // A pending Start is cancelled rather than queued: recovery requires
            // an explicit Start or Resume.
            isAwaitingRadio = false
            interrupt(reason: "radio")
        }
        refresh()
    }
}
