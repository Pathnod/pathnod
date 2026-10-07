import CoreLocation
import CoreMotion
import Foundation
import PathnodObservationCore
import SwiftUI

@MainActor
final class ObservationSensors: NSObject, ObservableObject, @preconcurrency CLLocationManagerDelegate {
    @Published private(set) var locationPermissionPending = false
    @Published private(set) var motionPermissionPending = false
    var permissionsPending: Bool { locationPermissionPending || motionPermissionPending }
    private let location = CLLocationManager()
    private let motion = CMMotionActivityManager()
    private let altimeter = CMAltimeter()
    private var collecting = false
    private var signals = ObservationLocalSignals()

    override init() {
        super.init(); location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func requestLocationPermission() {
        guard location.authorizationStatus == .notDetermined else { return }
        locationPermissionPending = true; location.requestWhenInUseAuthorization()
    }

    func requestMotionPermission() {
        guard CMMotionActivityManager.isActivityAvailable(), CMMotionActivityManager.authorizationStatus() == .notDetermined else { return }
        motionPermissionPending = true
        let now = Date()
        motion.queryActivityStarting(from: now.addingTimeInterval(-1), to: now, to: .main) { [weak self] _, _ in
            Task { @MainActor in self?.motionPermissionPending = false }
        }
    }

    func start(useLocation: Bool, useMotion: Bool) {
        stop(); signals = ObservationLocalSignals(); collecting = true
        if useLocation, [.authorizedAlways, .authorizedWhenInUse].contains(location.authorizationStatus) {
            location.startUpdatingLocation()
        }
        if useMotion, CMMotionActivityManager.authorizationStatus() == .authorized {
            motion.startActivityUpdates(to: .main) { [weak self] activity in
                Task { @MainActor in
                    guard let self, self.collecting, let activity, activity.confidence != .low else { return }
                    self.signals.motionClass = activity.automotive || activity.cycling ? 3 :
                        activity.walking || activity.running ? 2 : activity.stationary ? 1 : 0
                }
            }
            if CMAltimeter.isRelativeAltitudeAvailable() {
                altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] data, _ in
                    Task { @MainActor in
                        guard let self, self.collecting, let data else { return }
                        self.signals.setPressure(kilopascals: data.pressure.doubleValue)
                    }
                }
            }
        }
    }

    func snapshot(rssi: [Int8]) -> ObservationLocalSignals {
        var result = signals; result.rssiSamples = rssi; return result
    }

    func stop() {
        collecting = false; location.stopUpdatingLocation()
        motion.stopActivityUpdates(); altimeter.stopRelativeAltitudeUpdates()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        locationPermissionPending = manager.authorizationStatus == .notDetermined && locationPermissionPending
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard collecting, let latest = locations.last, abs(latest.timestamp.timeIntervalSinceNow) <= 60 else { return }
        signals.setLocation(latitude: latest.coordinate.latitude, longitude: latest.coordinate.longitude, accuracy: latest.horizontalAccuracy)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}
