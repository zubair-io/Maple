// PanoAutoCropRecord.swift — Auto Crop as a crop in the panorama's XMP sidecar
// (#5608). The stitched PNG keeps its whole canvas; the largest fully covered
// rectangle the engine found is written as the standard crop fields beside it,
// and a `tEXt` chunk in the PNG records the rectangle so the cropped and
// uncropped stitches of the same frames are different files by content, as the
// library identifies a file by its bytes.

import Foundation

enum PanoAutoCropRecord {
    static let markKeyword = "Maple Auto Crop"

    /// The sidecar that crops to `crop`; `nil` when the rectangle is the whole
    /// image or does not fit it.
    static func sidecarXML(for crop: PanoAutoCrop) -> String? {
        guard crop.cropsAnything else { return nil }
        let width = Double(crop.outputWidth)
        let height = Double(crop.outputHeight)
        let model = AdjustmentModel(
            crop: Crop(
                top: Double(crop.y) / height,
                left: Double(crop.x) / width,
                bottom: Double(crop.y + crop.height) / height,
                right: Double(crop.x + crop.width) / width))
        return XMPSerializer.serialize(model: model, culling: CullingState())
    }

    /// Writes the crop sidecar beside `panorama` and marks the PNG. Does nothing
    /// when the rectangle is no crop. An existing sidecar is never replaced.
    static func record(_ crop: PanoAutoCrop, forPanorama panorama: URL) throws {
        guard let xml = sidecarXML(for: crop) else { return }
        try Data(xml.utf8).write(
            to: SidecarPath.sidecarURL(for: panorama), options: .withoutOverwriting)
        try markPNG(at: panorama, with: crop)
    }

    static func markText(_ crop: PanoAutoCrop) -> String {
        "\(crop.x),\(crop.y),\(crop.width),\(crop.height)"
    }

    /// Inserts the mark before the closing `IEND` chunk.
    static func markPNG(at url: URL, with crop: PanoAutoCrop) throws {
        let handle = try FileHandle(forUpdating: url)
        defer { try? handle.close() }
        let size = try handle.seekToEnd()
        let iend = Data([0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82])
        guard size >= UInt64(iend.count) else { throw CocoaError(.fileReadCorruptFile) }
        try handle.seek(toOffset: size - UInt64(iend.count))
        guard try handle.read(upToCount: iend.count) == iend else {
            throw CocoaError(.fileReadCorruptFile)
        }
        try handle.truncate(atOffset: size - UInt64(iend.count))
        try handle.seekToEnd()
        try handle.write(contentsOf: chunk("tEXt", Data("\(markKeyword)\0\(markText(crop))".utf8)))
        try handle.write(contentsOf: iend)
        try handle.synchronize()
    }

    static func chunk(_ type: String, _ data: Data) -> Data {
        var length = UInt32(data.count).bigEndian
        var checksum = crc32(Data(type.utf8) + data).bigEndian
        return withUnsafeBytes(of: &length) { Data($0) } + Data(type.utf8) + data
            + withUnsafeBytes(of: &checksum) { Data($0) }
    }

    private static let crcTable: [UInt32] = (0..<256).map { index in
        (0..<8).reduce(UInt32(index)) { value, _ in
            value & 1 == 1 ? 0xEDB8_8320 ^ (value >> 1) : value >> 1
        }
    }

    static func crc32(_ data: Data) -> UInt32 {
        ~data.reduce(UInt32.max) { crc, byte in
            crcTable[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8)
        }
    }
}
