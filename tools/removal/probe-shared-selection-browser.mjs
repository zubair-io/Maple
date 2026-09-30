// Actual browser execution of Rust stroke/model/native mask boundaries (#3942).
import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { resolve, sep } from "node:path";
import { chromium } from "../../src/web/node_modules/playwright/index.mjs";

const [gesturesArg, preparedArg, logitsArg, scoresArg, expectedArg, reportArg] =
  process.argv.slice(2);
if (!reportArg)
  throw new Error(
    "Usage: probe-shared-selection-browser.mjs GESTURES PREPARED LOGITS SCORES EXPECTED_MIMF REPORT",
  );
const shared = resolve("src/raw-pipeline/raw-wasm/pkg");
const files = new Map([
  ["/gestures.json", resolve(gesturesArg)],
  ["/prepared.json", resolve(preparedArg)],
  ["/logits.f32", resolve(logitsArg)],
  ["/scores.json", resolve(scoresArg)],
  ["/expected.mimf", resolve(expectedArg)],
]);
const html = `<!doctype html><meta charset="utf-8"><title>Maple shared selection probe</title><script type="module">
import * as shared from '/shared/raw_wasm.js';
window.probe=async function() {
  await shared.default({module_or_path:'/shared/raw_wasm_bg.wasm'});
  const gestures=await (await fetch('/gestures.json')).text();
  const expectedRequest=await (await fetch('/prepared.json')).json();
  const prepared=shared.removal_smart_strokes(gestures);
  if(JSON.stringify(JSON.parse(prepared))!==JSON.stringify(expectedRequest)) throw new Error('Native/WASM stroke preparation drift');
  const modelPrompts=JSON.parse(shared.removal_smart_prompts(prepared));
  const logits=new Float32Array(await (await fetch('/logits.f32')).arrayBuffer());
  const scores=Float32Array.from(await (await fetch('/scores.json')).json());
  const expected=new Uint8Array(await (await fetch('/expected.mimf')).arrayBuffer());
  const tick=performance.now(),mask=shared.removal_smart_mask(prepared,logits,scores),boundaryMs=performance.now()-tick;
  if(mask.length!==expected.length||!mask.every((v,i)=>v===expected[i])) throw new Error('Native/WASM accepted mask bytes differ');
  const decoded=new shared.RemovalMask(mask),geometry=decoded.geometry(),pixels=decoded.take_pixels();
  let errorRetainsSelection=false;
  scores[0]=NaN;
  try{shared.removal_smart_mask(prepared,logits,scores);}catch{errorRetainsSelection=true;}
  if(!errorRetainsSelection) throw new Error('Nonfinite model score accepted');
  const tiny=JSON.parse(prepared);tiny.input_width=1;tiny.input_height=1;
  let distortedProxyRejected=false;
  try{shared.removal_smart_prompts(JSON.stringify(tiny));}catch{distortedProxyRejected=true;}
  if(!distortedProxyRejected) throw new Error('Distorted proxy accepted');
  return {geometry:Array.from(geometry),selectedPixels:pixels.reduce((sum,v)=>sum+(v===255?1:0),0),modelPromptCount:modelPrompts.labels.length,
    boundaryMs,maskBytes:mask.length,nativeWasmByteIdentical:true,nonfiniteRejected:errorRetainsSelection,distortedProxyRejected,crossOriginIsolated};
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
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
