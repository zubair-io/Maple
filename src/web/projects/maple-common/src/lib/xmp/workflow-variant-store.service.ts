/** Portable sibling storage, before cache/UI switching in #2437 (#4040). */
import { Injectable, inject } from '@angular/core';
import { FolderAccessService } from '../folder-access/folder-access.service';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import {
  PRIMARY_VARIANT_ID,
  parseSidecarWorkflow,
  type SidecarWorkflow,
} from '../generated/workflow.generated';
import { WorkflowXmpService } from './workflow-xmp.service';

export interface WorkflowVariantSidecar {
  variantId: string;
  filename: string;
  workflow: SidecarWorkflow | null;
  exists: boolean;
}

@Injectable({ providedIn: 'root' })
export class WorkflowVariantStoreService {
  private readonly access = inject(FolderAccessService);
  private readonly core = inject(WorkflowXmpService);

  async list(folder: MapleFolderHandle, primaryName: string): Promise<WorkflowVariantSidecar[]> {
    const primary = await this.core.variantFilename(primaryName, PRIMARY_VARIANT_ID);
    const prefix = primary.slice(0, -4) + '.v';
    const entries = (await this.access.listEntries(folder)).filter(
      (entry) => entry.kind === 'file',
    );
    const ids = entries
      .map((entry) => entry.name)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.xmp'))
      .map((name) => name.slice(prefix.length, -4))
      .filter((id) => id.length === 36)
      .sort();
    return Promise.all(
      [PRIMARY_VARIANT_ID, ...ids].map((id) => this.inspect(folder, primaryName, id)),
    );
  }

  async read(
    folder: MapleFolderHandle,
    primaryName: string,
    variantId: string,
  ): Promise<string | null> {
    const filename = await this.core.variantFilename(primaryName, variantId);
    const exists = (await this.access.listEntries(folder)).some(
      (entry) => entry.kind === 'file' && entry.name === filename,
    );
    if (!exists) {
      if (variantId === PRIMARY_VARIANT_ID) return null;
      throw Error(`Variant sidecar is missing: ${filename}. Restore it before editing.`);
    }
    const bytes = await this.access.readFile(folder, filename);
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    this.requireIdentity(await this.core.read(xml), variantId, filename);
    return xml;
  }

  async create(
    folder: MapleFolderHandle,
    primaryName: string,
    workflow: SidecarWorkflow,
    sourceId = PRIMARY_VARIANT_ID,
  ): Promise<WorkflowVariantSidecar> {
    const parsed = parseSidecarWorkflow(workflow);
    this.requireWrite(folder);
    if (parsed.variantId === PRIMARY_VARIANT_ID)
      throw Error('Create a new variant identity; the primary already exists.');
    // Coordinate UUID creation across cooperating tabs; FS Access close owns
    // atomic content publication, just as for the existing primary writer.
    return navigator.locks.request('maple-workflow-variant:' + parsed.variantId, async () => {
      const filename = await this.core.variantFilename(primaryName, parsed.variantId);
      if ((await this.access.listEntries(folder)).some((entry) => entry.name === filename))
        throw Error('Variant identity already exists. Choose a new identity.');
      const source = await this.read(folder, primaryName, sourceId);
      if (source === null) throw Error('Commit the source adjustments before creating a variant.');
      const output = await this.core.embed(parsed, source);
      await this.access.writeFile(folder, filename, new TextEncoder().encode(output));
      return this.inspect(folder, primaryName, parsed.variantId);
    });
  }

  async write(
    folder: MapleFolderHandle,
    primaryName: string,
    variantId: string,
    xmp: string,
  ): Promise<void> {
    this.requireWrite(folder);
    return navigator.locks.request('maple-workflow-variant:' + variantId, async () => {
      const filename = await this.core.variantFilename(primaryName, variantId);
      const existing = await this.read(folder, primaryName, variantId);
      const oldRecord = existing === null ? null : await this.core.read(existing);
      const nextRecord = await this.core.read(xmp);
      const output =
        nextRecord === null && oldRecord !== null ? await this.core.embed(oldRecord, xmp) : xmp;
      this.requireIdentity(nextRecord ?? oldRecord, variantId, filename);
      await this.access.writeFile(folder, filename, new TextEncoder().encode(output));
    });
  }

  private async inspect(
    folder: MapleFolderHandle,
    primaryName: string,
    id: string,
  ): Promise<WorkflowVariantSidecar> {
    const filename = await this.core.variantFilename(primaryName, id);
    const xml = await this.read(folder, primaryName, id);
    return {
      variantId: id,
      filename,
      workflow: xml === null ? null : await this.core.read(xml),
      exists: xml !== null,
    };
  }
  private requireIdentity(record: SidecarWorkflow | null, id: string, filename: string): void {
    if ((record?.variantId ?? PRIMARY_VARIANT_ID) !== id)
      throw Error(
        `Variant identity does not match ${filename}. Repair the sidecar before editing.`,
      );
  }
  private requireWrite(folder: MapleFolderHandle): void {
    if (!folder.write || !folder.native)
      throw Error('Reopen this folder with write access before editing its portable variants.');
  }
}
