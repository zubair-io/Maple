import { Injectable, inject } from '@angular/core';
import type { AdjustmentModel } from '../models/adjustment-model';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { WORKFLOW_MARKUP_PATTERN } from '../generated/workflow.generated';
import type { PassthroughBucket, XmpCulling, XmpMetadata } from './xmp.types';
import type { HostedSidecarBinding } from './sidecar-binding';
import { HostedWorkflowWriterService } from './hosted-workflow-writer.service';
import { WorkflowXmpService } from './workflow-xmp.service';
import { XmpSerializerService } from './xmp-serializer.service';
import { HostedSidecarFreshnessService } from './hosted-sidecar-freshness.service';

/** Publishes one sidecar document for a binding and returns the bytes written. */
@Injectable({ providedIn: 'root' })
export class SidecarDocumentWriterService {
  private readonly access = inject(FolderAccessService);
  private readonly serializer = inject(XmpSerializerService);
  private readonly hostedWriter = inject(HostedWorkflowWriterService);
  private readonly workflowCore = inject(WorkflowXmpService);
  private readonly freshness = inject(HostedSidecarFreshnessService);

  async write(
    binding: HostedSidecarBinding,
    model: AdjustmentModel,
    culling: XmpCulling,
    passthrough: PassthroughBucket | undefined,
    metadata: XmpMetadata | undefined,
    expectedDocument?: string | null,
  ): Promise<string> {
    const { folder, filename } = binding;
    if (folder.native && navigator.locks)
      return this.hostedWriter.write(
        folder,
        filename,
        model,
        culling,
        passthrough,
        metadata,
        binding.variantId,
        expectedDocument,
      );
    if (folder.native)
      this.freshness.assertUnchanged(
        folder,
        filename,
        await this.freshness.readCurrent(folder, filename),
        expectedDocument,
      );
    const xml = this.serializer.serialize(model, passthrough, culling, metadata);
    if (new RegExp(WORKFLOW_MARKUP_PATTERN, 'u').test(xml)) await this.workflowCore.read(xml);
    // FS Access writable-stream close() is atomic on Chromium; the IndexedDB
    // fallback backend is atomic too.
    await this.access.writeFile(folder, filename, new TextEncoder().encode(xml));
    if (folder.native) this.freshness.remember(folder, filename, xml);
    return xml;
  }
}
