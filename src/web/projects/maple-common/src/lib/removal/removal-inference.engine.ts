// Experimental local inference (#3941). Models are unqualified; no UI release gate.
import * as ort from 'onnxruntime-web/wasm';
import {
  EXPERIMENTAL_REMOVAL_MODELS,
  type RemovalModelId,
} from '../generated/removal-models.generated';
import type {
  RemovalDetection,
  RemovalInferenceCommand,
  RemovalInferenceResult,
  RemovalInferenceStage,
  RemovalProposal,
} from './removal-inference.types';

type RawModule = typeof import('../raw-pipeline/pkg/raw_wasm');
const side = EXPERIMENTAL_REMOVAL_MODELS.find((p) => p.id === 'lama')!.native_side;
const plane = side * side;

function valid(values: Float32Array, count: number, low: number, high: number): void {
  if (
    !(values instanceof Float32Array) ||
    values.length !== count ||
    values.some((v) => !Number.isFinite(v) || v < low || v > high)
  ) {
    throw new Error('Removal tensor size or domain mismatch.');
  }
}
function output(
  outputs: ort.InferenceSession.OnnxValueMapType,
  name: string,
  dims: readonly number[],
): Float32Array {
  const value = outputs[name];
  if (
    !value ||
    value.type !== 'float32' ||
    !(value.data instanceof Float32Array) ||
    value.dims.length !== dims.length ||
    value.dims.some((v, i) => v !== dims[i]) ||
    value.data.some((v) => !Number.isFinite(v))
  ) {
    throw new Error(`Invalid model output: ${name}`);
  }
  return value.data;
}

export class RemovalInferenceEngine {
  private readonly sessions = new Map<RemovalModelId, ort.InferenceSession>();
  private readonly modelDigests = new Map<RemovalModelId, string>();
  private rawReady?: Promise<RawModule>;
  private embedding?: { identity: string; values: Float32Array };
  private initialized = false;
  private rawUrl = '';

  async execute(
    command: RemovalInferenceCommand,
    progress: (stage: RemovalInferenceStage) => void,
  ): Promise<RemovalInferenceResult> {
    if (command.kind === 'init') {
      if (this.initialized) throw new Error('Removal runtime is already initialized.');
      const base = new URL(command.runtimeBase);
      const raw = new URL(command.rawWasm);
      if (base.origin !== self.location.origin || raw.origin !== self.location.origin)
        throw new Error('Removal runtimes must be served by Maple.');
      ort.env.wasm.wasmPaths = {
        mjs: new URL('ort-wasm-simd-threaded.mjs', base).href,
        wasm: new URL('ort-wasm-simd-threaded.wasm', base).href,
      };
      ort.env.wasm.numThreads = self.crossOriginIsolated
        ? Math.min(4, self.navigator.hardwareConcurrency || 1)
        : 1;
      ort.env.wasm.proxy = false;
      this.rawUrl = raw.href;
      this.initialized = true;
      return null;
    }
    if (!this.initialized) throw new Error('Removal runtime is not initialized.');
    switch (command.kind) {
      case 'load':
        progress('loading-model');
        await this.load(command.model, command.file);
        return null;
      case 'generate':
        progress('generating');
        return this.generate(command.rgb, command.hole);
      case 'propose':
        progress('generating');
        return this.propose(command);
      case 'encode':
        progress('encoding');
        return this.encode(command.source, command.request, command.rgb);
      case 'refine':
        progress('refining');
        return this.refine(command.source, command.request);
      case 'detect':
        progress('detecting');
        return this.detect(command.rgb, command.size);
    }
  }

  private async load(id: RemovalModelId, file: Blob): Promise<void> {
    const pin = EXPERIMENTAL_REMOVAL_MODELS.find((value) => value.id === id);
    if (!pin || !(file instanceof Blob) || file.size !== pin.size)
      throw new Error('Removal model size mismatch.');
    const bytes = await file.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
      v.toString(16).padStart(2, '0'),
    ).join('');
    if (hash !== pin.sha256) throw new Error('Removal model checksum mismatch.');
    if (this.sessions.has(id)) return;
    const digest = (await this.raw()).removal_content_digest(new Uint8Array(bytes));
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    this.sessions.set(id, session);
    this.modelDigests.set(id, digest);
  }
  private async propose(
    command: Extract<RemovalInferenceCommand, { kind: 'propose' }>,
  ): Promise<RemovalProposal> {
    const raw = await this.raw();
    const model = this.modelDigests.get('lama');
    if (!model) throw new Error('Verified reconstruction model is unavailable.');
    const pin = EXPERIMENTAL_REMOVAL_MODELS.find((p) => p.id === 'lama')!;
    const request = JSON.stringify({
      ...JSON.parse(command.request),
      model,
      model_version: pin.sha256,
    });
    const generation = new raw.RemovalGeneration(
      request,
      command.prior,
      command.scene,
      command.intent,
      command.protected,
    );
    try {
      const generated = await this.generate(generation.rgb(), generation.hole());
      return {
        request: generation.request(),
        mask: command.intent,
        patch: generation.finish(generated),
      };
    } finally {
      generation.free();
    }
  }
  private session(id: RemovalModelId): ort.InferenceSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Removal model is unavailable: ${id}`);
    return session;
  }
  private raw(): Promise<RawModule> {
    return (this.rawReady ??= import('../raw-pipeline/pkg/raw_wasm').then(async (raw) => {
      await raw.default({ module_or_path: this.rawUrl });
      return raw;
    }));
  }
  private async generate(rgb: Float32Array, hole: Float32Array): Promise<Float32Array> {
    valid(rgb, 3 * plane, 0, 1);
    valid(hole, plane, 0, 1);
    if (hole.some((v) => v !== 0 && v !== 1) || !hole.includes(1))
      throw new Error('Removal requires a nonempty binary generation hole.');
    const input = new Float32Array(4 * plane);
    for (let i = 0; i < rgb.length; i++) input[i] = rgb[i] * (1 - hole[i % plane]);
    input.set(hole, 3 * plane);
    const outputs = await this.session('lama').run({
      masked_image_and_mask: new ort.Tensor('float32', input, [1, 4, side, side]),
    });
    try {
      const result = output(outputs, 'generated_rgb', [1, 3, side, side]);
      valid(result, 3 * plane, 0, 1);
      return result.slice();
    } finally {
      Object.values(outputs).forEach((v) => v.dispose());
    }
  }
  private async encode(source: string, request: string, rgb: Float32Array): Promise<string> {
    valid(rgb, 3 * plane, 0, 255);
    const raw = await this.raw();
    const identity = raw.removal_smart_context_identity(source, request);
    if (this.embedding?.identity === identity) return identity;
    const outputs = await this.session('encoder').run({
      image: new ort.Tensor('float32', rgb, [1, 3, side, side]),
    });
    try {
      this.embedding = {
        identity,
        values: output(outputs, 'image_embeddings', [1, 256, 64, 64]).slice(),
      };
      return identity;
    } finally {
      Object.values(outputs).forEach((v) => v.dispose());
    }
  }
  private async refine(source: string, request: string): Promise<Uint8Array> {
    const raw = await this.raw();
    const identity = raw.removal_smart_context_identity(source, request);
    const embedding = this.embedding;
    if (!embedding || embedding.identity !== identity)
      throw new Error('Selection context changed; encode the current source again.');
    const prompts = JSON.parse(raw.removal_smart_prompts(request)) as {
      points: number[][];
      labels: number[];
    };
    const outputs = await this.session('decoder').run({
      image_embeddings: new ort.Tensor('float32', embedding.values, [1, 256, 64, 64]),
      point_coords: new ort.Tensor('float32', Float32Array.from(prompts.points.flat()), [
        1,
        prompts.labels.length,
        2,
      ]),
      point_labels: new ort.Tensor('float32', Float32Array.from(prompts.labels), [
        1,
        prompts.labels.length,
      ]),
      mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: new ort.Tensor('float32', new Float32Array(1), [1]),
      orig_im_size: new ort.Tensor('float32', Float32Array.of(side, side), [2]),
    });
    try {
      const logits = output(outputs, 'masks', [1, 4, side, side]);
      const scores = output(outputs, 'iou_predictions', [1, 4]);
      output(outputs, 'low_res_masks', [1, 4, 256, 256]);
      return raw.removal_smart_mask(request, logits, scores);
    } finally {
      Object.values(outputs).forEach((v) => v.dispose());
    }
  }
  private async detect(
    rgb: Float32Array,
    size: readonly [number, number],
  ): Promise<RemovalDetection[]> {
    const detectorSide = EXPERIMENTAL_REMOVAL_MODELS.find((p) => p.id === 'detector')!.native_side;
    valid(rgb, 3 * detectorSide * detectorSide, 0, 1);
    if (size.length !== 2 || size.some((v) => !Number.isInteger(v) || v < 1 || v > 0xffffffff))
      throw new Error('Invalid detector source extent.');
    const outputs = await this.session('detector').run({
      images: new ort.Tensor('float32', rgb, [1, 3, detectorSide, detectorSide]),
      orig_target_sizes: new ort.Tensor('int64', BigInt64Array.from(size.map(BigInt)), [1, 2]),
    });
    try {
      const labels = outputs['labels'];
      if (
        !labels ||
        labels.type !== 'int64' ||
        !(labels.data instanceof BigInt64Array) ||
        labels.dims.length !== 2 ||
        labels.dims[0] !== 1 ||
        labels.dims[1] !== 300 ||
        labels.data.some((v) => v < 0n || v >= 80n)
      )
        throw new Error('Invalid detector classes.');
      const boxes = output(outputs, 'boxes', [1, 300, 4]);
      const scores = output(outputs, 'scores', [1, 300]);
      valid(scores, 300, 0, 1);
      return Array.from(scores, (score, i) => ({
        class: Number(labels.data[i]),
        bounds: [boxes[4 * i], boxes[4 * i + 1], boxes[4 * i + 2], boxes[4 * i + 3]],
        score,
      }));
    } finally {
      Object.values(outputs).forEach((v) => v.dispose());
    }
  }
}
