// FilmLookCubeDivergenceTests.swift — MEASURED divergence of the CPU
// `CIColorCubeWithColorSpace` film-look composite (`FilmLookCube.swift`)
// vs. the exact reference chain (#2683 round 2, review item 2).
//
// `FilmLookCube.swift`'s doc comment claimed the divergence from raw-core's
// `film_look::apply` (tetrahedral interpolation, linear-domain strength
// blend) was "small and bounded" WITHOUT a measurement. This test measures
// it directly, isolating JUST the composite step (not decode/WB/AE parity
// between the Swift and Rust pipelines, which is a separate, already-gated
// concern — `test_color_pipeline.sh`):
//
//   1. Render `test_0005.RAF` (saturated color-negative content, per the
//      review's fixture suggestion) via `maple-cli render` with NO film
//      look — this is the exact CPU-chain "no-film" buffer, encoded to a
//      display-sRGB PNG.
//   2. Render the SAME fixture via `maple-cli render` WITH
//      `papp:FilmLook`/`papp:FilmStrength` set — routes through
//      `maple_render_file_with_film`, the exact reference
//      (`EditSession+FilmExport.swift`'s export path uses the same FFI
//      entry). Same binary + `.mlut` pack `test_film_looks.sh` (the
//      existing self-consistency harness for this feature) already uses.
//   3. Load the no-film PNG from step 1 as a `CIImage` and apply
//      `FilmLookCube.apply` to it directly — the review's exact framing
//      ("apply your baked cube via CIContext to the no-film render") —
//      rather than re-deriving a no-film buffer through Swift's own
//      `ImageEditPipeline.processSceneLinear` (an EARLIER version of this
//      test did that and measured mean ΔE ~25 — a decode/WB-anchor
//      mismatch between the ad-hoc Swift decode and maple-cli's render,
//      not a film-composite error; starting from maple-cli's OWN no-film
//      PNG on both sides removes that variable entirely).
//   4. Diff candidate (step 3) vs. reference (step 2) via
//      `compare_images.py` (the one ΔE2000 implementation this repo's
//      color harnesses share).
//
// Both strength 100 and strength 50 are measured.
//
// MEASURED RESULTS (2026-08-10, Apple Silicon, `test_0005.RAF`,
// `color_negative_kodak_portra_400`; deterministic across repeat runs):
//
//   strength 100: mean ΔE2000 = 0.387, p95 = 0.997, max = 2.871
//   strength  50: mean ΔE2000 = 0.518, p95 = 0.994, max = 2.879
//
// Both are far under the "stop and report" bar the review set (mean
// > ~2 ΔE per channel) — sub-1 mean, sub-3 max. Core Image's tri-linear
// cube interpolation vs. raw-core's tetrahedral `tetra_sample`, plus this
// composite's gamma-encoded-domain strength blend vs. raw-core's
// linear-domain blend, cost well under 1 ΔE on average for this fixture.
// Budgets below are pinned ~15% above the measured means/maxes (a one-way
// ratchet, same convention as `test-fixtures/budgets.json`).
//
// Fixture-gated: skips (does not fail) when the RAW fixture, the built
// `maple-cli` release binary, the `.mlut` pack, or `python3` +
// `compare_images.py`'s `colour`/`numpy`/`Pillow` deps are unavailable —
// mirrors every other perceptual-harness gate in this repo (CI without
// gitignored fixtures is a soft pass).

import XCTest
import CoreImage
import CoreGraphics
#if canImport(AppKit)
import AppKit
#endif
@testable import MapleCore

final class FilmLookCubeDivergenceTests: XCTestCase {

    // MARK: - Repo paths

    /// Walk from `#filePath` to the repo root — same depth as
    /// `SceneLinearVisualRegressionTests.repoRoot()`.
    private static func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // MapleCore/
            .deletingLastPathComponent()  // Packages/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // repo root
    }

    private static let rawFixtureName = "test_0005.RAF"
    private static let lookID = "color_negative_kodak_portra_400"

    /// ~15% above the measured numbers in the header comment — a one-way
    /// ratchet (only tightens), same convention `test-fixtures/budgets.json`
    /// uses for the end-to-end color harness.
    private static let strength100MeanBudget = 0.45
    private static let strength100MaxBudget = 3.35
    private static let strength50MeanBudget = 0.60
    private static let strength50MaxBudget = 3.35

    // MARK: - Test

    func testCIColorCubeCompositeDivergenceFromExactFFIReference() throws {
        let root = Self.repoRoot()
        let rawURL = root.appendingPathComponent("test-fixtures/raws/\(Self.rawFixtureName)")
        let lutDirURL = root.appendingPathComponent("resources/film-luts")
        let cliURL = root.appendingPathComponent("src/raw-pipeline/target/release/maple-cli")
        let comparePyURL = root.appendingPathComponent("src/scripts/compare_images.py")

        for (label, url) in [
            ("RAW fixture", rawURL), ("film-lut pack", lutDirURL),
            ("maple-cli release binary", cliURL), ("compare_images.py", comparePyURL),
        ] {
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw XCTSkip("\(label) missing at \(url.path) — fixture-gated, skipping")
            }
        }
        guard Self.pythonHasDeps() else {
            throw XCTSkip("python3 (or its numpy/Pillow/colour deps) unavailable — skipping")
        }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-film-cube-divergence-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        // ---- 1. maple-cli: no-film render + the two exact film references -

        let noFilmXMP = tmp.appendingPathComponent("no_film.xmp")
        let refXMP100 = tmp.appendingPathComponent("ref_100.xmp")
        let refXMP50 = tmp.appendingPathComponent("ref_50.xmp")
        try Self.writeXMP(filmLook: false, strength: nil, to: noFilmXMP)
        try Self.writeXMP(filmLook: true, strength: nil, to: refXMP100)   // silence-on-default => 100
        try Self.writeXMP(filmLook: true, strength: 50, to: refXMP50)

        let noFilmPath = tmp.appendingPathComponent("no_film.png")
        let reference100Path = tmp.appendingPathComponent("reference_100.png")
        let reference50Path = tmp.appendingPathComponent("reference_50.png")
        try Self.runMapleCLIRender(cli: cliURL, raw: rawURL, xmp: noFilmXMP, out: noFilmPath, lutDir: lutDirURL)
        try Self.runMapleCLIRender(cli: cliURL, raw: rawURL, xmp: refXMP100, out: reference100Path, lutDir: lutDirURL)
        try Self.runMapleCLIRender(cli: cliURL, raw: rawURL, xmp: refXMP50, out: reference50Path, lutDir: lutDirURL)

        // ---- 2. Candidate: FilmLookCube composited on the no-film PNG -----

        guard let noFilmImage = CIImage(contentsOf: noFilmPath) else {
            XCTFail("Could not load \(noFilmPath.path) as a CIImage")
            return
        }

        // `FilmLutStore()`'s default `bundle: .main` resolves against the
        // APP target's bundle (where the real 100-look catalog folder
        // reference lands at runtime) — under `swift test` that's the test
        // runner's own bundle, which has none of it (only
        // `FilmLutStoreTests`' tiny fixture `.mlut`, via `.module`). Point
        // a bundle straight at the repo's `resources/` dir instead, so
        // `bundle.url(forResource:withExtension:subdirectory:"film-luts")`
        // resolves the same way it does inside the shipped app.
        guard let lutBundle = Bundle(url: root.appendingPathComponent("resources")) else {
            XCTFail("Could not open a Bundle rooted at \(root.appendingPathComponent("resources").path)")
            return
        }
        let store = FilmLutStore(bundle: lutBundle)
        guard let lattice = store.lattice(for: Self.lookID) else {
            XCTFail("FilmLutStore could not resolve \(Self.lookID) — .mlut pack present but this id is missing?")
            return
        }

        let candidate100 = FilmLookCube.apply(to: noFilmImage, lattice: lattice, strengthPct: 100)
        let candidate50 = FilmLookCube.apply(to: noFilmImage, lattice: lattice, strengthPct: 50)

        let candidate100Path = tmp.appendingPathComponent("candidate_100.png")
        let candidate50Path = tmp.appendingPathComponent("candidate_50.png")
        try Self.encodePNG(candidate100, to: candidate100Path)
        try Self.encodePNG(candidate50, to: candidate50Path)

        // ---- 3. Diff --------------------------------------------------------

        let delta100 = try Self.compareImages(
            candidate: candidate100Path, reference: reference100Path, comparePy: comparePyURL
        )
        let delta50 = try Self.compareImages(
            candidate: candidate50Path, reference: reference50Path, comparePy: comparePyURL
        )

        // Print unconditionally (not just on failure) — this is the
        // measurement the review asked for, not just a pass/fail gate.
        print(
            "FilmLookCubeDivergenceTests: strength=100 mean=\(delta100.meanDeltaE) " +
            "p95=\(delta100.p95DeltaE) max=\(delta100.maxDeltaE)"
        )
        print(
            "FilmLookCubeDivergenceTests: strength=50 mean=\(delta50.meanDeltaE) " +
            "p95=\(delta50.p95DeltaE) max=\(delta50.maxDeltaE)"
        )

        XCTAssertLessThanOrEqual(
            delta100.meanDeltaE, Self.strength100MeanBudget,
            "strength-100 mean ΔE2000 regressed past budget"
        )
        XCTAssertLessThanOrEqual(
            delta100.maxDeltaE, Self.strength100MaxBudget,
            "strength-100 max ΔE2000 regressed past budget"
        )
        XCTAssertLessThanOrEqual(
            delta50.meanDeltaE, Self.strength50MeanBudget,
            "strength-50 mean ΔE2000 regressed past budget"
        )
        XCTAssertLessThanOrEqual(
            delta50.maxDeltaE, Self.strength50MaxBudget,
            "strength-50 max ΔE2000 regressed past budget"
        )
    }

    // MARK: - Helpers

    private static func encodePNG(_ image: CIImage, to url: URL) throws {
        let outputSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        let context = CIContext(options: [.workingColorSpace: outputSpace])
        let extent = image.extent
        guard extent.width > 0, extent.height > 0,
              let cg = context.createCGImage(image, from: extent, format: .RGBA8, colorSpace: outputSpace)
        else {
            throw NSError(domain: "FilmLookCubeDivergenceTests", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "createCGImage failed for \(url.lastPathComponent)",
            ])
        }
        #if canImport(AppKit)
        let rep = NSBitmapImageRep(cgImage: cg)
        guard let data = rep.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "FilmLookCubeDivergenceTests", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "PNG encode failed for \(url.lastPathComponent)",
            ])
        }
        try data.write(to: url)
        #else
        throw NSError(domain: "FilmLookCubeDivergenceTests", code: 3, userInfo: [
            NSLocalizedDescriptionKey: "PNG encode needs AppKit (macOS-only test)",
        ])
        #endif
    }

    /// Same XMP shape `test_film_looks.sh`'s `write_xmp` uses, plus an
    /// explicit `papp:Profile="Neutral"` (that script leaves profile at its
    /// default `Auto`; this test wants Neutral so the no-film and film
    /// renders don't also carry Auto Profile's own per-image curve fit,
    /// which is an orthogonal, already-covered concern).
    private static func writeXMP(filmLook: Bool, strength: Double?, to url: URL) throws {
        var attrs = " papp:Profile=\"Neutral\""
        if filmLook {
            attrs += " papp:FilmLook=\"\(lookID)\""
        }
        if let strength {
            attrs += " papp:FilmStrength=\"\(strength)\""
        }
        let xml = """
        <?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="maple:papp/1.0/"\(attrs)/></rdf:RDF></x:xmpmeta>
        """
        try xml.write(to: url, atomically: true, encoding: .utf8)
    }

    private static func runMapleCLIRender(cli: URL, raw: URL, xmp: URL, out: URL, lutDir: URL) throws {
        let process = Process()
        process.executableURL = cli
        process.arguments = [
            "render", raw.path, "--params", xmp.path, "--out", out.path,
            "--format", "png", "--film-lut-dir", lutDir.path,
        ]
        let errPipe = Pipe()
        process.standardError = errPipe
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            let errStr = String(data: errData, encoding: .utf8) ?? "<no stderr>"
            throw NSError(domain: "maple-cli", code: Int(process.terminationStatus), userInfo: [
                NSLocalizedDescriptionKey: "maple-cli render failed: \(errStr)",
            ])
        }
    }

    private struct DeltaEResult: Decodable {
        let meanDeltaE: Double
        let p95DeltaE: Double
        let maxDeltaE: Double

        enum CodingKeys: String, CodingKey {
            case meanDeltaE = "mean_deltaE"
            case p95DeltaE = "p95_deltaE"
            case maxDeltaE = "max_deltaE"
        }
    }

    private static func compareImages(candidate: URL, reference: URL, comparePy: URL) throws -> DeltaEResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["python3", comparePy.path, candidate.path, reference.path]
        let outPipe = Pipe()
        process.standardOutput = outPipe
        try process.run()
        process.waitUntilExit()
        let data = outPipe.fileHandleForReading.readDataToEndOfFile()
        guard process.terminationStatus == 0 else {
            let text = String(data: data, encoding: .utf8) ?? "<no output>"
            throw NSError(domain: "compare_images.py", code: Int(process.terminationStatus), userInfo: [
                NSLocalizedDescriptionKey: "compare_images.py failed: \(text)",
            ])
        }
        return try JSONDecoder().decode(DeltaEResult.self, from: data)
    }

    /// Cheap `python3 -c "import numpy, PIL, colour"` probe — the same deps
    /// `test_color_pipeline.sh`/`test_film_looks.sh` require, so a
    /// development machine that already runs those has them; a fresh CI box
    /// without fixtures never reaches this check anyway (the fixture guards
    /// above throw first).
    private static func pythonHasDeps() -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["python3", "-c", "import numpy, PIL, colour"]
        process.standardOutput = Pipe()
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }
}
