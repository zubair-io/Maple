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
    const floats = async (path) =>
      new Float32Array(await (await fetch(path)).arrayBuffer());
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
    cancelNext = true;
    const epoch = client.epoch;
    const generation = client.generate(rgb.slice(), hole.slice());
    const queued = client.detect(await floats("/detection.f32"), metadata.size);
    let cancelled = false;
    try {
      await generation;
    } catch (error) {
      cancelled = error.name === "AbortError";
    }
    const cancellationMs = performance.now() - cancelRequestedAt;
    let queuedCancelled = false;
    try {
      await queued;
    } catch (error) {
      queuedCancelled = error.name === "AbortError";
    }
    if (!cancelled || !queuedCancelled || client.epoch <= epoch)
      throw new Error("Hard cancellation failed to discard pending work.");
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
