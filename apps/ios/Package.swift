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
    ],
    targets: [
        .target(name: "PathnodAttestation"),
        .testTarget(
            name: "PathnodAttestationTests",
            dependencies: ["PathnodAttestation"]
        ),
    ]
)
