// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "PathnodDeviceSimulator",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "pathnod-device-sim", targets: ["PathnodDeviceSimulator"]),
        .library(name: "PathnodDeviceProtocol", targets: ["PathnodDeviceProtocol"]),
    ],
    targets: [
        .target(name: "PathnodDeviceProtocol"),
        .executableTarget(
            name: "PathnodDeviceSimulator",
            dependencies: ["PathnodDeviceProtocol"]
        ),
        .testTarget(
            name: "PathnodDeviceProtocolTests",
            dependencies: ["PathnodDeviceProtocol"]
        ),
    ]
)
