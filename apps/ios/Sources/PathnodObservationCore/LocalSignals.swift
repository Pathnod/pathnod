import Foundation

public struct ObservationLocalSignals: Codable, Sendable, Equatable {
    public var geohash6: Data = Data(repeating: 0, count: 6)
    public var gpsAccuracyMeters: UInt16 = 0
    public var barometerHPATimes10: UInt16 = 0
    public var motionClass: UInt8 = 0
    public var wifiBSSIDHash: Data = Data(repeating: 0, count: 32)
    public var rssiSamples: [Int8] = []
    public init() {}

    public mutating func addRSSI(_ value: Int) {
        guard (-127...0).contains(value), rssiSamples.count < 20 else { return }
        rssiSamples.append(Int8(value))
    }

    public mutating func setLocation(latitude: Double, longitude: Double, accuracy: Double) {
        guard latitude.isFinite, longitude.isFinite, accuracy.isFinite, accuracy >= 0,
              (-90...90).contains(latitude), (-180...180).contains(longitude) else { return }
        geohash6 = Self.geohash(latitude: latitude, longitude: longitude)
        gpsAccuracyMeters = UInt16(min(65535, max(1, ceil(accuracy))))
    }

    public mutating func setPressure(kilopascals: Double) {
        guard kilopascals.isFinite, kilopascals > 0, kilopascals * 100 <= 65535 else { return }
        barometerHPATimes10 = UInt16((kilopascals * 100).rounded())
    }

    public func validate() throws {
        let validGeo = geohash6.count == 6 && (geohash6.allSatisfy { $0 == 0 } ||
            geohash6.allSatisfy { Data("0123456789bcdefghjkmnpqrstuvwxyz".utf8).contains($0) })
        guard validGeo, wifiBSSIDHash.count == 32, motionClass <= 3,
              (5...20).contains(rssiSamples.count), rssiSamples.allSatisfy({ (-127...0).contains($0) }) else {
            throw ObservationError.invalidSignals
        }
    }

    private static func geohash(latitude: Double, longitude: Double) -> Data {
        let alphabet = Array("0123456789bcdefghjkmnpqrstuvwxyz".utf8)
        var lat = (-90.0, 90.0), lon = (-180.0, 180.0), result = Data(), value = 0
        for bit in 0..<30 {
            let even = bit % 2 == 0
            let bounds = even ? lon : lat, coordinate = even ? longitude : latitude
            let midpoint = (bounds.0 + bounds.1) / 2
            value = (value << 1) | (coordinate >= midpoint ? 1 : 0)
            if even { lon = coordinate >= midpoint ? (midpoint, lon.1) : (lon.0, midpoint) }
            else { lat = coordinate >= midpoint ? (midpoint, lat.1) : (lat.0, midpoint) }
            if bit % 5 == 4 { result.append(alphabet[value]); value = 0 }
        }
        return result
    }
}
