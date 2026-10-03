// Confirmed removal publication bound to the selected sibling XMP (#3984, #4063).
import { WORKFLOW_MARKUP_PATTERN } from '../generated/workflow.generated';
import { Injectable, inject } from '@angular/core';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { LocalRemovalAssets } from '../removal/local-removal-assets';
import { withRemovalWriteLock } from '../removal/removal-write-lock';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { HostedSidecarBinding } from './xmp-store.service';
import type { PassthroughBucket, XmpCulling } from './xmp.types';
import { SidecarFileIoService } from './sidecar-file-io.service';
import { WorkflowXmpService } from './workflow-xmp.service';
import { XmpSerializerService } from './xmp-serializer.service';

@Injectable({ providedIn: 'root' })
export class HostedRemovalWriterService {
  private readonly access = inject(FolderAccessService);
  private readonly files = inject(SidecarFileIoService);
  private readonly core = inject(WorkflowXmpService);
  private readonly serializer = inject(XmpSerializerService);

  async write(
    binding: HostedSidecarBinding,
    model: AdjustmentModel,
    culling: XmpCulling,
    expectedRecords: string,
    records: string,
    expectedRevision?: string,
  ): Promise<{ revision: string; passthrough: PassthroughBucket }> {
    const { folder, rawFilename, filename, variantId } = binding;
    const assets = new LocalRemovalAssets(this.access, folder, rawFilename);
    return withRemovalWriteLock(folder, rawFilename, async () => {
      const publish = async () => {
        if (
          expectedRevision !== undefined &&
          (await this.files.revision(folder, filename)) !== expectedRevision
        )
          throw Error(
            'The photo changed before this removal could be saved. Reopen the photo to load its current edits.',
          );
        const source = await this.files.passthrough(folder, filename);
        const xmlSource =
          source === undefined
            ? null
            : new TextDecoder('utf-8', { fatal: true }).decode(
                await this.access.readFile(folder, filename),
              );
        const workflow =
          xmlSource === null || !new RegExp(WORKFLOW_MARKUP_PATTERN, 'u').test(xmlSource)
            ? null
            : await this.core.read(xmlSource);
        if ((workflow?.variantId ?? 'primary') !== variantId)
          throw Error('Variant identity does not match the selected sidecar.');
        const current =
          source?.unknownAttributes.find((a) => a.name === 'papp:InpaintRemovals')?.value ?? '[]';
        if (current !== expectedRecords)
          throw Error('The photo changed before this removal could be saved.');
        await assets.verifySource(expectedRecords);
        await assets.verifySource(records);
        await assets.read(records);
        const passthrough: PassthroughBucket = {
          ...source,
          unknownAttributes: [
            ...(source?.unknownAttributes ?? []).filter((a) => a.name !== 'papp:InpaintRemovals'),
            { name: 'papp:InpaintRemovals', value: records },
          ],
          unknownNodes: source?.unknownNodes ?? [],
        };
        const xml = this.serializer.serialize(
          { ...model, inpaintRemovals: records },
          passthrough,
          culling,
        );
        await this.access.writeFile(folder, filename, new TextEncoder().encode(xml));
        const revision = await this.files.digest(new TextEncoder().encode(xml));
        if ((await this.files.revision(folder, filename)) !== revision)
          throw Error('Removal sidecar verification failed.');
        const reopened = await this.files.passthrough(folder, filename);
        if (
          reopened?.unknownAttributes.find((a) => a.name === 'papp:InpaintRemovals')?.value !==
          records
        )
          throw Error('Removal sidecar verification failed.');
        return { revision, passthrough };
      };
      return folder.native && navigator.locks
        ? navigator.locks.request('maple-workflow-variant:' + variantId, publish)
        : publish();
    });
  }
}
