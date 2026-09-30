// Real Chromium/WASM cached MobileSAM execution (#3941). Inputs stay on loopback.
import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { chromium } from "../../src/web/node_modules/playwright/index.mjs";

const [artifactsArg, imageArg, queriesArg, runtimeArg, reportArg] =
  process.argv.slice(2);
if (!reportArg)
  throw new Error(
    "Usage: probe-selection-browser.mjs ARTIFACTS IMAGE QUERIES ORT_PACKAGE_DIR REPORT",
  );
const artifacts = resolve(artifactsArg),
  image = resolve(imageArg),
  runtime = resolve(runtimeArg);
const queries = JSON.parse(await fs.readFile(queriesArg, "utf8"));
const version = JSON.parse(
  await fs.readFile(join(runtime, "package.json"), "utf8"),
).version;
if (version !== "1.30.0")
  throw new Error("Expected pinned ONNX Runtime Web 1.30.0");
const digests = {};
for (const kind of ["encoder", "decoder"]) {
  const path = join(artifacts, `mobile-sam-${kind}.onnx`);
  const manifest = JSON.parse(
    await fs.readFile(path.replace(/\.onnx$/, ".json"), "utf8"),
  );
  const digest = createHash("sha256")
    .update(await fs.readFile(path))
    .digest("hex");
  if (
    manifest.source_revision !== "f706ad9c4eb7f219c00d9050e46328518ffb65d2" ||
    manifest.artifact_sha256 !== digest
  )
    throw new Error("MobileSAM provenance mismatch");
  digests[kind] = digest;
}

const html = `<!doctype html><meta charset="utf-8"><title>Maple local selection probe</title>
<script src="/ort/ort.min.js"></script><canvas id="image" width="1024" height="1024"></canvas>
<script>
window.probe=async function(queries) {
  ort.env.wasm.numThreads=4; ort.env.wasm.wasmPaths='/ort/';
  const image=new Image(); image.src='/image.png'; await image.decode();
  if(image.naturalWidth!==1024||image.naturalHeight!==1024) throw new Error('Expected native 1024 crop');
  const canvas=document.getElementById('image'),context=canvas.getContext('2d',{colorSpace:'srgb'});
  context.drawImage(image,0,0); const rgba=context.getImageData(0,0,1024,1024).data;
  const count=1024*1024,rgb=new Float32Array(3*count);
  for(let i=0;i<count;i++) for(let c=0;c<3;c++) rgb[c*count+i]=rgba[4*i+c];
  const startup=performance.now();
  const encoder=await ort.InferenceSession.create('/encoder.onnx',{executionProviders:['wasm']});
  const decoder=await ort.InferenceSession.create('/decoder.onnx',{executionProviders:['wasm']});
  const startupMs=performance.now()-startup;
  const start=performance.now();const encoded=await encoder.run({image:new ort.Tensor('float32',rgb,[1,3,1024,1024])});
  const embedding=encoded.image_embeddings,encoderMs=performance.now()-start;
  if(embedding.dims.join(',')!=='1,256,64,64'||!embedding.data.every(Number.isFinite)) throw new Error('Invalid cached image embedding');
  const cases=[];
  for(const query of queries) {
    if(!query.points.length||query.points.length>64||query.points.length!==query.labels.length) throw new Error('Invalid prompt count');
    const coords=query.points.flat(),labels=[...query.labels];
    if(coords.length!==2*labels.length||!coords.every(v=>Number.isFinite(v)&&v>=0&&v<1024)||!labels.every(v=>[0,1,2,3].includes(v))) throw new Error('Invalid source prompt');
    if(!labels.some(v=>v===1)&&!labels.every(v=>v===2||v===3)) throw new Error('Missing positive selection');
    if(!labels.some(v=>v===2||v===3)){coords.push(0,0);labels.push(-1);}
    const feeds={image_embeddings:embedding,point_coords:new ort.Tensor('float32',Float32Array.from(coords),[1,labels.length,2]),
      point_labels:new ort.Tensor('float32',Float32Array.from(labels),[1,labels.length]),mask_input:new ort.Tensor('float32',new Float32Array(256*256),[1,1,256,256]),
      has_mask_input:new ort.Tensor('float32',new Float32Array([0]),[1]),orig_im_size:new ort.Tensor('float32',new Float32Array([1024,1024]),[2])};
    const times=[];let result;
    for(let run=0;run<10;run++){const tick=performance.now();result=await decoder.run(feeds);times.push(performance.now()-tick);}
    if(result.masks.dims.join(',')!=='1,4,1024,1024'||result.iou_predictions.dims.join(',')!=='1,4') throw new Error('Invalid decoder shape');
    if(!result.masks.data.every(Number.isFinite)||!result.iou_predictions.data.every(Number.isFinite)) throw new Error('Nonfinite decoder output');
    const values=result.masks.data,scores=Array.from(result.iou_predictions.data),checks=[],areas=[];
    for(let candidate=0;candidate<4;candidate++) {
      checks.push(query.labels.flatMap((label,i)=>label>1?[]:[{label,selected:values[candidate*count+Math.floor(query.points[i][1])*1024+Math.floor(query.points[i][0])]>0,
        satisfied:(values[candidate*count+Math.floor(query.points[i][1])*1024+Math.floor(query.points[i][0])]>0)===(label===1)}]));
      let area=0;for(let i=0;i<count;i++) if(values[candidate*count+i]>0) area++;areas.push(area);
    }
    const valid=[0,1,2,3].filter(i=>checks[i].every(c=>c.satisfied));
    const choice=valid.reduce((best,i)=>best===null||scores[i]>scores[best]?i:best,null);
    let png=null,maskDigest=null;
    if(choice!==null) {
      const bytes=new Uint8Array(count),display=new Uint8ClampedArray(4*count);
      for(let i=0;i<count;i++){const value=values[choice*count+i]>0?255:0;bytes[i]=value;display[4*i]=display[4*i+1]=display[4*i+2]=value;display[4*i+3]=255;}
      context.putImageData(new ImageData(display,1024,1024),0,0);png=canvas.toDataURL('image/png');
      maskDigest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    }
    const warm=times.slice(1).sort((a,b)=>a-b),rank=(warm.length-1)*.95,lo=Math.floor(rank),hi=Math.ceil(rank);
    cases.push({query,choice,promptsSatisfied:choice!==null,candidatePromptChecks:checks,candidatePixels:areas,candidateScores:scores,
      decoderElapsedMs:times,decoderWarmP95Ms:warm[lo]+(warm[hi]-warm[lo])*(rank-lo),maskDigest,png});
  }
  await decoder.release();await encoder.release();
  return {startupMs,encoderMs,threads:ort.env.wasm.numThreads,crossOriginIsolated,cases};
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
    pathname === "/encoder.onnx"
      ? join(artifacts, "mobile-sam-encoder.onnx")
      : pathname === "/decoder.onnx"
        ? join(artifacts, "mobile-sam-decoder.onnx")
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
    async (queries) => window.probe(queries),
    queries,
  );
  for (const [index, item] of result.cases.entries()) {
    if (item.png)
      await fs.writeFile(
        reportArg + `-mask-${index}.png`,
        Buffer.from(item.png.split(",")[1], "base64"),
      );
    delete item.png;
  }
  const report = {
    ...result,
    artifactDigests: digests,
    imageSha256: createHash("sha256")
      .update(await fs.readFile(image))
      .digest("hex"),
    onnxruntime: version,
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
