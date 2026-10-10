// Real production worker/client qualification on local fixtures (#3941).
import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { resolve, dirname } from "node:path";
import { build } from "../../src/web/node_modules/esbuild/lib/main.js";
import { chromium } from "../../src/web/node_modules/playwright/index.mjs";

const [
  modelsArg,
  contextArg,
  selectionArg,
  detectionArg,
  anchorArg,
  outputArg,
] = process.argv.slice(2);
if (!outputArg)
  throw new Error(
    "Usage: probe-browser-client.mjs MODELS CONTEXT SELECTION DETECTION ANCHOR_CONTEXT OUTPUT",
  );
const [models, context, selection, detection, anchor, out] = [
  modelsArg,
  contextArg,
  selectionArg,
  detectionArg,
  anchorArg,
  outputArg,
].map((v) => resolve(v));
const repo = resolve(dirname(new URL(import.meta.url).pathname), "../..");
await fs.mkdir(out, { recursive: true });
const root = resolve(repo, "src/web/projects/maple-common/src/lib/removal");
for (const [entry, name] of [
  ["removal-inference-client.ts", "client.mjs"],
  ["removal-inference.worker.ts", "removal-inference.worker"],
  ["../raw-pipeline/pkg/raw_wasm.js", "raw-core.mjs"],
]) {
  await build({
    entryPoints: [resolve(root, entry)],
    bundle: true,
    format: "esm",
    target: "es2022",
    outfile: resolve(out, name),
    logLevel: "silent",
  });
}
const pins = JSON.parse(
  await fs.readFile(
    resolve(repo, "tools/removal/removal-models.generated.json"),
    "utf8",
  ),
);
const routes = new Map([
  ["/client.mjs", resolve(out, "client.mjs")],
  ["/removal-inference.worker", resolve(out, "removal-inference.worker")],
  [
    "/raw_wasm_bg.wasm",
    resolve(repo, "src/raw-pipeline/raw-wasm/pkg/raw_wasm_bg.wasm"),
  ],
  ["/input.f32", resolve(context, "input.f32")],
  ["/masks.f32", resolve(context, "masks.f32")],
  ["/encoder.f32", resolve(selection, "encoder.f32")],
  ["/request.json", resolve(selection, "request.json")],
  ["/source.json", resolve(anchor, "context.json")],
  ["/intent.mimf", resolve(selection, "intent.mimf")],
  ["/detection.f32", resolve(detection, "input.f32")],
  ["/detection.json", resolve(detection, "input.json")],
  ["/raw-core.mjs", resolve(out, "raw-core.mjs")],
  [
    "/proposal-source.dng",
    resolve(repo, "test-fixtures/removal/calibration/source.dng"),
  ],
  [
    "/proposal-saved.xmp",
    resolve(repo, "test-fixtures/removal/calibration/saved.xmp"),
  ],
  [
    "/proposal-records.json",
    resolve(repo, "test-fixtures/removal/calibration/records.txt"),
  ],
  [
    "/proposal-mask.mimf",
    resolve(repo, "test-fixtures/removal/calibration/mask.mimf"),
  ],
  [
    "/proposal-patch.f16",
    resolve(repo, "test-fixtures/removal/calibration/patch.f16"),
  ],
]);
for (const pin of pins)
  routes.set(`/models/${pin.id}`, resolve(models, pin.probe_path));
for (const extension of ["mjs", "wasm"])
  routes.set(
    `/assets/removal-runtime/ort-wasm-simd-threaded.${extension}`,
    resolve(
      repo,
      `src/web/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.${extension}`,
    ),
  );
const reads = [];
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Cache-Control", "no-store");
  if (pathname === "/result.f32" && request.method === "POST") {
    const expectedSize = 3 * 1024 * 1024 * Float32Array.BYTES_PER_ELEMENT;
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > expectedSize) {
        response.writeHead(413);
        response.end();
        return;
      }
      chunks.push(chunk);
    }
    if (size !== expectedSize) {
      response.writeHead(400);
      response.end();
      return;
    }
    await fs.writeFile(resolve(out, "result.f32"), Buffer.concat(chunks, size));
    response.writeHead(204);
    response.end();
    return;
  }
  if (pathname === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Local inference qualification</title>");
    return;
  }
  const file = routes.get(pathname);
  if (!file || request.method !== "GET") {
    response.writeHead(404);
    response.end();
    return;
  }
  const stat = await fs.stat(file).catch(() => undefined);
  if (!stat) {
    response.writeHead(404);
    response.end();
    return;
  }
  reads.push(pathname);
  const type = pathname.endsWith(".wasm")
    ? "application/wasm"
    : pathname.endsWith(".mjs") || pathname.endsWith(".worker")
      ? "text/javascript"
      : pathname.endsWith(".json")
        ? "application/json"
        : "application/octet-stream";
  response.setHeader("Content-Type", type);
  response.setHeader("Content-Length", stat.size);
  createReadStream(file).pipe(response);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const browserContext = await browser.newContext({ serviceWorkers: "block" });
  await browserContext.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  const page = await browserContext.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  const result = await page.evaluate(async (pins) => {
    const { RemovalInferenceClient } = await import("/client.mjs");
    const floats = async (path) => {
      const response = await fetch(path);
      if (!response.ok) throw Error("Missing tensor fixture: " + path);
      return new Float32Array(await response.arrayBuffer());
    };
    const source = (await (await fetch("/source.json")).json()).source_anchor;
    const request = await (await fetch("/request.json")).text();
    const metadata = await (await fetch("/detection.json")).json();
    const models = new Map();
    for (const pin of pins)
      models.set(pin.id, await (await fetch(`/models/${pin.id}`)).blob());
    const corrupt = new RemovalInferenceClient(
      new Map([
        [
          "decoder",
          new Blob([new Uint8Array(pins.find((v) => v.id === "decoder").size)]),
        ],
      ]),
    );
    let checksumRejected = false;
    try {
      await corrupt.refine(JSON.stringify(source), request);
    } catch (error) {
      checksumRejected = error.message.includes("checksum");
    }
    corrupt.dispose();
    if (!checksumRejected) throw new Error("Wrong model bytes were accepted.");
    let client;
    let cancelNext = false;
    let cancelRequestedAt = 0;
    const stages = [];
    client = new RemovalInferenceClient(models, (stage) => {
      stages.push(stage);
      if (cancelNext && stage === "generating") {
        cancelNext = false;
        setTimeout(() => {
          cancelRequestedAt = performance.now();
          client.cancel();
        }, 100);
      }
    });
    const started = performance.now();
    const identity = await client.encode(
      JSON.stringify(source),
      request,
      await floats("/encoder.f32"),
    );
    const encoderMs = performance.now() - started;
    const refineStarted = performance.now();
    const intent = await client.refine(JSON.stringify(source), request);
    const decoderMs = performance.now() - refineStarted;
    const expected = new Uint8Array(
      await (await fetch("/intent.mimf")).arrayBuffer(),
    );
    if (
      intent.length !== expected.length ||
      !intent.every((v, i) => v === expected[i])
    )
      throw new Error("Worker intent differs from native reference.");
    const staleSource = {
      ...source,
      original:
        source.original.slice(0, -1) +
        (source.original.endsWith("0") ? "1" : "0"),
    };
    let staleRejected = false;
    try {
      await client.refine(JSON.stringify(staleSource), request);
    } catch {
      staleRejected = true;
    }
    if (!staleRejected) throw new Error("Stale source embedding was accepted.");
    const detectionStarted = performance.now();
    const detections = await client.detect(
      await floats("/detection.f32"),
      metadata.size,
    );
    const detectionMs = performance.now() - detectionStarted;
    const rgb = await floats("/input.f32");
    const masks = await floats("/masks.f32");
    const hole = masks.slice(0, 1024 * 1024);
    const queuedDetectionInput = await floats("/detection.f32");
    cancelNext = true;
    const epoch = client.epoch;
    const generation = client.generate(rgb.slice(), hole.slice());
    const queued = client.detect(queuedDetectionInput, metadata.size);
    let cancelled = false;
    let generationError;
    try {
      await generation;
    } catch (error) {
      cancelled = error.name === "AbortError";
      generationError = error.message;
    }
    const cancellationMs = performance.now() - cancelRequestedAt;
    let queuedCancelled = false;
    try {
      await queued;
    } catch (error) {
      queuedCancelled = error.name === "AbortError";
    }
    if (!cancelled || !queuedCancelled || client.epoch <= epoch)
      throw new Error(
        "Hard cancellation failed to discard pending work: " +
          JSON.stringify({
            cancelled,
            queuedCancelled,
            epoch: client.epoch,
            priorEpoch: epoch,
            generationError,
            cancelRequestedAt,
          }),
      );
    const retryStarted = performance.now();
    const generated = await client.generate(rgb, hole);
    const retryMs = performance.now() - retryStarted;
    if (
      generated.length !== 3 * 1024 * 1024 ||
      generated.some((v) => !Number.isFinite(v))
    )
      throw new Error("Invalid retry pixels.");
    const saved = await fetch("/result.f32", {
      method: "POST",
      body: generated.buffer,
    });
    if (!saved.ok) throw new Error("Could not save bounded diagnostic pixels.");
    const wasm = await import("/raw-core.mjs");
    await wasm.default({ module_or_path: "/raw_wasm_bg.wasm" });
    const read = async (path) =>
      new Uint8Array(await (await fetch(path)).arrayBuffer());
    const original = await read("/proposal-source.dng");
    const session = new wasm.NativeDetailSession(original, "dng");
    let proposalReport;
    try {
      const prior = await (await fetch("/proposal-records.json")).text();
      const xmp = await (await fetch("/proposal-saved.xmp")).text();
      const priorMask = await read("/proposal-mask.mimf"),
        priorPatch = await read("/proposal-patch.f16");
      const assets = new Map([
        [wasm.removal_content_digest(priorMask).slice(7) + ".mask", priorMask],
        [wasm.removal_content_digest(priorPatch).slice(7) + ".f16", priorPatch],
      ]);
      function install(xmp) {
        const entries = [...assets].map(([name, bytes]) => ({
          name,
          length: bytes.length,
        }));
        const bundle = new Uint8Array(
          entries.reduce((n, v) => n + v.length, 0),
        );
        let offset = 0;
        for (const bytes of assets.values()) {
          bundle.set(bytes, offset);
          offset += bytes.length;
        }
        session.prepare_saved_removals(xmp, JSON.stringify(entries), bundle);
      }
      install(xmp);
      const source = JSON.parse(session.removal_calibration_source());
      const mask = wasm.removal_selection(
        source.width,
        source.height,
        JSON.stringify({
          schema: 1,
          strokes: [{ subtract: false, radius: 0.06, points: [[0.5, 0.5]] }],
        }),
      );
      const maskBefore = mask.slice();
      const masks = JSON.parse(
        wasm.removal_generation_plan(JSON.stringify(source), mask, 1, 1),
      );
      const w = masks.window;
      const scene = session.removal_generation_context(
        xmp,
        Uint32Array.of(w.x, w.y, w.width, w.height),
      );
      const proposal = await client.propose(
        JSON.stringify({ schema: 1, source, masks }),
        prior,
        scene,
        mask,
      );
      if (!mask.every((v, i) => v === maskBefore[i]))
        throw Error("Proposal transferred current editor intent");
      const metadata = JSON.parse(proposal.request);
      const model = wasm.removal_content_digest(
        new Uint8Array(await models.get("lama").arrayBuffer()),
      );
      if (metadata.model !== model)
        throw Error("Proposal does not name the verified graph");
      const records = wasm.removal_prepare(
        proposal.request,
        prior,
        proposal.mask,
        proposal.patch,
      );
      const accepted = JSON.parse(records);
      if (
        accepted.length !== 2 ||
        accepted[1].schema !== 4 ||
        accepted[1].accepted.dependencies.length !== 1
      )
        throw Error("Actual generated proposal lost preceding saved context");
      assets.set(
        wasm.removal_content_digest(proposal.mask).slice(7) + ".mask",
        proposal.mask,
      );
      assets.set(
        wasm.removal_content_digest(proposal.patch).slice(7) + ".f16",
        proposal.patch,
      );
      const savedXmp =
        '<rdf:Description xmlns:rdf="x" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:InpaintRemovals="' +
        records.replaceAll('"', "&quot;") +
        '"/>';
      install(savedXmp);
      const preview = session.render_saved_removals(
        savedXmp,
        16,
        new Uint8Array(),
      );
      const pixels = preview.take_rgb(),
        width = preview.width,
        height = preview.height;
      preview.free();
      const exported = session.export_saved_removals(
        savedXmp,
        JSON.stringify({
          format: "png",
          quality: 100,
          color_space: "srgb",
          max_long_edge: 16,
        }),
        new Uint8Array(),
      );
      const png = exported.chunk(0, exported.byteLength);
      exported.free();
      const bitmap = await createImageBitmap(
        new Blob([png], { type: "image/png" }),
      );
      const canvas = new OffscreenCanvas(width, height),
        ctx = canvas.getContext("2d", { colorSpace: "srgb" });
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const rgba = ctx.getImageData(0, 0, width, height).data;
      if (pixels.some((v, i) => v !== rgba[Math.floor(i / 3) * 4 + (i % 3)]))
        throw Error("Generated saved preview differs from PNG export");
      if (wasm.removal_content_digest(original) !== source.original)
        throw Error("Generation changed original");
      proposalReport = {
        nativeWindow: w,
        model,
        records: accepted.length,
        dependencies: 1,
        patchBytes: proposal.patch.length,
        previewPixels: pixels.length,
        exportIdentical: true,
        originalUnchanged: true,
        selectionRetained: true,
      };
    } finally {
      session.free();
    }
    let lostEmbeddingRejected = false;
    try {
      await client.refine(JSON.stringify(source), request);
    } catch {
      lostEmbeddingRejected = true;
    }
    client.dispose();
    return {
      identity,
      encoderMs,
      decoderMs,
      detectionMs,
      retryMs,
      cancellationMs,
      detections,
      stages,
      checksumRejected,
      staleRejected,
      cancelled,
      queuedCancelled,
      lostEmbeddingRejected,
      intentIdentical: true,
      proposal: proposalReport,
    };
  }, pins);
  const report = result;
  report.release_qualified = false;
  report.qualification =
    "Actual Chromium production worker/client execution; photographic/device/UI gates remain";
  report.browser = browser.version();
  report.runtime = "1.30.0";
  report.pageErrors = errors;
  report.reads = reads;
  await fs.writeFile(
    resolve(out, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  if (errors.length || !report.lostEmbeddingRejected)
    throw new Error("Browser client qualification failed; report saved.");
  console.log(
    JSON.stringify({
      ...report,
      detections: report.detections.length,
      reads: report.reads.length,
    }),
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
