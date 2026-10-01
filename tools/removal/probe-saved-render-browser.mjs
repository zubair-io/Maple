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
  window.gpuErrors=[];
  const getAdapter=navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter=async(...args)=>{const adapter=await getAdapter(...args);if(adapter){window.adapterInfo=adapter.info;const getDevice=adapter.requestDevice.bind(adapter);adapter.requestDevice=async(...args)=>{const device=await getDevice(...args);device.addEventListener('uncapturederror',e=>window.gpuErrors.push(e.error.message));return device;};}return adapter;};
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
    return {source,mapped,cropMapped,invalidGeometryRejected,renders,staleRejected,corruptRejected,oldStackCleared,sourceUnchanged:true};
  }
  const cpu=new wasm.NativeDetailSession(raw,'dng');let cpuResult;
  try{cpuResult=await measure(cpu);}finally{cpu.free();}
  if(!navigator.gpu)throw Error('WebGPU unavailable for required retained-host comparison');
  const gpu=await wasm.WebLiveSession.open(raw,'dng',undefined,new OffscreenCanvas(64,64),64,'srgb');let gpuResult;
  try{gpuResult=await measure(gpu);}finally{gpu.free();}
  if(JSON.stringify(cpuResult)!==JSON.stringify(gpuResult))throw Error('Retained CPU/WebGPU saved API drift');
  const records=wasm.removal_prepare(JSON.stringify({...request,plate:'linear-calibration-v1',source:JSON.parse(cpuResult.source)}),'[]',mask,patch);
  const xmp=xmpFor(records), emptyXmp=xmpFor('[]');
  let missingRejected=false;
  const unpreparedCanvas=new OffscreenCanvas(1,1);
  try{const unexpected=await wasm.WebLiveSession.open(raw,'dng',xmp,unpreparedCanvas,64,'srgb');unexpected.free();}catch{missingRejected=true;}
  if(!missingRejected||unpreparedCanvas.width!==1)throw Error('Incomplete saved open presented an unpatched frame');
  const corrupt=bundle.slice();corrupt[0]^=1;
  let corruptOpenRejected=false;
  try{const unexpected=await wasm.WebLiveSession.open_with_saved_removals(raw,'dng',xmp,new OffscreenCanvas(1,1),64,'srgb',manifest,corrupt);unexpected.free();}catch{corruptOpenRejected=true;}
  if(!corruptOpenRejected)throw Error('Corrupt saved open succeeded');
  const liveCases=[];
  for(const cap of [4,64]){
    const element=document.createElement('canvas');document.body.append(element);
    const canvas=element.transferControlToOffscreen();
    const live=await wasm.WebLiveSession.open_with_saved_removals(raw,'dng',xmp,canvas,cap,'srgb',manifest,bundle);
    const reference=new wasm.NativeDetailSession(raw,'dng');
    reference.prepare_saved_removals(xmp,manifest,bundle);
    // Qualification readback waits for the GPU and browser compositor. These
    // fences belong only to the probe; the production slider chain has none.
    const settle=async()=>{await canvas.getContext('webgpu').getConfiguration().device.queue.onSubmittedWorkDone();await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);};
    const sample=()=>{const c=new OffscreenCanvas(canvas.width,canvas.height),ctx=c.getContext('2d',{colorSpace:'srgb'});ctx.drawImage(element,0,0);return ctx.getImageData(0,0,c.width,c.height).data;};
    try{
      const cases=[];
      for(const [temperature,ev] of [[6500,0],[4300,2],[9000,-2]]){
        const grade=xmp.replace('/>',' xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Temperature="'+temperature+'" crs:Exposure2012="'+ev+'"/>');
        await live.render(grade);await settle();
        const rgba=sample(),result=reference.render_saved_removals(grade,cap,new Uint8Array());let rgb;
        try{if(result.width!==canvas.width||result.height!==canvas.height)throw Error('Live saved geometry drift');rgb=result.take_rgb();}finally{result.free();}
        let maxError=0;for(let i=0;i<rgb.length;i++)maxError=Math.max(maxError,Math.abs(rgb[i]-rgba[Math.floor(i/3)*4+i%3]));
        if(maxError>2)throw Error('Live saved CPU/WebGPU parity failed at '+temperature+'K / '+ev+'EV: '+maxError+' LSB, GPU errors '+JSON.stringify(window.gpuErrors)+' adapter '+JSON.stringify(window.adapterInfo)+' actual '+Array.from(rgba.slice(0,16))+' expected '+Array.from(rgb.slice(0,12)));
        await live.render(grade);await settle();const repeated=sample();if(rgba.some((v,i)=>v!==repeated[i]))throw Error('Repeated live saved pixels drifted');
        const params=new Float32Array([ev,0,0,0,0,0,0,0,0,temperature,0,0,0,0,0,50,0,25,50]);
        await live.render_with_params(params);await settle();const flat=sample();
        if(rgba.some((v,i)=>v!==flat[i]))throw Error('Flat slider rendering discarded full-model settings');
        cases.push({temperature,ev,maxError,repeatedIdentical:true,flatIdentical:true});
      }
      live.prepare_saved_removals(xmp,manifest,bundle);
      await live.render(xmp);
      let rejectedPreparation=false;try{live.prepare_saved_removals(xmp,manifest,corrupt);}catch{rejectedPreparation=true;}
      let xmlRejected=false;try{await live.render(xmp);}catch{xmlRejected=true;}
      let paramsRejected=false;try{await live.render_with_params(new Float32Array([0,0,0,0,0,0,0,0,0,6500,0,0,0,0,0,50,0,25,50]));}catch{paramsRejected=true;}
      if(!rejectedPreparation||!xmlRejected||!paramsRejected)throw Error('Live rendering reused a rejected saved stack');
      live.prepare_saved_removals(xmp,manifest,bundle);await live.render(xmp);
      await live.render(emptyXmp);await settle();
      const cleared=sample(),plain=wasm.render_bytes_sized(raw,'dng',emptyXmp,false,cap);let plainRgb;
      try{plainRgb=plain.take_rgb();}finally{plain.free();}
      let maxClearError=0;for(let i=0;i<plainRgb.length;i++)maxClearError=Math.max(maxClearError,Math.abs(plainRgb[i]-cleared[Math.floor(i/3)*4+i%3]));
      if(maxClearError>2)throw Error('Cleared saved stack retained old replacement pixels');
      liveCases.push({cap,width:canvas.width,height:canvas.height,cases,xmlRejected,paramsRejected,maxClearError});
    }finally{live.free();reference.free();element.remove();}
  }
  const ordinaryEntries=[()=>wasm.render_bytes(raw,'dng',xmp),()=>wasm.render_bytes_sized(raw,'dng',xmp,false,64),()=>wasm.render_bytes_scene_linear(raw,'dng',xmp,false),()=>wasm.render_bytes_scene_linear_sized(raw,'dng',xmp,false,64)];
  const unresolvedRejected=ordinaryEntries.map(run=>{try{const result=run();result.free();return false;}catch{return true;}});
  if(unresolvedRejected.some(v=>!v))throw Error('CPU fallback silently ignored saved removals');
  if(window.gpuErrors.length)throw Error(window.gpuErrors.join('\n'));
  return {cpu:cpuResult,gpu:gpuResult,retainedHostsByteIdentical:true,live:{missingRejected,corruptOpenRejected,liveCases,unresolvedRejected,gpuValidationErrors:window.gpuErrors},crossOriginIsolated};
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
  args: [
    "--enable-unsafe-webgpu",
    ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
  ],
});
try {
  const page = await browser.newPage(),
    errors = [];
  page.on("console", (msg) => {
    if (["error", "warn"].includes(msg.type()))
      console.log(msg.type(), msg.text());
  });
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
