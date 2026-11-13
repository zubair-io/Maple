// Real Chromium/WASM RT-DETR execution on the identical photographic tensor (#3941).
import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { chromium } from "../../src/web/node_modules/playwright/index.mjs";

const [modelArg, inputArg, metadataArg, runtimeArg, reportArg] =
  process.argv.slice(2);
if (!reportArg)
  throw new Error(
    "Usage: probe-detection-browser.mjs MODEL INPUT.f32 INPUT.json ORT_PACKAGE_DIR REPORT",
  );
const model = resolve(modelArg),
  input = resolve(inputArg),
  runtime = resolve(runtimeArg);
const manifest = JSON.parse(
  await fs.readFile(model.replace(/\.onnx$/, ".json"), "utf8"),
);
const metadata = JSON.parse(await fs.readFile(metadataArg, "utf8"));
const version = JSON.parse(
  await fs.readFile(join(runtime, "package.json"), "utf8"),
).version;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = hash(await fs.readFile(model)),
  inputDigest = hash(await fs.readFile(input));
if (
  version !== "1.30.0" ||
  manifest.source_revision !== "29320b6fd828f8e0987a71426cf2d961b09dfed7" ||
  manifest.artifact_sha256 !== digest ||
  metadata.input_sha256 !== inputDigest
)
  throw new Error("Detector/input provenance mismatch");
if (
  metadata.size.length !== 2 ||
  !metadata.size.every(
    (v) => Number.isSafeInteger(v) && v > 0 && v <= 0xffffffff,
  )
)
  throw new Error("Invalid source dimensions");
const html = `<!doctype html><meta charset="utf-8"><title>Maple local detector probe</title><script src="/ort/ort.min.js"></script><script>
window.probe=async function(size) {
  ort.env.wasm.numThreads=4;ort.env.wasm.wasmPaths='/ort/';
  const buffer=await (await fetch('/input.f32')).arrayBuffer();
  if(buffer.byteLength!==3*640*640*4) throw new Error('Invalid photographic tensor length');
  const data=new Float32Array(buffer);
  if(!data.every(v=>Number.isFinite(v)&&v>=0&&v<=1)) throw new Error('Invalid photographic tensor');
  const tick=performance.now();const session=await ort.InferenceSession.create('/model.onnx',{executionProviders:['wasm']});
  const startupMs=performance.now()-tick;
  const feeds={images:new ort.Tensor('float32',data,[1,3,640,640]),orig_target_sizes:new ort.Tensor('int64',BigInt64Array.from(size,BigInt),[1,2])};
  const times=[];let result;
  for(let run=0;run<6;run++){const start=performance.now();result=await session.run(feeds);times.push(performance.now()-start);}
  if(result.labels.dims.join(',')!=='1,300'||result.boxes.dims.join(',')!=='1,300,4'||result.scores.dims.join(',')!=='1,300') throw new Error('Detector output shape mismatch');
  const labels=Array.from(result.labels.data,Number),boxes=Array.from(result.boxes.data),scores=Array.from(result.scores.data);
  if(!labels.every(v=>Number.isInteger(v)&&v>=0&&v<80)||!boxes.every(Number.isFinite)||!scores.every(v=>Number.isFinite(v)&&v>=0&&v<=1)) throw new Error('Invalid detector output');
  await session.release();
  const warm=times.slice(1).sort((a,b)=>a-b),rank=(warm.length-1)*.95,lo=Math.floor(rank),hi=Math.ceil(rank);
  return {startupMs,elapsedMs:times,warmP95Ms:warm[lo]+(warm[hi]-warm[lo])*(rank-lo),sourceSize:size,allLabels:labels,allBoxes:Array.from({length:300},(_,i)=>boxes.slice(i*4,i*4+4)),allScores:scores,threads:ort.env.wasm.numThreads,crossOriginIsolated};
};</script>`;
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Cache-Control", "no-store");
  if (pathname === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end(html);
    return;
  }
  const path =
    pathname === "/model.onnx"
      ? model
      : pathname === "/input.f32"
        ? input
        : pathname.startsWith("/ort/") &&
            basename(pathname) === pathname.slice(5)
          ? join(runtime, "dist", basename(pathname))
          : undefined;
  if (!path) {
    response.writeHead(404);
    response.end();
    return;
  }
  try {
    const stat = await fs.stat(path);
    response.setHeader("Content-Length", stat.size);
    response.setHeader(
      "Content-Type",
      path.endsWith(".wasm")
        ? "application/wasm"
        : /\.(js|mjs)$/.test(path)
          ? "text/javascript"
          : "application/octet-stream",
    );
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
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
  const result = await page.evaluate(
    async (size) => window.probe(size),
    metadata.size,
  );
  const report = {
    ...result,
    artifactSha256: digest,
    inputSha256: inputDigest,
    imageSha256: metadata.image_sha256,
    onnxruntime: version,
    browser: browser.version(),
    errors,
    releaseQualified: false,
  };
  await fs.writeFile(reportArg, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      warmP95Ms: result.warmP95Ms,
      peopleAtDiagnosticThreshold: result.allLabels
        .map((label, i) => ({
          label,
          box: result.allBoxes[i],
          score: result.allScores[i],
        }))
        .filter((p) => p.label === 0 && p.score >= 0.5),
      errors,
    }),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
