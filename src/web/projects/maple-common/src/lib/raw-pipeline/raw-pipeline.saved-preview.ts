// One source-bound normal CPU preview; all work shares the decode queue (#3955).
import type { RemovalAuthoringClient } from './raw-pipeline.removal-client';
import type { RemovalInput } from './raw-pipeline.removal.types';
import type { RemovalCompanionBundle } from '../removal/removal-companion-bundle';
import type { DecodedImage } from './raw-pipeline.types';

export class SavedRemovalPreviewClient {
  private current: { sourceId: string; records: string; bytes: Uint8Array } | null = null;
  private epoch = 0;
  constructor(
    private readonly client: RemovalAuthoringClient,
    private readonly queue: <T>(run: () => Promise<T>) => Promise<T>,
  ) {}
  close(): void {
    this.epoch++;
    this.current = null;
    this.client.close();
  }

  /** Idle/cold derivatives share the bounded decode queue, never a live prepared stack. */
  renderDerivative(
    input: RemovalInput,
    xmp: string,
    bundle: RemovalCompanionBundle,
    cap: number,
    film?: ArrayBuffer,
  ): Promise<DecodedImage> {
    return this.queue(() => this.client.renderDerivative(input, xmp, bundle, cap, film));
  }
  render(
    input: RemovalInput,
    records: string,
    xmp: string,
    load: () => Promise<RemovalCompanionBundle>,
    cap: number,
    film?: ArrayBuffer,
  ): Promise<DecodedImage> {
    const epoch = this.epoch;
    return this.queue(async () => {
      if (epoch !== this.epoch) throw new DOMException('Saved preview superseded', 'AbortError');
      if (
        this.current?.sourceId !== input.sourceId ||
        this.current.records !== records ||
        this.current.bytes !== input.bytes
      ) {
        this.current = null;
        const bundle = await load();
        if (epoch !== this.epoch) throw new DOMException('Saved preview superseded', 'AbortError');
        await this.client.open(input);
        await this.client.prepareSaved(xmp, bundle);
        this.current = { sourceId: input.sourceId, records, bytes: input.bytes };
      }
      try {
        const frame = await this.client.renderSaved(xmp, cap, film);
        if (epoch !== this.epoch) throw new DOMException('Saved preview superseded', 'AbortError');
        return frame;
      } catch (error) {
        if (epoch === this.epoch) this.current = null;
        throw error;
      }
    });
  }
}
