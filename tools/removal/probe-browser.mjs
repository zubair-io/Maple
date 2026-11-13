// Actual Chromium/WASM model execution probe (#3941). Only a loopback server
// serves the pinned model, runtime and supplied native crop; no remote requests.
import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "../../src/web/node_modules/playwright/index.mjs";

const [kind, modelArg, imageArg, runtimeArg, reportArg] = process.argv.slice(2);
if (!["migan", "lama", "lama-scene"].includes(kind) || !reportArg) {
  throw new Error(
    "Usage: probe-browser.mjs migan|lama|lama-scene MODEL IMAGE_OR_FLOAT_INPUT ORT_PACKAGE_DIR REPORT",
  );
}
const model = resolve(modelArg);
const image = resolve(imageArg);
const runtime = resolve(runtimeArg);
const packageInfo = JSON.parse(
  await fs.readFile(join(runtime, "package.json"), "utf8"),
);
if (packageInfo.version !== "1.30.0")
  throw new Error("Expected pinned ONNX Runtime Web 1.30.0");
const manifest = JSON.parse(
  await fs.readFile(model.replace(/\.onnx$/, ".json"), "utf8"),
);
const digest = createHash("sha256")
  .update(await fs.readFile(model))
  .digest("hex");
if (manifest.artifact_sha256 !== digest)
  throw new Error("Model artifact checksum mismatch");

const html = `<!doctype html><meta charset="utf-8"><title>Maple local model probe</title>
<script src="/ort/ort.min.js"></script><canvas id="image" width="1024" height="1024"></canvas>
<script>
window.probe = async function(kind) {
  ort.env.wasm.numThreads = 4;
  ort.env.wasm.wasmPaths = '/ort/';
  const sceneMode=kind==='lama-scene';
  const count=1024*1024;
  let nativeFloat;
  if(sceneMode) {
    const buffer=await (await fetch('/image.png')).arrayBuffer();
    if(buffer.byteLength!==3*count*4) throw new Error('Float input length mismatch');
    nativeFloat=new Float32Array(buffer);
    if(!nativeFloat.every(v=>Number.isFinite(v)&&v>=0&&v<=1)) throw new Error('Invalid float model domain');
  }
  const image = new Image();
  if(!sceneMode) {
    image.src = '/image.png'; await image.decode();
    if (image.naturalWidth !== 1024 || image.naturalHeight !== 1024) throw new Error('Expected native 1024 crop');
  }
  const canvas = document.getElementById('image');
  const context = canvas.getContext('2d', {colorSpace:'srgb'});
  if(!sceneMode) context.drawImage(image,0,0);
  const source = context.getImageData(0,0,1024,1024); const pixels=source.data;
  if(sceneMode) for(let i=0;i<count;i++) {
    for(let c=0;c<3;c++) pixels[4*i+c]=Math.round(nativeFloat[c*count+i]*255);
    pixels[4*i+3]=255;
  }
  const mask = kind === 'migan' ? new Uint8Array(count).fill(255) : new Float32Array(count);
  const rgb = kind === 'migan' ? new Uint8Array(3*count) : new Float32Array(4*count);
  for(let i=0;i<count;i++) {
    const x=i%1024,y=Math.floor(i/1024),hole=x>=412&&x<612&&y>=412&&y<612;
    mask[i]=kind==='migan'?(hole?0:255):(hole?1:0);
    for(let c=0;c<3;c++) rgb[c*count+i]=kind==='migan'?pixels[4*i+c]:(hole?0:sceneMode?nativeFloat[c*count+i]:pixels[4*i+c]/255);
    if(kind!=='migan') rgb[3*count+i]=mask[i];
  }
  const started=performance.now();
  const session = await ort.InferenceSession.create('/model.onnx',{executionProviders:['wasm']});
  const startupMs=performance.now()-started;
  const feeds=kind==='migan'?{image:new ort.Tensor('uint8',rgb,[1,3,1024,1024]),mask:new ort.Tensor('uint8',mask,[1,1,1024,1024])}:{masked_image_and_mask:new ort.Tensor('float32',rgb,[1,4,1024,1024])};
  const times=[]; let generated;
  for(let run=0;run<2;run++){const tick=performance.now();const out=await session.run(feeds);times.push(performance.now()-tick);generated=Object.values(out)[0];}
  if(generated.dims.join(',')!=='1,3,1024,1024') throw new Error('Native output shape mismatch');
  let outsideError=0, finite=true;
  const output=new Uint8ClampedArray(pixels);
  for(let i=0;i<count;i++) {
    const hole=kind==='migan'?mask[i]===0:mask[i]===1;
    for(let c=0;c<3;c++) {
      const v=generated.data[c*count+i]; finite=finite&&Number.isFinite(v);
      if(hole) output[4*i+c]=kind==='migan'?v:Math.max(0,Math.min(255,Math.round(v*255)));
      else if(kind==='migan') outsideError=Math.max(outsideError,Math.abs(v-pixels[4*i+c]));
    }
  }
  if(!finite || outsideError) throw new Error('Model changed known pixels or emitted nonfinite data');
  context.putImageData(new ImageData(output,1024,1024),0,0);
  const outputDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',output)),b=>b.toString(16).padStart(2,'0')).join('');
  let modelFloat;
  if(sceneMode) {
    const bytes=new Uint8Array(generated.data.buffer,generated.data.byteOffset,generated.data.byteLength);
    let binary='';
    for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    modelFloat=btoa(binary);
  }
  await session.release();
  return {kind,startupMs,elapsedMs:times,threads:ort.env.wasm.numThreads,crossOriginIsolated,shape:generated.dims,finite,outsideMaskMaxError:outsideError,outputDigest,png:canvas.toDataURL('image/png'),modelFloat};
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
  const path =
    pathname === "/model.onnx"
      ? model
      : pathname === "/image.png"
        ? image
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
          : path.endsWith(".png")
            ? "image/png"
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
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await page.goto("http://127.0.0.1:" + server.address().port);
  const result = await page.evaluate(async (kind) => window.probe(kind), kind);
  const { png, modelFloat, ...report } = result;
  if (modelFloat) {
    await fs.writeFile(reportArg + ".f32", Buffer.from(modelFloat, "base64"));
  }
  await fs.writeFile(
    reportArg + ".png",
    Buffer.from(png.split(",")[1], "base64"),
  );
  await fs.writeFile(
    reportArg,
    JSON.stringify(
      {
        ...report,
        artifactSha256: digest,
        onnxruntime: packageInfo.version,
        browser: browser.version(),
        errors,
        releaseQualified: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  server.close();
}
