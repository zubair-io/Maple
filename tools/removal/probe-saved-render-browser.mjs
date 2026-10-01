// Actual retained CPU/WebGPU saved render/export boundaries (#3955).
import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { resolve, sep } from "node:path";
import { chromium } from "../../src/web/node_modules/playwright/index.mjs";

const [output] = process.argv.slice(2);
if (!output)
  throw new Error("Usage: probe-saved-render-browser.mjs REPORT_JSON");
const shared = resolve("src/raw-pipeline/raw-wasm/pkg");
const fixture = resolve("test-fixtures/removal/basic");
const files = new Map(
  ["source.dng", "request.txt", "mask.mimf", "patch.f16"].map((name) => [
    "/" + name,
    resolve(fixture, name),
  ]),
);
const html = `<!doctype html><script type="module">
import * as wasm from '/shared/raw_wasm.js';
window.probe=async()=>{
  await wasm.default({module_or_path:'/shared/raw_wasm_bg.wasm'});
  const read=async(name)=>new Uint8Array(await(await fetch('/'+name)).arrayBuffer());
  const [raw,mask,patch]=await Promise.all(['source.dng','mask.mimf','patch.f16'].map(read));
  const request=await(await fetch('/request.txt')).json();
  const xmpFor=(records)=>'<rdf:Description xmlns:rdf="x" xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:InpaintRemovals="'+records.replaceAll('"','&quot;')+'"/>';
  const manifest=JSON.stringify([
    {name:wasm.removal_content_digest(mask).slice(7)+'.mask',length:mask.length},
    {name:wasm.removal_content_digest(patch).slice(7)+'.f16',length:patch.length},
  ]);
  const bundle=new Uint8Array(mask.length+patch.length);bundle.set(mask);bundle.set(patch,mask.length);
  async function measure(session){
    const geometryXmp='<rdf:Description xmlns:rdf="x" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:PerspectiveX="100"/>';
    const mapped=JSON.parse(session.removal_map_points(geometryXmp,JSON.stringify({schema:1,points:[[0,.5],[.8,.5],[1.1,.5]]})));
    if(JSON.stringify(mapped.source_size)!=='[16,8]'||mapped.points.length!==3||mapped.points[0]!==null||mapped.points[2]!==null||Math.abs(mapped.points[1][0]-.3)>1e-7||mapped.points[1][1]!==.5)throw Error('Retained gesture mapping differs from native RAW geometry');
    let invalidGeometryRejected=false;try{session.removal_map_points(geometryXmp,'{"schema":2,"points":[]}');}catch{invalidGeometryRejected=true;}
    if(!invalidGeometryRejected)throw Error('Unsupported gesture schema accepted');
    const cropXmp='<rdf:Description xmlns:rdf="x" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:HasCrop="True" crs:CropLeft="0.25" crs:CropRight="0.75" crs:CropTop="0" crs:CropBottom="1" crs:CropAngle="90"/>';
    const cropMapped=JSON.parse(session.removal_map_points(cropXmp,JSON.stringify({schema:1,crop_input_size:[16,8],points:[[.5,.25]]})));
    if(JSON.stringify(cropMapped.points)!=='[[0.375,0.5]]')throw Error('Cropped quarter-turn gesture differs from native rendering');
    const source=session.removal_calibration_source();
    const records=wasm.removal_prepare(JSON.stringify({...request,plate:'linear-calibration-v1',source:JSON.parse(source)}),'[]',mask,patch);
    const xmp=xmpFor(records);
    if(session.prepare_saved_removals(xmp,manifest,bundle)!=='[]')throw Error('Unexpected review indices');
    const renders=[];
    for(const cap of [0,4,64]){
      const result=session.render_saved_removals(xmp,cap,new Uint8Array());
      let w,h,rgb;
      try{w=result.width;h=result.height;rgb=result.take_rgb();}finally{result.free();}
      const encoded=session.export_saved_removals(xmp,JSON.stringify({format:'png',quality:100,color_space:'srgb',max_long_edge:cap}),new Uint8Array());
      let data;
      try{if(encoded.width!==w||encoded.height!==h)throw Error('Export geometry differs');data=encoded.chunk(0,encoded.byteLength);}finally{encoded.free();}
      const bitmap=await createImageBitmap(new Blob([data],{type:'image/png'}));
      const canvas=new OffscreenCanvas(w,h),ctx=canvas.getContext('2d',{colorSpace:'srgb'});
      ctx.drawImage(bitmap,0,0);bitmap.close();
      const rgba=ctx.getImageData(0,0,w,h).data;
      let maxExportError=0;for(let i=0;i<rgb.length;i++)maxExportError=Math.max(maxExportError,Math.abs(rgb[i]-rgba[Math.floor(i/3)*4+i%3]));
      if(maxExportError!==0)throw Error('Decoded PNG differs from approved saved pixels');
      renders.push({cap,width:w,height:h,rgb:Array.from(rgb),maxExportError});
    }
    let staleRejected=false;try{session.render_saved_removals(xmpFor('[]'),4,new Uint8Array());}catch{staleRejected=true;}
    if(!staleRejected)throw Error('Changed records reused old stack');
    const corrupt=bundle.slice();corrupt[0]^=1;
    let corruptRejected=false;try{session.prepare_saved_removals(xmp,manifest,corrupt);}catch{corruptRejected=true;}
    let oldStackCleared=false;try{session.render_saved_removals(xmp,4,new Uint8Array());}catch{oldStackCleared=true;}
    if(!corruptRejected||!oldStackCleared)throw Error('Failed preparation retained old accepted pixels');
    session.prepare_saved_removals(xmp,manifest,bundle);
    if(session.removal_calibration_source()!==source)throw Error('Saved rendering changed original source');
    return {mapped,cropMapped,invalidGeometryRejected,renders,staleRejected,corruptRejected,oldStackCleared,sourceUnchanged:true};
  }
  const cpu=new wasm.NativeDetailSession(raw,'dng');let cpuResult;
  try{cpuResult=await measure(cpu);}finally{cpu.free();}
  if(!navigator.gpu)throw Error('WebGPU unavailable for required retained-host comparison');
  const gpu=await wasm.WebLiveSession.open(raw,'dng',undefined,new OffscreenCanvas(64,64),64,'srgb');let gpuResult;
  try{gpuResult=await measure(gpu);}finally{gpu.free();}
  if(JSON.stringify(cpuResult)!==JSON.stringify(gpuResult))throw Error('Retained CPU/WebGPU saved API drift');
  return {cpu:cpuResult,gpu:gpuResult,retainedHostsByteIdentical:true,crossOriginIsolated};
};
</script>`;
const server = createServer(async (request, response) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/") {
    response.setHeader("Content-Type", "text/html");
    response.end(html);
    return;
  }
  const module = pathname.startsWith("/shared/")
    ? resolve(shared, pathname.slice(8))
    : undefined;
  const path =
    files.get(pathname) ??
    (module?.startsWith(shared + sep) ? module : undefined);
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
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    JSON.stringify({
      retainedHostsByteIdentical: true,
      decodedPngMatchesPreview: true,
      browser: report.browser,
      report: output,
    }),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
