// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "PathnodAttestation",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(name: "PathnodAttestation", targets: ["PathnodAttestation"]),
        .library(name: "PathnodDensityCore", targets: ["PathnodDensityCore"]),
    ],
    targets: [
        .target(name: "PathnodAttestation"),
        .testTarget(
            name: "PathnodAttestationTests",
            dependencies: ["PathnodAttestation"]
        ),
        // Foundation only: no CoreBluetooth, no UIKit, no SwiftUI, no third-party
        // dependency. The DEV-08 app target owns every platform framework.
        .target(name: "PathnodDensityCore"),
        .testTarget(
            name: "PathnodDensityCoreTests",
            dependencies: ["PathnodDensityCore"]
        ),
    ]
)
