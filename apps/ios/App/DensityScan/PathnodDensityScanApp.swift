import SwiftUI

/// The DEV-08 density-scan app.
///
/// One scene, one controller, no persistence. The app declares no background
/// mode, no location usage, no state restoration and no analytics, so the only
/// thing that keeps a scan alive is the app staying in the foreground.
@main
struct PathnodDensityScanApp: App {
    @StateObject private var controller = BLEScanController()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            DensityScanView(controller: controller)
        }
        .onChange(of: scenePhase) { phase in
            controller.handleScenePhase(phase)
        }
    }
}
