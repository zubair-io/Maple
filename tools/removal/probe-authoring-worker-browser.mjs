// Actual render-worker retained RAW authoring routes (#3934 / #3955).
import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { resolve, sep } from "node:path";
import { build } from "../../src/web/node_modules/esbuild/lib/main.js";
import { chromium } from "../../src/web/node_modules/playwright/index.mjs";

const [outArg] = process.argv.slice(2);
if (!outArg)
  throw Error("Usage: probe-authoring-worker-browser.mjs OUTPUT_DIR");
const out = resolve(outArg);
await fs.mkdir(out, { recursive: true });
const root = resolve("src/web/projects/maple-common/src/lib/raw-pipeline");
for (const [entry, name] of [
  ["raw-pipeline.worker.ts", "worker.mjs"],
  ["raw-pipeline.removal-client.ts", "client.mjs"],
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
const pkg = resolve(root, "pkg");
const routes = new Map([
  ["/worker.mjs", resolve(out, "worker.mjs")],
  ["/client.mjs", resolve(out, "client.mjs")],
  ["/raw_wasm_bg.wasm", resolve(pkg, "raw_wasm_bg.wasm")],
  ["/source.dng", resolve("test-fixtures/removal/basic/source.dng")],
  ["/saved.xmp", resolve("test-fixtures/removal/calibration/saved.xmp")],
  ["/records.json", resolve("test-fixtures/removal/calibration/records.txt")],
  ["/mask.mimf", resolve("test-fixtures/removal/calibration/mask.mimf")],
  ["/patch.f16", resolve("test-fixtures/removal/calibration/patch.f16")],
]);
const server = createServer(async (request, response) => {
  for (const [name, value] of [
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Embedder-Policy", "require-corp"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
  ])
    response.setHeader(name, value);
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end("<!doctype html><title>Retained removal authoring</title>");
    return;
  }
  const nested = pathname.startsWith("/pkg/")
    ? resolve(pkg, pathname.slice(5))
    : undefined;
  const file =
    routes.get(pathname) ??
    (nested?.startsWith(pkg + sep) ? nested : undefined);
  const stat = file && (await fs.stat(file).catch(() => undefined));
  if (!stat?.isFile()) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.setHeader(
    "Content-Type",
    file.endsWith(".wasm")
      ? "application/wasm"
      : /\.(mjs|js)$/.test(file)
        ? "text/javascript"
        : "application/octet-stream",
  );
  response.setHeader("Content-Length", stat.size);
  createReadStream(file).pipe(response);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
try {
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await page.goto("http://127.0.0.1:" + server.address().port);
  const report = await page.evaluate(async () => {
    const { RemovalAuthoringClient } = await import("/client.mjs");
    const raw = new Uint8Array(
      await (await fetch("/source.dng")).arrayBuffer(),
    );
    const worker = new Worker("/worker.mjs", { type: "module" });
    const pending = new Map(),
      extra = new Map(),
      workerErrors = [];
    let id = 0;
    worker.addEventListener("error", (event) =>
      workerErrors.push(event.message),
    );
    worker.addEventListener("message", ({ data }) => {
      if (data.type === "worker-log" && data.level === "error")
        workerErrors.push(data.text);
      const waiter = pending.get(data.id);
      if (waiter) {
        pending.delete(data.id);
        if (data.type === "removal-authoring-success")
          waiter.resolve(data.value);
        else waiter.reject(Error(data.message ?? "Unexpected authoring reply"));
      }
      const other = extra.get(data.id);
      if (other) {
        extra.delete(data.id);
        data.type.endsWith("error")
          ? other.reject(Error(data.message))
          : other.resolve(data);
      }
    });
    const client = new RemovalAuthoringClient(
      () => worker,
      () => ++id,
      pending,
    );
    const rpc = (request, transfer = []) =>
      new Promise((resolve, reject) => {
        const key = ++id;
        extra.set(key, { resolve, reject });
        worker.postMessage({ ...request, id: key }, transfer);
      });
    const xmp =
      '<rdf:Description xmlns:rdf="x" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:PerspectiveX="100"/>';
    const cropXmp =
      '<rdf:Description xmlns:rdf="x" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:HasCrop="True" crs:CropLeft="0.25" crs:CropRight="0.75" crs:CropTop="0" crs:CropBottom="1" crs:CropAngle="90"/>';
    async function measure() {
      const source = await client.open({
        sourceId: "synthetic",
        bytes: raw,
        ext: "dng",
      });
      const mapped = JSON.parse(
        await client.map(
          xmp,
          '{"schema":1,"points":[[0,0.5],[0.8,0.5],[1.1,0.5]]}',
        ),
      );
      if (
        mapped.points[0] !== null ||
        mapped.points[2] !== null ||
        Math.abs(mapped.points[1][0] - 0.3) > 1e-7
      )
        throw Error("Wrong perspective mapping");
      const crop = JSON.parse(
        await client.map(
          cropXmp,
          '{"schema":1,"crop_input_size":[16,8],"points":[[0.5,0.25]]}',
        ),
      );
      if (JSON.stringify(crop.points) !== "[[0.375,0.5]]")
        throw Error("Wrong crop rotation mapping");
      const context = await client.context([1, 1, 7, 5]);
      if (context.length !== 105 || context.some((v) => !Number.isFinite(v)))
        throw Error("Invalid native context");
      const mask = await client.selection(
        JSON.stringify({
          schema: 1,
          strokes: [{ points: [[0.5, 0.5]], radius: 0.1, subtract: false }],
        }),
      );
      const records = await (await fetch("/records.json")).json();
      const savedXmp = await (await fetch("/saved.xmp")).text();
      const maskBytes = new Uint8Array(
        await (await fetch("/mask.mimf")).arrayBuffer(),
      );
      const patchBytes = new Uint8Array(
        await (await fetch("/patch.f16")).arrayBuffer(),
      );
      const manifest = JSON.stringify([
        {
          name: records[0].accepted.mask.slice(7) + ".mask",
          length: maskBytes.length,
        },
        { name: records[0].patch.slice(7) + ".f16", length: patchBytes.length },
      ]);
      const companions = new Uint8Array(maskBytes.length + patchBytes.length);
      companions.set(maskBytes);
      companions.set(patchBytes, maskBytes.length);
      const generationContext = await client.generationContext(
        savedXmp,
        [1, 1, 7, 5],
        { manifest, bytes: companions },
      );
      if (!generationContext.some((v, i) => v !== context[i]))
        throw Error("Generation context omitted accepted pixels");
      const corrupt = companions.slice();
      corrupt[0] ^= 1;
      let corruptRejected = false;
      try {
        await client.generationContext(savedXmp, [1, 1, 7, 5], {
          manifest,
          bytes: corrupt,
        });
      } catch {
        corruptRejected = true;
      }
      if (!corruptRejected) throw Error("Corrupt generation context accepted");
      let wrongSourceRejected = false;
      try {
        await rpc({
          type: "removal-authoring",
          sourceId: "synthetic",
          ext: "dng",
          original: "blake3:" + "f".repeat(64),
          command: { kind: "context", rect: [0, 0, 1, 1] },
        });
      } catch {
        wrongSourceRejected = true;
      }
      if (!wrongSourceRejected) throw Error("Changed original accepted");
      const repeated = await client.context([1, 1, 7, 5]);
      if (
        !new Uint8Array(context.buffer).every(
          (v, i) => v === new Uint8Array(repeated.buffer)[i],
        )
      )
        throw Error("Rejected request changed context");
      const staleContext = client.context([1, 1, 7, 5]).then(
        () => false,
        (error) => error.name === "AbortError",
      );
      client.close();
      const staleDiscarded = await staleContext;
      if (!staleDiscarded)
        throw Error("Closed authoring published a pending context");
      let closedRejected = false;
      try {
        await client.map(xmp, '{"schema":1,"points":[]}');
      } catch {
        closedRejected = true;
      }
      if (!closedRejected) throw Error("Closed authoring session accepted");
      return {
        source,
        mapped,
        crop,
        context: Array.from(context),
        generationContext: Array.from(generationContext),
        corruptRejected,
        mask: Array.from(mask),
        wrongSourceRejected,
        closedRejected,
        staleDiscarded,
      };
    }
    try {
      const cpu = await measure();
      const bytes = raw.slice().buffer,
        canvas = new OffscreenCanvas(64, 64);
      await rpc(
        {
          type: "open-session",
          bytes,
          ext: "dng",
          canvas,
          maxLongEdge: 64,
          targetColorSpace: "srgb",
        },
        [bytes, canvas],
      );
      const gpu = await measure();
      if (JSON.stringify(cpu) !== JSON.stringify(gpu))
        throw Error("CPU/WebGPU retained authoring drift");
      if (workerErrors.length) throw Error(workerErrors.join("\n"));
      return {
        cpu,
        gpu,
        retainedHostsByteIdentical: true,
        workerErrors,
        crossOriginIsolated,
      };
    } finally {
      client.close();
      worker.terminate();
    }
  });
  await fs.writeFile(
    resolve(out, "report.json"),
    JSON.stringify(
      {
        ...report,
        browser: browser.version(),
        errors,
        releaseQualified: false,
      },
      null,
      2,
    ) + "\n",
  );
  if (errors.length) throw Error(errors.join("\n"));
  console.log(
    JSON.stringify({
      retainedHostsByteIdentical: true,
      browser: browser.version(),
      report: resolve(out, "report.json"),
    }),
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
