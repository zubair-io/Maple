/** Instrument native GPU completion and scope result delivery without replacing rendering. */
export const scopeWorkerProbe = (workerFile: string) => `
const counts = {};
for (const key of ['createBuffer','createTexture','createBindGroup','createComputePipeline','createComputePipelineAsync','createRenderPipeline','createRenderPipelineAsync']) {
  counts[key] = 0;
  const original = GPUDevice.prototype[key];
  if (typeof original === 'function') GPUDevice.prototype[key] = function(...args) {
    counts[key]++; return Reflect.apply(original, this, args);
  };
}
let hold = true, held = [], canvas, captureOracle = false, oracle;
const fences = {active:0,maxActive:0,hold:false,held:[],rejectNext:false};
const completion = GPUQueue.prototype.onSubmittedWorkDone;
GPUQueue.prototype.onSubmittedWorkDone = function() {
  fences.active++; fences.maxActive=Math.max(fences.maxActive,fences.active);
  // Capture before the render awaits and yields to compositor commit. This is
  // deliberately blocking and enabled only outside the performance trial.
  if(captureOracle) oracle={rgb:captureCanvas()};
  return Reflect.apply(completion,this,[]).then(async () => {
    if(fences.hold) await new Promise(resolve => fences.held.push(resolve));
    if(fences.rejectNext) { fences.rejectNext=false; throw new Error('Injected completed-frame fence failure'); }
  }).finally(() => fences.active--);
};
function captureCanvas() {
  const target = new OffscreenCanvas(canvas.width, canvas.height);
  const context = target.getContext('2d', {colorSpace:'srgb', willReadFrequently:true});
  context.drawImage(canvas, 0, 0);
  const source = context.getImageData(0,0,canvas.width,canvas.height).data;
  const scale=Math.min(1,512/Math.max(canvas.width,canvas.height));
  const width=Math.round(canvas.width*scale),height=Math.round(canvas.height*scale);
  const rgb=new Uint8Array(width*height*3);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const sx=Math.min(canvas.width-1,Math.floor((x+.5)*canvas.width/width));
    const sy=Math.min(canvas.height-1,Math.floor((y+.5)*canvas.height/height));
    const from=(sy*canvas.width+sx)*4, to=(y*width+x)*3;
    rgb.set(source.subarray(from,from+3),to);
  }
  return rgb;
}
const post = self.postMessage.bind(self);
self.postMessage = function(message, transfer) {
  // Freeze the actual frame before Chromium discards the worker backing store
  // on compositor commit. Enabled only for an untimed correctness frame.
  if(captureOracle && message.type==='render-session-success') oracle.renderId=message.id;
  post(message,transfer ?? []);
};
const map = GPUBuffer.prototype.mapAsync;
GPUBuffer.prototype.mapAsync = function(...args) {
  const pending = Reflect.apply(map, this, args);
  return this.label === 'scope-sample-staging'
    ? pending.then(() => hold ? new Promise(resolve => held.push(resolve)) : undefined) : pending;
};
const marks = [];
new PerformanceObserver(list => marks.push(...list.getEntries().map(e => ({name:e.name,duration:e.duration})))).observe({entryTypes:['measure']});
addEventListener('message', ({data}) => {
  if (data.type === 'open-session') canvas = data.canvas;
  if (data.type === 'probe-stats') postMessage({id:data.id, type:'probe-stats-result', counts:{...counts}, held:held.length, fences:{active:fences.active,maxActive:fences.maxActive,held:fences.held.length}, marks:marks.splice(0)});
  if (data.type === 'probe-fence') {
    fences.hold=data.hold ?? false; fences.rejectNext=data.reject ?? false;
    if(!fences.hold) for(const release of fences.held.splice(0)) release();
    post({id:data.id,type:'probe-fence-set'});
  }
  if (data.type === 'probe-hold') { hold=true; postMessage({id:data.id,type:'probe-held'}); }
  if (data.type === 'probe-release') {
    hold = false; for (const release of held.splice(0)) release();
    postMessage({id:data.id, type:'probe-released'});
  }
  if(data.type==='probe-oracle') {
    captureOracle=data.enabled; post({id:data.id,type:'probe-oracle-set'});
  }
  if (data.type === 'probe-canvas') {
    if(!oracle) throw new Error('No captured presented frame');
    const rgb=oracle.rgb.slice();
    post({id:data.id,type:'probe-canvas-result',renderId:oracle.renderId,rgb:rgb.buffer},[rgb.buffer]);
  }
});
await import('/${workerFile}'); postMessage({id:0,type:'probe-ready'});
`;
