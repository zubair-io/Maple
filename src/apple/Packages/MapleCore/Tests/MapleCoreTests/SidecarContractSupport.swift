// SidecarContractSupport.swift — shared fixtures/helpers for the
// cross-adapter sidecar transaction contract suite (#2431).
//
// The "transaction contract" (issue #2431) is: digest original bytes, parse
// known + unknown sidecar content, commit through the adapter's strongest
// documented atomic-write mechanism, reopen in a NEW session, compare
// semantic adjustments + preserved content, render + export from the
// reopened state, then verify the original digest is unchanged. Every
// `SidecarTransactionContract*Tests.swift` file drives that recipe against
// one declared adapter (filesystem, SMB, PhotoKit, cloud — the four
// `SidecarStoreProtocol` / `ImageSource` conformers named in
// `Sources/ImageSource.swift`'s header comment).
//
// "Same versioned vector format drives every adapter" (acceptance
// criterion #1): every adapter test in this suite is driven by the SAME
// two vectors, defined once here —
//   • `XMPCanonicalFormatTests.canonicalFixtureModel()/canonicalFixtureCulling()`
//     — the cross-Swift/TypeScript golden fixture (`docs/xmp-canonical-format.md`),
//     versioned via the always-emitted `crs:Version`/`crs:ProcessVersion` stamp.
//     Reused rather than duplicated so this suite tracks the same schema
//     version as the canonical-format contract.
//   • `XMPPassthroughTests.lightroomSidecar` — a real Lightroom-authored
//     sidecar carrying unknown (unmodelled) content, for the
//     byte-preservation criterion and the "existing sidecars remain
//     readable" migration criterion.
//
// No mocks for the sidecar layer (CLAUDE.md / CONTRIBUTING.md): every cycle
// round-trips real bytes through a real backing medium (a real temp-dir
// file for filesystem/PhotoKit, a real in-process HTTP transport stub for
// cloud — the one accepted exception, matching `CloudSidecarStoreTests`'s
// existing `URLProtocolStub` convention of faking the network boundary,
// never the XMP parse/serialize logic itself).

import CoreGraphics
import CryptoKit
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import MapleCore

enum SidecarContractVectors {
  /// Vector A: every field the canonical writer emits unconditionally is
  /// non-default (the same golden model documented in
  /// `docs/xmp-canonical-format.md`). Exercises the full authored-field
  /// surface on every adapter.
  static func fullyAuthoredModel() -> AdjustmentModel {
    XMPCanonicalFormatTests.canonicalFixtureModel()
  }

  static func fullyAuthoredCulling() -> CullingState {
    XMPCanonicalFormatTests.canonicalFixtureCulling()
  }

  /// Vector B: a real Lightroom-authored sidecar carrying content Maple
  /// does not model (mask group, snapshot stack, history, a
  /// display-referred PV2012 curve) — reused verbatim from
  /// `XMPPassthroughTests` rather than duplicated, so there is exactly one
  /// copy of this literal in the Swift suite.
  static var passthroughLadenDocument: String { XMPPassthroughTests.lightroomSidecar }

  /// The four unknown child element names `passthroughLadenDocument`
  /// carries — must all survive a read-modify-write on every adapter.
  static var passthroughNodeNames: [String] { XMPPassthroughTests.lightroomNodeNames }
}

enum SidecarContractIO {
  /// Creates a fresh temp directory, cleaned up by the caller's teardown.
  static func makeTempDirectory(prefix: String) throws -> URL {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  /// SHA-256 of a file's current bytes — the "original digest" half of the
  /// transaction contract. Original assets are sacred (CLAUDE.md); this is
  /// what proves a sidecar-write cycle never touched them.
  static func sha256(of url: URL) throws -> String {
    let data = try Data(contentsOf: url)
    let digest = SHA256.hash(data: data)
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  /// Writes a small, real, non-trivial PNG standing in for a RAW original
  /// — deterministic pixel content (not all-zero) so a bit-level mutation
  /// would actually change the digest. Real bytes on real disk, not a
  /// stub: the "original bytes unchanged" assertion must observe real
  /// file I/O, the same class of bug a stray sidecar-write bug would hit.
  @discardableResult
  static func makeSyntheticOriginal(at url: URL) throws -> Data {
    let w = 32
    let h = 32
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(
      data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
      space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    for y in 0..<h {
      for x in 0..<w {
        let r = CGFloat(x) / CGFloat(w)
        let g = CGFloat(y) / CGFloat(h)
        ctx.setFillColor(red: r, green: g, blue: 0.4, alpha: 1.0)
        ctx.fill(CGRect(x: x, y: y, width: 1, height: 1))
      }
    }
    let cg = try XCTUnwrap(ctx.makeImage())
    let dest = try XCTUnwrap(
      CGImageDestinationCreateWithURL(
        url as CFURL, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(dest, cg, nil)
    XCTAssertTrue(CGImageDestinationFinalize(dest))
    return try Data(contentsOf: url)
  }
}

enum SidecarContractFault {
  /// Waits for the first value `errors()` yields, bounded by `timeout`.
  /// A fault-injection test that expects an error MUST NOT await an
  /// unbounded `AsyncStream<Error>.next()` directly: every store's
  /// `errors()` stream never terminates on its own (there is no
  /// `finish()` call anywhere in `writePending()`), so if the injected
  /// fault fails to materialize for any reason, a bare `await
  /// iterator.next()` hangs forever and wedges the whole test run rather
  /// than failing the one test. Returns `nil` on timeout — the caller's
  /// `XCTAssertNotNil` then reports a normal, fast, readable failure.
  static func firstError(
    from stream: AsyncStream<Error>, timeout: Duration = .seconds(5)
  ) async -> Error? {
    await withTaskGroup(of: Error?.self) { group in
      group.addTask {
        var iterator = stream.makeAsyncIterator()
        return await iterator.next()
      }
      group.addTask {
        try? await Task.sleep(for: timeout)
        return nil
      }
      let first = await group.next() ?? nil
      group.cancelAll()
      return first
    }
  }
}

/// Step 6 of the transaction contract ("render preview and export from the
/// reopened state"), run against the non-RAW pipeline exactly like
/// `NonRawExportTests` — no RAW fixture required (those are gitignored and
/// may be absent), so this runs unconditionally rather than skip-passing.
/// It proves the model the adapter handed back after reopen is render- and
/// export-ready; per-pixel color correctness is a different gate
/// (`src/scripts/test_color_pipeline.sh`), not this suite's job.
@MainActor
enum SidecarContractRender {
  static func renderAndExport(originalURL: URL, model: AdjustmentModel) async throws -> Data {
    let pipeline = ImageEditPipeline()
    let decodedOpt = await pipeline.decodeSceneLinearNonRaw(
      asset: AssetRef(url: originalURL), targetSize: nil)
    let decoded = try XCTUnwrap(decodedOpt, "decode returned nil")
    let developed = pipeline.processSceneLinearNonRaw(
      decoded: decoded, model: model, targetSize: nil)
    return try MapleExporter.encodeImage(developed, options: ExportOptions(format: .png))
  }
}
