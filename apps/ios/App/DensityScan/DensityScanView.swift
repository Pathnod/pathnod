import PathnodDensityCore
import SwiftUI
import UniformTypeIdentifiers

/// The whole app: one screen, one session, one export.
struct DensityScanView: View {
  @ObservedObject var controller: BLEScanController

  @State private var isShowingDisclosure = false
  @State private var isShowingAbout = false
  @State private var isExporting = false
  @State private var fileExportFailure: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          statusCard
          if let message = controller.availabilityMessage {
            banner(message, systemImage: "antenna.radiowaves.left.and.right.slash")
          }
          if let failure = controller.rulesetFailure {
            banner(failure, systemImage: "exclamationmark.triangle")
          }
          if let failure = controller.exportFailure {
            banner(failure, systemImage: "xmark.octagon")
          }
          timingCard
          countersCard
          ruleCard
          if controller.canExport {
            exportCard
          }
          provenanceCard
        }
        .padding()
      }
      .navigationTitle("Density scan")
      .toolbar {
        ToolbarItem(placement: .navigationBarTrailing) {
          Button {
            isShowingAbout = true
          } label: {
            Label("About this scan", systemImage: "info.circle")
          }
        }
      }
      .safeAreaInset(edge: .bottom) {
        controls
      }
    }
    .sheet(isPresented: $isShowingDisclosure) {
      disclosureSheet(isAcknowledgement: true)
    }
    .sheet(isPresented: $isShowingAbout) {
      disclosureSheet(isAcknowledgement: false)
    }
    .onAppear {
      // The disclosure is shown before the first scan of every launch, and
      // is never stored: nothing about the user is kept between launches.
      isShowingDisclosure = !controller.hasAcknowledgedDisclosure
    }
    .fileExporter(
      isPresented: $isExporting,
      document: controller.exportDocument,
      contentType: .json,
      defaultFilename: controller.exportFileName
    ) { result in
      if case .failure(let error) = result {
        fileExportFailure = error.localizedDescription
      }
    }
  }

  // MARK: - Cards

  private var statusCard: some View {
    card {
      Label(stateTitle, systemImage: stateSymbol)
        .font(.title2.weight(.semibold))
      Text(stateDetail)
        .font(.callout)
        .foregroundStyle(.secondary)
    }
  }

  private var timingCard: some View {
    card {
      Text("Session")
        .font(.headline)
      row("Foreground scanning", duration(controller.summary.foregroundScanSeconds))
      row("Since start", duration(controller.summary.wallClockSeconds))
      row("Interruptions", "\(controller.summary.interruptionCount)")
    }
  }

  private var countersCard: some View {
    card {
      Text("Unique advertisers")
        .font(.headline)
      Text("\(controller.summary.uniqueAdvertisers)")
        .font(.system(size: 44, weight: .semibold, design: .rounded))
        .monospacedDigit()
      Divider()
      ForEach(DensityCategory.allCases, id: \.self) { category in
        row(label(for: category), "\(controller.summary.counts[category] ?? 0)")
      }
      Text("The four counters always add up to the number of unique advertisers.")
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
  }

  private var ruleCard: some View {
    card {
      Text("Rule matches")
        .font(.headline)
      if controller.summary.byRule.isEmpty {
        Text(
          controller.rulesetVersion == "unavailable"
            ? "No ruleset is loaded, so every advertiser is reported as unknown."
            : "No documented rule matched yet, so every advertiser so far is reported as unknown."
        )
        .font(.callout)
        .foregroundStyle(.secondary)
      } else {
        ForEach(controller.summary.byRule, id: \.ruleID) { tally in
          VStack(alignment: .leading, spacing: 2) {
            row(tally.ruleID, "\(tally.count)")
            Text(
              "\(label(for: tally.category)) · \(tally.confidence.rawValue) confidence · \(tally.sourceKind.rawValue)"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            Text(tally.sourceReference)
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
          .padding(.vertical, 2)
        }
      }
    }
  }

  private var exportCard: some View {
    card {
      Text("Export")
        .font(.headline)
      Text(
        "One JSON file with aggregate counters, the ruleset version and the limitations of the method. No device appears in it."
      )
      .font(.callout)
      .foregroundStyle(.secondary)

      Button {
        controller.exportResult()
      } label: {
        Label("Prepare JSON export", systemImage: "square.and.arrow.up.on.square")
      }
      .buttonStyle(.bordered)

      if let url = controller.exportURL {
        ShareLink(item: url) {
          Label("Share or AirDrop", systemImage: "square.and.arrow.up")
        }
        .buttonStyle(.bordered)

        Button {
          isExporting = true
        } label: {
          Label("Save to Files", systemImage: "folder")
        }
        .buttonStyle(.bordered)
      }

      if controller.canDiscard {
        Button(role: .destructive) {
          fileExportFailure = nil
          controller.discardResult()
        } label: {
          Label("Delete result", systemImage: "trash")
        }
        .buttonStyle(.bordered)
      }

      if let failure = fileExportFailure {
        banner("Saving failed: \(failure)", systemImage: "xmark.octagon")
      }
    }
  }

  private var provenanceCard: some View {
    card {
      Text("Provenance")
        .font(.headline)
      row("Ruleset", controller.rulesetVersion)
      row("App", controller.applicationVersion)
      row("Scan mode", "foreground-generic-ble")
      Text(
        "Counting an advertiser is not proof of network membership, ownership, online status or location."
      )
      .font(.footnote)
      .foregroundStyle(.secondary)
    }
  }

  // MARK: - Controls

  private var controls: some View {
    HStack(spacing: 12) {
      if controller.canResume {
        Button {
          controller.resume()
        } label: {
          Label("Resume", systemImage: "play.fill").frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
      } else if controller.canPause {
        Button {
          controller.pause()
        } label: {
          Label("Pause", systemImage: "pause.fill").frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
      } else if controller.canExport {
        Button {
          controller.startNewSession()
        } label: {
          Label("New session", systemImage: "arrow.counterclockwise").frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
      } else {
        Button {
          if controller.hasAcknowledgedDisclosure {
            controller.start()
          } else {
            isShowingDisclosure = true
          }
        } label: {
          Label(
            controller.isAwaitingRadio ? "Starting…" : "Start session",
            systemImage: "dot.radiowaves.left.and.right"
          )
          .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .disabled(!controller.canStart && controller.hasAcknowledgedDisclosure)
      }

      if controller.canStop {
        Button {
          controller.stop()
        } label: {
          Label("Stop", systemImage: "stop.fill").frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
      }
    }
    .padding()
    .background(.bar)
  }

  // MARK: - Disclosure

  private func disclosureSheet(isAcknowledgement: Bool) -> some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          Text("Before you start")
            .font(.title2.weight(.semibold))
          Text(BLEScanController.disclosure)
            .font(.callout)
        }
        .padding()
      }
      .navigationTitle("How this scan works")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button(isAcknowledgement ? "I understand" : "Done") {
            if isAcknowledgement {
              controller.acknowledgeDisclosure()
              isShowingDisclosure = false
            } else {
              isShowingAbout = false
            }
          }
        }
      }
    }
  }

  // MARK: - Presentation helpers

  private var stateTitle: String {
    switch controller.summary.state {
    case .idle: return controller.isAwaitingRadio ? "Starting" : "Ready"
    case .scanning: return "Scanning"
    case .interrupted: return "Interrupted"
    case .finished: return "Finished"
    }
  }

  private var stateSymbol: String {
    switch controller.summary.state {
    case .idle: return "circle.dashed"
    case .scanning: return "dot.radiowaves.left.and.right"
    case .interrupted: return "pause.circle"
    case .finished: return "checkmark.circle"
    }
  }

  private var stateDetail: String {
    switch controller.summary.state {
    case .idle:
      return controller.isAwaitingRadio
        ? "Waiting for Bluetooth. The session starts once the radio is available."
        : "Nothing is being scanned. Start a session to begin counting."
    case .scanning:
      return "Counting advertisers while this app is open. Leaving the app stops the scan."
    case .interrupted:
      return
        "Scanning stopped. Nothing was counted while the app was not in the foreground. Tap Resume to continue."
    case .finished:
      return "The session is closed. Export it, delete it, or start a new one."
    }
  }

  private func label(for category: DensityCategory) -> String {
    switch category {
    case .helium: return "Helium"
    case .wifi: return "Wi-Fi"
    case .ev: return "EV"
    case .unknown: return "Unknown"
    }
  }

  private func duration(_ seconds: Int) -> String {
    let clamped = max(0, seconds)
    return String(format: "%02d:%02d:%02d", clamped / 3600, (clamped % 3600) / 60, clamped % 60)
  }

  private func row(_ title: String, _ value: String) -> some View {
    HStack {
      Text(title)
      Spacer()
      Text(value)
        .monospacedDigit()
        .foregroundStyle(.secondary)
    }
  }

  private func banner(_ message: String, systemImage: String) -> some View {
    Label(message, systemImage: systemImage)
      .font(.callout)
      .padding()
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Color.yellow.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
  }

  private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 8, content: content)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding()
      .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
  }
}

#Preview {
  DensityScanView(controller: BLEScanController())
}
