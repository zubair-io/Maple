import type { PendingHandler } from './raw-pipeline.service-internals';
import type { RemovalCompanionBundle } from '../removal/removal-companion-bundle';
import type {
  RemovalAuthoringCommand,
  RemovalAuthoringRequest,
  RemovalAuthoringValue,
  RemovalInput,
} from './raw-pipeline.removal.types';

/** One authoring view, bound to the original-byte identity returned at open.
 * Stale operations reject on close/image switch/worker retirement. The owner
 * must additionally guard its current selection revision after inference. */
export class RemovalAuthoringClient {
  private epoch = 0;
  private input: { sourceId: string; ext: string; original: string } | null = null;
  constructor(
    private readonly worker: () => Worker,
    private readonly nextId: () => number,
    private readonly pending: Map<number, PendingHandler>,
  ) {}

  close(): void {
    this.epoch++;
    this.input = null;
  }

  async open(input: RemovalInput): Promise<string> {
    this.close();
    const epoch = this.epoch;
    const bytes = input.bytes.slice().buffer as ArrayBuffer;
    const value = await this.send(
      { sourceId: input.sourceId, ext: input.ext },
      { kind: 'source', bytes },
      epoch,
      [bytes],
    );
    this.checkEpoch(epoch);
    if (value.kind !== 'source') throw new Error('Invalid removal source reply');
    const source: unknown = JSON.parse(value.source);
    if (
      !source ||
      typeof source !== 'object' ||
      !('original' in source) ||
      typeof source.original !== 'string'
    ) {
      throw new Error('Invalid removal source anchor');
    }
    this.input = { sourceId: input.sourceId, ext: input.ext, original: source.original };
    return value.source;
  }

  async map(xmp: string, request: string): Promise<string> {
    const result = await this.operation({ kind: 'map', xmp, request });
    if (result.kind !== 'map') throw new Error('Invalid removal geometry reply');
    return result.mapping;
  }

  async context(rect: readonly [number, number, number, number]): Promise<Float32Array> {
    const result = await this.operation({ kind: 'context', rect });
    if (result.kind !== 'context') throw new Error('Invalid removal context reply');
    return new Float32Array(result.rgb);
  }

  async generationContext(
    xmp: string,
    rect: readonly [number, number, number, number],
    bundle: RemovalCompanionBundle,
  ): Promise<Float32Array> {
    if (!this.input) throw new Error('Removal RAW session is not open');
    const companions = bundle.bytes.slice().buffer as ArrayBuffer;
    const result = await this.send(
      this.input,
      { kind: 'generation-context', xmp, rect, manifest: bundle.manifest, companions },
      this.epoch,
      [companions],
    );
    if (result.kind !== 'context') throw new Error('Invalid removal generation context reply');
    return new Float32Array(result.rgb);
  }

  async prepareSaved(xmp: string, bundle: RemovalCompanionBundle): Promise<string> {
    if (!this.input) throw new Error('Removal RAW session is not open');
    const companions = bundle.bytes.slice().buffer as ArrayBuffer;
    const result = await this.send(
      this.input,
      { kind: 'prepare-saved', xmp, manifest: bundle.manifest, companions },
      this.epoch,
      [companions],
    );
    if (result.kind !== 'prepared') throw new Error('Invalid saved removal preparation reply');
    return result.review;
  }

  async selection(request: string): Promise<Uint8Array> {
    const result = await this.operation({ kind: 'selection', request });
    if (result.kind !== 'selection') throw new Error('Invalid removal selection reply');
    return new Uint8Array(result.mask);
  }

  private operation(command: RemovalAuthoringCommand): Promise<RemovalAuthoringValue> {
    if (!this.input) return Promise.reject(new Error('Removal RAW session is not open'));
    return this.send(this.input, command, this.epoch);
  }

  private async send(
    input: { sourceId: string; ext: string; original?: string },
    command: RemovalAuthoringCommand,
    epoch: number,
    transfer: Transferable[] = [],
  ): Promise<RemovalAuthoringValue> {
    const worker = this.worker(),
      id = this.nextId();
    const request: RemovalAuthoringRequest = { ...input, id, type: 'removal-authoring', command };
    const value = await new Promise<RemovalAuthoringValue>((resolve, reject) => {
      this.pending.set(id, { kind: 'removal-authoring', resolve, reject });
      try {
        worker.postMessage(request, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
    this.checkEpoch(epoch);
    return value;
  }

  private checkEpoch(epoch: number): void {
    if (epoch !== this.epoch) throw new DOMException('Removal authoring superseded', 'AbortError');
  }
}
