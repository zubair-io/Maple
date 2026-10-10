// Actual sidecar bytes at confirmed-save boundaries; no presentation cache.
import { Injectable, inject } from '@angular/core';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { XmpParserService } from './xmp-parser.service';
import { WorkflowXmpService } from './workflow-xmp.service';
import type { PassthroughBucket } from './xmp.types';
import type { SidecarWorkflow } from '../generated/workflow.generated';
import { hasXmlParseError } from './xmp-dom-utils';

@Injectable({ providedIn: 'root' })
export class SidecarFileIoService {
  private readonly folderAccess = inject(FolderAccessService);
  private readonly parser = inject(XmpParserService);
  private readonly core = inject(WorkflowXmpService);

  async writeWorkflow(
    folder: MapleFolderHandle,
    name: string,
    workflow: SidecarWorkflow,
    variantId: string,
  ): Promise<PassthroughBucket> {
    if (workflow.variantId !== variantId)
      throw Error('Variant identity does not match the selected sidecar.');
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(
      await this.folderAccess.readFile(folder, name),
    );
    const existing = await this.core.read(xml);
    if ((existing?.variantId ?? 'primary') !== variantId)
      throw Error('Variant identity does not match the selected sidecar.');
    const output = await this.core.embed(workflow, xml);
    await this.folderAccess.writeFile(folder, name, new TextEncoder().encode(output));
    return this.parser.parseAdjustmentModel(output).passthrough;
  }

  async revision(folder: MapleFolderHandle, sidecarName: string): Promise<string> {
    try {
      const bytes = await this.folderAccess.readFile(folder, sidecarName);
      return this.digest(bytes);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return 'missing';
      throw error;
    }
  }

  async digest(bytes: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
    return [...new Uint8Array(hash)].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  async passthrough(
    folder: MapleFolderHandle,
    sidecarName: string,
  ): Promise<PassthroughBucket | undefined> {
    try {
      const bytes = await this.folderAccess.readFile(folder, sidecarName);
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (hasXmlParseError(new DOMParser().parseFromString(xml, 'application/xml'))) {
        throw new Error('Cannot replace a malformed photo sidecar.');
      }
      return this.parser.parseAdjustmentModel(xml).passthrough;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
      throw error;
    }
  }
}
