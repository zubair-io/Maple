// PanoDiskFit.swift — Will the full stitch fit on this device's storage,
// and how small does the output have to be if not (#5555).
//
// A stitch writes two things: the decoded-frame store on the temp volume
// (sized from the input frames, whatever the output size) and the output
// PNG on the output folder's volume (sized from the canvas). Only the PNG
// shrinks with a smaller output, so a store that does not fit cannot be
// helped by one.

import Foundation

// MARK: - PanoFreeSpace

/// Free space where the stitch writes, counted as the core's frame store
/// counts it: space available now, not space the system could purge. The
/// frame download sheet counts purgeable space too, so it can find room
/// the merge then does not.
public struct PanoFreeSpace: Sendable, Equatable {
    public let scratchVolumeBytes: Int
    public let outputVolumeBytes: Int
    public let sameVolume: Bool

    public init(scratchVolumeBytes: Int, outputVolumeBytes: Int, sameVolume: Bool) {
        self.scratchVolumeBytes = scratchVolumeBytes
        self.outputVolumeBytes = outputVolumeBytes
        self.sameVolume = sameVolume
    }

    /// The temp directory's volume and that of `outputFolder`, or of its
    /// nearest existing ancestor, through any symlink: a symlinked folder's
    /// own resource values describe the link's volume, not the target's.
    /// `realpath` rather than `resolvingSymlinksInPath`, which strips
    /// `/private` and so lands back on the `/tmp` and `/var` links.
    static func current(
        outputFolder: URL,
        probe: (URL) -> (free: Int, id: any NSObjectProtocol)? = volume(of:)
    ) -> PanoFreeSpace? {
        guard let scratch = realPath(FileManager.default.temporaryDirectory).flatMap(probe) else { return nil }
        let output = nearestVolume(of: outputFolder.standardizedFileURL, probe: probe) ?? scratch
        return PanoFreeSpace(
            scratchVolumeBytes: scratch.free, outputVolumeBytes: output.free,
            sameVolume: scratch.id.isEqual(output.id))
    }

    /// Stops at the first folder that answers: on a network share each
    /// query can stall.
    private static func nearestVolume(
        of url: URL, probe: (URL) -> (free: Int, id: any NSObjectProtocol)?
    ) -> (free: Int, id: any NSObjectProtocol)? {
        realPath(url).flatMap(probe)
            ?? (url.path == "/" ? nil : nearestVolume(of: url.deletingLastPathComponent(), probe: probe))
    }

    /// `nil` when `url` does not exist.
    static func realPath(_ url: URL) -> URL? {
        guard let resolved = realpath(url.path, nil) else { return nil }
        defer { free(resolved) }
        return URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
    }

    static func volume(of url: URL) -> (free: Int, id: any NSObjectProtocol)? {
        let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityKey, .volumeIdentifierKey])
        guard let free = values?.volumeAvailableCapacity,
              let id = values?.volumeIdentifier as? any NSObjectProtocol else { return nil }
        return (free, id)
    }
}

// MARK: - PanoDiskFit

public enum PanoDiskFit: Sendable, Equatable {
    case fullFits
    /// Full resolution does not fit; this canvas, at the same aspect, does.
    case fitted(PanoFittedCanvas)
    /// Not even a preview-sized output fits; the user has to free about
    /// `shortBytes` for one that does.
    case tooLarge(shortBytes: Int)
}

// MARK: - PanoDiskModel

public struct PanoDiskModel: Sendable, Equatable {
    /// 16-bit RGB before compression; the PNG and its derivatives come in
    /// under it.
    public static let pngBytesPerCanvasPixel = 6
    /// Room left on each volume for everything else writing to it meanwhile.
    public static let reserveBytes = 512 << 20

    public init() {}

    public func fit(sizes: PanoStitchSizes, space: PanoFreeSpace?) -> PanoDiskFit? {
        guard let space, sizes.canvasWidth > 0, sizes.canvasHeight > 0 else { return nil }
        let scratchRoom = space.scratchVolumeBytes - Self.reserveBytes - sizes.scratchBytes
        let pngRoom = space.sameVolume ? scratchRoom : space.outputVolumeBytes - Self.reserveBytes
        let fullPNG = sizes.canvasWidth * sizes.canvasHeight * Self.pngBytesPerCanvasPixel
        if scratchRoom >= 0, fullPNG <= pngRoom { return .fullFits }
        if scratchRoom >= 0, let canvas = sizes.fittedCanvas(maxPixels: max(pngRoom, 0) / Self.pngBytesPerCanvasPixel) {
            return .fitted(canvas)
        }
        let smallestPNG = min(sizes.smallestUsefulCanvasPixels * Self.pngBytesPerCanvasPixel, fullPNG)
        let shortBytes = space.sameVolume
            ? smallestPNG - scratchRoom
            : max(-scratchRoom, 0) + max(smallestPNG - pngRoom, 0)
        return .tooLarge(shortBytes: max(shortBytes, 1 << 20))
    }
}
