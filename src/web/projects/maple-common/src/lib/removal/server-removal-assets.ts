// Concrete server-backed counterpart of LocalRemovalAssets (#3984).
import { firstValueFrom } from 'rxjs';
import type { Injector } from '@angular/core';
import init, {
  removal_asset_names,
  removal_asset_verify,
  removal_content_digest,
  removal_prepare,
  removal_source_verify,
} from '../raw-pipeline/pkg/raw_wasm';
import type { RemovalServerIoService } from './removal-server-io.service';
import { bundleRemovalCompanions, type RemovalCompanionBundle } from './removal-companion-bundle';

export class ServerRemovalAssets {
  constructor(
    private readonly io: RemovalServerIoService,
    private readonly path: string,
    private readonly original: () => Promise<Uint8Array>,
  ) {}

  async publish(
    request: string,
    prior: string,
    mask: Uint8Array,
    patch: Uint8Array,
  ): Promise<string> {
    await init();
    const records = removal_prepare(request, prior, mask, patch);
    await this.verifySource(records);
    const names = this.names(records);
    for (const bytes of [mask, patch]) {
      const digest = removal_content_digest(bytes).slice('blake3:'.length);
      const name = names.find((value) => value.startsWith(digest + '.'));
      if (!name) throw new Error('Prepared removal does not reference this companion.');
      removal_asset_verify(name, bytes);
      await firstValueFrom(this.io.publish(this.path, name, bytes));
      removal_asset_verify(name, await firstValueFrom(this.io.read(this.path, name)));
    }
    await this.read(records);
    return records;
  }

  async read(records: string): Promise<ReadonlyMap<string, Uint8Array>> {
    await init();
    const entries = await Promise.all(
      this.names(records).map(async (name) => {
        const bytes = await firstValueFrom(this.io.read(this.path, name));
        removal_asset_verify(name, bytes);
        return [name, bytes] as const;
      }),
    );
    return new Map(entries);
  }

  async readBundle(records: string): Promise<RemovalCompanionBundle> {
    const companions = await this.read(records);
    await this.verifySource(records);
    return bundleRemovalCompanions(companions);
  }

  async verifySource(records: string): Promise<void> {
    await init();
    removal_source_verify(records, removal_content_digest(await this.original()));
  }

  private names(records: string): string[] {
    return JSON.parse(removal_asset_names(records)) as string[];
  }
}

/** Loaded only by actual server-backed sources; Hosted keeps its local owner. */
export async function openServerRemovalAssets(
  injector: Injector,
  path: string,
  original: () => Promise<Uint8Array>,
): Promise<ServerRemovalAssets> {
  const { RemovalServerIoService } = await import('./removal-server-io.service');
  return new ServerRemovalAssets(injector.get(RemovalServerIoService), path, original);
}
