// acr_batch.jsx — ACR reference render driver for Photoshop 2026.
//
// Reads test-fixtures/references/manifest.json and produces one PNG per
// (raw, xmp, tier) triple. Matches REFERENCES.md § "How acr_batch.jsx works":
//
//   1. Copy the case XMP to <raw_basename>.xmp next to the RAW.
//   2. app.open(RAW) — ACR reads the sidecar and applies overrides.
//   3. Convert to sRGB, 8 bit.
//   4. full tier: saveAs PNG at native. down tier: BICUBICSHARPER to
//      long-edge = 4000, then saveAs PNG.
//   5. Close without saving.
//
// Photoshop's ExtendScript lacks native JSON and Date.toISOString; we use
// eval() (safe — we generated the manifest ourselves) and manual pad2().
//
// How to run:
//   A) One-liner from a shell:
//        osascript -e 'tell application "Adobe Photoshop 2026" to \
//            do javascript of file "/Users/riabuz/Projects/_Maple/src/scripts/acr-reference/acr_batch.jsx"'
//   B) From inside Photoshop: File > Scripts > Browse... → pick this file.
//
// Tunable — edit this constant if your manifest lives elsewhere:
var MANIFEST_PATH =
    "/Users/riabuz/Projects/_Maple/test-fixtures/references/manifest.json";
var LOG_PATH =
    "/Users/riabuz/Projects/_Maple/test-fixtures/references/acr_batch.log";

// ─────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────
function pad2(n) { return (n < 10 ? "0" : "") + n; }

function nowIso() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
        "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function readText(path) {
    var f = new File(path);
    if (!f.exists) throw new Error("File not found: " + path);
    f.encoding = "UTF-8";
    f.open("r");
    var txt = f.read();
    f.close();
    return txt;
}

function writeText(path, text, append) {
    var f = new File(path);
    f.encoding = "UTF-8";
    f.open(append ? "a" : "w");
    f.write(text);
    f.close();
}

function copyFile(srcPath, dstPath) {
    var src = new File(srcPath);
    var dst = new File(dstPath);
    if (!src.exists) throw new Error("copyFile: missing src " + srcPath);
    // File#copy silently returns false on failure; catch that explicitly.
    if (!src.copy(dst)) {
        throw new Error("copyFile failed: " + srcPath + " → " + dstPath);
    }
}

function ensureDir(path) {
    var d = new Folder(path);
    if (!d.exists) d.create();
}

function dirname(p) {
    var i = p.lastIndexOf("/");
    return i < 0 ? "." : p.substring(0, i);
}

function basenameNoExt(p) {
    var i = p.lastIndexOf("/");
    var base = i < 0 ? p : p.substring(i + 1);
    var j = base.lastIndexOf(".");
    return j < 0 ? base : base.substring(0, j);
}

function extOf(p) {
    var i = p.lastIndexOf(".");
    return i < 0 ? "" : p.substring(i);
}

function log(msg) {
    var line = "[" + nowIso() + "] " + msg + "\n";
    try { writeText(LOG_PATH, line, true); } catch (e) { /* best effort */ }
    $.writeln(line);
}

// ─────────────────────────────────────────────────────────────────
// Per-case render
// ─────────────────────────────────────────────────────────────────
function renderCase(kase) {
    var rawPath = kase.raw;
    var xmpPath = kase.xmp;
    var outputs = kase.outputs;

    // 1. Copy XMP next to RAW so ACR picks it up on open.
    var sidecarPath = dirname(rawPath) + "/" + basenameNoExt(rawPath) + ".xmp";
    copyFile(xmpPath, sidecarPath);

    // 2. Open — ACR applies crs: overrides from the sidecar.
    var t0 = new Date().getTime();
    var doc = app.open(new File(rawPath));

    // 3. Normalize to sRGB 8-bit.
    doc.convertProfile(
        "sRGB IEC61966-2.1",
        Intent.RELATIVECOLORIMETRIC,
        true,  // blackPointCompensation
        true   // dither
    );
    doc.bitsPerChannel = BitsPerChannelType.EIGHT;

    // 4. Save each tier.
    //    Save 'full' BEFORE any resize so it captures the native-resolution
    //    output. 'down' then resizes the *same* document in place.
    var saveOrder = [];
    for (var i = 0; i < outputs.length; i++) {
        if (outputs[i].resolution === "full") saveOrder.push(outputs[i]);
    }
    for (var j = 0; j < outputs.length; j++) {
        if (outputs[j].resolution === "down") saveOrder.push(outputs[j]);
    }

    for (var k = 0; k < saveOrder.length; k++) {
        var out = saveOrder[k];
        ensureDir(dirname(out.png));

        if (out.resolution === "down") {
            // Long-edge clamp to 4000 px via BICUBICSHARPER.
            var w = doc.width.as("px");
            var h = doc.height.as("px");
            var longEdge = (w >= h) ? w : h;
            if (longEdge > out.long_edge) {
                var scale = out.long_edge / longEdge;
                var newW = Math.round(w * scale);
                var newH = Math.round(h * scale);
                doc.resizeImage(
                    UnitValue(newW, "px"),
                    UnitValue(newH, "px"),
                    doc.resolution,
                    ResampleMethod.BICUBICSHARPER
                );
            }
        }

        var pngOpts = new PNGSaveOptions();
        pngOpts.compression = 6;
        pngOpts.interlaced = false;
        doc.saveAs(new File(out.png), pngOpts, true, Extension.LOWERCASE);
    }

    // 5. Close without saving (never touch the RAW).
    doc.close(SaveOptions.DONOTSAVECHANGES);

    var dt = new Date().getTime() - t0;
    log("OK   " + kase.name + "  (" + outputs.length + " PNG" + (outputs.length > 1 ? "s" : "") + ", " + dt + " ms)");
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────
function main() {
    // Force deterministic output settings.
    app.preferences.rulerUnits = Units.PIXELS;
    app.preferences.typeUnits = TypeUnits.PIXELS;
    app.displayDialogs = DialogModes.NO;

    // Clear the log for this run.
    try { var lf = new File(LOG_PATH); if (lf.exists) lf.remove(); } catch (e) {}

    log("acr_batch.jsx starting");
    log("manifest: " + MANIFEST_PATH);

    var raw = readText(MANIFEST_PATH);
    // ExtendScript has no JSON; manifest.json is a JS literal at the top level,
    // so eval() with the object-literal wrapper parses it safely. We generated
    // this file, so eval is not an untrusted-input concern.
    // eslint-disable-next-line no-eval
    var manifest = eval("(" + raw + ")");

    if (!manifest || !manifest.cases || !manifest.cases.length) {
        throw new Error("manifest.json has no cases[]");
    }
    log("cases: " + manifest.cases.length);

    var okCount = 0;
    var failCount = 0;
    var lastSidecar = null;

    for (var i = 0; i < manifest.cases.length; i++) {
        var kase = manifest.cases[i];
        try {
            renderCase(kase);
            okCount++;
            lastSidecar = dirname(kase.raw) + "/" + basenameNoExt(kase.raw) + ".xmp";
        } catch (e) {
            failCount++;
            log("FAIL " + (kase.name || "<unnamed>") + ": " + (e.message || e));
        }
    }

    // Best-effort: remove the last sidecar we left next to a RAW.
    // run.py --cleanup-only handles the general case across all RAWs.
    if (lastSidecar) {
        try {
            var sc = new File(lastSidecar);
            if (sc.exists) sc.remove();
        } catch (e) { /* harmless */ }
    }

    log("done — ok: " + okCount + ", fail: " + failCount);

    alert("ACR batch complete\nOK:   " + okCount + "\nFail: " + failCount +
          "\n\nSee acr_batch.log for per-case timing.");
}

main();
