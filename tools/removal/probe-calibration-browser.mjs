// Actual retained-RAW calibration boundary on WASM CPU and WebGPU (#3955).
import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { resolve, sep, extname } from "node:path";
import { chromium } from "../../src/web/node_modules/playwright/index.mjs";

const [rawArg, expectedArg, rectArg, reportArg] = process.argv.slice(2);
if (!reportArg)
  throw new Error(
    "Usage: probe-calibration-browser.mjs RAW EXPECTED_F32 'X,Y,W,H' REPORT",
  );
const rect = rectArg.split(",").map(Number);
if (
  rect.length !== 4 ||
  rect.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffffffff)
)
  throw new Error("Rect must contain four unsigned 32-bit integers");
const shared = resolve("src/raw-pipeline/raw-wasm/pkg");
const files = new Map([
  ["/raw", resolve(rawArg)],
  ["/expected", resolve(expectedArg)],
]);
const html = `<!doctype html><meta charset="utf-8"><script type="module">
import * as shared from '/shared/raw_wasm.js';
window.probe=async function() {
  await shared.default({module_or_path:'/shared/raw_wasm_bg.wasm'});
  const raw=new Uint8Array(await (await fetch('/raw')).arrayBuffer());
  const expected=new Float32Array(await (await fetch('/expected')).arrayBuffer());
  const rect=Uint32Array.from(${JSON.stringify(rect)});
  const ext=${JSON.stringify(extname(rawArg).slice(1).toLowerCase())};
  function measure(session) {
    const start=performance.now(), pixels=session.removal_calibration_context(rect),contextMs=performance.now()-start;
    if(pixels.length!==expected.length||pixels.length!==rect[2]*rect[3]*3) throw new Error('Invalid RGB extent');
    let maxAbsError=0,changedChannels=0;
    const actualBits=new Uint32Array(pixels.buffer,pixels.byteOffset,pixels.length);
    const expectedBits=new Uint32Array(expected.buffer,expected.byteOffset,expected.length);
    for(let i=0;i<pixels.length;i++) {
      if(!Number.isFinite(pixels[i])) throw new Error('Nonfinite calibration pixel');
      maxAbsError=Math.max(maxAbsError,Math.abs(pixels[i]-expected[i]));
      changedChannels+=actualBits[i]!==expectedBits[i]?1:0;
    }
    let invalidGeometryRejected=false;
    try{session.removal_calibration_context(Uint32Array.from([0xffffffff,0,1,1]));}catch{invalidGeometryRejected=true;}
    if(!invalidGeometryRejected) throw new Error('Out-of-source context accepted');
    const repeated=session.removal_calibration_context(rect);
    const repeatedBits=new Uint32Array(repeated.buffer,repeated.byteOffset,repeated.length);
    if(repeatedBits.length!==actualBits.length||!repeatedBits.every((v,i)=>v===actualBits[i])) throw new Error('Failure altered retained RAW');
    return {contextMs,channels:pixels.length,maxAbsError,changedChannels,nativeWasmByteIdentical:changedChannels===0,invalidGeometryRejected,repeatByteIdentical:true};
  }
  const opened=performance.now(), cpu=new shared.NativeDetailSession(raw,ext);
  let cpuResult;
  try{cpuResult={openMs:performance.now()-opened,...measure(cpu)};}finally{cpu.free();}
  let gpuResult={available:false};
  if(navigator.gpu) {
    const started=performance.now();
    const gpu=await shared.WebLiveSession.open(raw,ext,undefined,new OffscreenCanvas(256,256),256,'srgb');
    try{gpuResult={available:true,openMs:performance.now()-started,...measure(gpu)};}finally{gpu.free();}
  }
  return {cpu:cpuResult,gpu:gpuResult,crossOriginIsolated};
};
</script>`;
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
  const modulePath = pathname.startsWith("/shared/")
    ? resolve(shared, pathname.slice(8))
    : undefined;
  const path =
    files.get(pathname) ??
    (modulePath?.startsWith(shared + sep) ? modulePath : undefined);
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
        : path.endsWith(".js")
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
  await page.waitForFunction(() => typeof window.probe === "function");
  const result = await page.evaluate(async () => window.probe());
  const report = {
    ...result,
    browser: browser.version(),
    errors,
    releaseQualified: false,
  };
  await fs.writeFile(reportArg, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  if (
    !report.cpu.nativeWasmByteIdentical ||
    (report.gpu.available && !report.gpu.nativeWasmByteIdentical)
  )
    throw new Error("Native/WASM calibration context drift; see report");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
