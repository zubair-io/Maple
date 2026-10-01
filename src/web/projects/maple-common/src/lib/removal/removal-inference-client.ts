// Local authoring worker (#3941), separate from the persistent render worker.
import type { RemovalModelId } from '../generated/removal-models.generated';
import type {
  RemovalDetection,
  RemovalInferenceCommand,
  RemovalInferenceReply,
  RemovalInferenceResult,
  RemovalInferenceStage,
} from './removal-inference.types';

function cancelled(): DOMException {
  return new DOMException('Removal inference cancelled.', 'AbortError');
}
function owned(value: Float32Array): Float32Array<ArrayBuffer> {
  return value.buffer instanceof ArrayBuffer &&
    value.byteOffset === 0 &&
    value.byteLength === value.buffer.byteLength
    ? (value as Float32Array<ArrayBuffer>)
    : value.slice();
}

/** Models are explicit local Blobs, supplied by the provisioning layer. This
 * client sends no photo/model data to a server. Methods surrender tensor buffers
 * to the worker; pass a slice when the caller needs to retain one for reuse.
 * UI owners must also guard image/revision before publishing a returned proposal.
 */
export class RemovalInferenceClient {
  private worker?: Worker;
  private ready?: Promise<void>;
  private readonly loaded = new Set<RemovalModelId>();
  private readonly pending = new Map<
    number,
    { resolve: (result: RemovalInferenceResult) => void; reject: (error: Error) => void }
  >();
  private nextRequest = 0;
  private serial: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private closed = false;

  /** Changes on cancellation/failure; an owner must re-encode Smart paint after
   * that change because terminating the worker releases its cached embedding.
   */
  get epoch(): number {
    return this.generation;
  }

  constructor(
    private readonly models: ReadonlyMap<RemovalModelId, Blob>,
    private readonly progress?: (stage: RemovalInferenceStage) => void,
  ) {}

  generate(rgb: Float32Array, hole: Float32Array): Promise<Float32Array> {
    return this.run(['lama'], async () => {
      const image = owned(rgb);
      const mask = owned(hole);
      const result = await this.send({ kind: 'generate', rgb: image, hole: mask }, [
        image.buffer,
        mask.buffer,
      ]);
      if (!(result instanceof Float32Array)) throw new Error('Invalid reconstruction reply.');
      return result;
    });
  }
  encode(source: string, request: string, rgb: Float32Array): Promise<string> {
    return this.run(['encoder'], async () => {
      const image = owned(rgb);
      const result = await this.send({ kind: 'encode', source, request, rgb: image }, [
        image.buffer,
      ]);
      if (typeof result !== 'string') throw new Error('Invalid embedding reply.');
      return result;
    });
  }
  refine(source: string, request: string): Promise<Uint8Array> {
    return this.run(['decoder'], async () => {
      const result = await this.send({ kind: 'refine', source, request });
      if (!(result instanceof Uint8Array)) throw new Error('Invalid selection reply.');
      return result;
    });
  }
  detect(rgb: Float32Array, size: readonly [number, number]): Promise<RemovalDetection[]> {
    return this.run(['detector'], async () => {
      const image = owned(rgb);
      const result = await this.send({ kind: 'detect', rgb: image, size }, [image.buffer]);
      if (!Array.isArray(result)) throw new Error('Invalid detection reply.');
      return result;
    });
  }

  /** Hard termination cancels CPU/WASM even while its event loop is occupied.
   * Local model Blobs remain available for the next operation's lazy reload.
   */
  cancel(): void {
    this.reset(cancelled());
  }
  dispose(): void {
    this.closed = true;
    this.cancel();
  }

  private run<T>(models: readonly RemovalModelId[], action: () => Promise<T>): Promise<T> {
    const epoch = this.generation;
    const result = this.serial.then(async () => {
      this.checkEpoch(epoch);
      await this.initialize();
      this.checkEpoch(epoch);
      for (const model of models) {
        if (!this.loaded.has(model)) {
          const file = this.models.get(model);
          if (!file) throw new Error('Required AI model is not installed.');
          await this.send({ kind: 'load', model, file });
          this.checkEpoch(epoch);
          this.loaded.add(model);
        }
      }
      const value = await action();
      this.checkEpoch(epoch);
      return value;
    });
    this.serial = result.catch(() => undefined);
    return result;
  }
  private checkEpoch(epoch: number): void {
    if (this.closed || this.generation !== epoch) throw cancelled();
  }
  private initialize(): Promise<void> {
    return (this.ready ??= this.send({
      kind: 'init',
      runtimeBase: new URL('assets/removal-runtime/', document.baseURI).href,
      rawWasm: new URL('raw_wasm_bg.wasm', document.baseURI).href,
    }).then(() => undefined));
  }
  private send(
    command: RemovalInferenceCommand,
    transfer: Transferable[] = [],
  ): Promise<RemovalInferenceResult> {
    if (this.closed) return Promise.reject(cancelled());
    if (!this.worker) this.createWorker();
    const id = ++this.nextRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker!.postMessage({ id, command }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  private createWorker(): void {
    const worker = new Worker(new URL('./removal-inference.worker', import.meta.url), {
      type: 'module',
    });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<RemovalInferenceReply>) => {
      if (this.worker !== worker) return;
      const message = event.data;
      const request = this.pending.get(message.id);
      if (!request) return;
      if ('stage' in message) {
        this.progress?.(message.stage);
        return;
      }
      this.pending.delete(message.id);
      if ('error' in message) request.reject(new Error(message.error));
      else request.resolve(message.result);
    };
    worker.onerror = (event) => {
      if (this.worker === worker)
        this.reset(new Error(event.message || 'AI worker stopped. Retry the operation.'));
    };
    worker.onmessageerror = () => {
      if (this.worker === worker)
        this.reset(new Error('AI worker communication failed. Retry the operation.'));
    };
  }
  private reset(error: Error): void {
    this.generation++;
    this.worker?.terminate();
    this.worker = undefined;
    this.ready = undefined;
    this.loaded.clear();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.serial = Promise.resolve();
  }
}
