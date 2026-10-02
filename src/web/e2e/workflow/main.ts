import '@angular/compiler';
import { createEnvironmentInjector, Injector, type EnvironmentInjector } from '@angular/core';
import { FolderAccessService } from '../../projects/maple-common/src/lib/folder-access/folder-access.service';
import { XmpStoreService } from '../../projects/maple-common/src/lib/xmp/xmp-store.service';
import { XmpParserService } from '../../projects/maple-common/src/lib/xmp/xmp-parser.service';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import { WorkflowXmpService } from '../../projects/maple-common/src/lib/xmp/workflow-xmp.service';
import { SidecarSaveStateService } from '../../projects/maple-common/src/lib/xmp/sidecar-save-state.service';
import { defaultAdjustmentModel } from '../../projects/maple-common/src/lib/models/adjustment-model';
import { parseSidecarWorkflow } from '../../projects/maple-common/src/lib/generated/workflow.generated';
const injector = () =>
  createEnvironmentInjector(
    [
      FolderAccessService,
      XmpStoreService,
      XmpParserService,
      XmpSerializerService,
      WorkflowXmpService,
      SidecarSaveStateService,
    ],
    Injector.NULL as EnvironmentInjector,
  );

Object.assign(window, {
  workflowTest: {
    ready: true,
    async roundtrip(row: unknown, input: string, future = false, concurrent = false) {
      const record = parseSidecarWorkflow(row);
      const root = await navigator.storage.getDirectory();
      const name = 'maple-workflow-' + crypto.randomUUID();
      const native = await root.getDirectoryHandle(name, { create: true });
      const folder = { native, name, read: true, write: true };
      let environment = injector();
      try {
        const access = environment.get(FolderAccessService);
        if (access.backend !== 'fs-access')
          throw Error('This gate needs actual Chromium File System Access');
        await access.writeFile(folder, 'photo.dng', new Uint8Array([1, 0, 255, 42]));
        await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(input));
        const store: XmpStoreService = environment.get(XmpStoreService);
        const workflowWrite = store.writeWorkflow('photo', folder, 'photo.dng', record);
        if (concurrent) {
          store.scheduleWrite(
            'photo',
            folder,
            'photo.dng',
            { ...defaultAdjustmentModel(), exposure: 0.75 },
            { rating: 0, flag: 'none', colorLabel: 'none', keywords: [] },
          );
          await Promise.all([workflowWrite, store.flushAsset('photo')]);
        } else await workflowWrite;
        const read = async () =>
          new TextDecoder().decode(await access.readFile(folder, 'photo.xmp'));
        const embedded = await read();
        const core = environment.get(WorkflowXmpService);
        const reopened = await core.read(embedded);
        if (future) {
          const unsupported = embedded.replace('<papp:SchemaVersion>1', '<papp:SchemaVersion>2');
          await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(unsupported));
          let rejected = false;
          try {
            await store.writeWorkflow('photo', folder, 'photo.dng', record);
          } catch {
            rejected = true;
          }
          if (!rejected || (await read()) !== unsupported)
            throw Error('Future sidecar was replaced');
          return {
            rejected,
            unchanged: true,
            original: Array.from(await access.readFile(folder, 'photo.dng')),
          };
        }
        // An ordinary edit must retain the exact embedded authored checkpoints.
        const parser = environment.get(XmpParserService);
        const parsed = parser.parseAdjustmentModel(embedded);
        store.rememberPassthrough('photo', parsed.passthrough);
        store.scheduleWrite(
          'photo',
          folder,
          'photo.dng',
          { ...defaultAdjustmentModel(), ...parsed.model, exposure: 1.25 },
          { rating: 0, flag: 'none', colorLabel: 'none', keywords: [] },
        );
        await store.flushAsset('photo');
        const adjusted = await read();
        const retained = await core.read(adjusted);
        environment.destroy();
        environment = injector();
        const fresh = await environment.get(WorkflowXmpService).read(await read());
        return {
          reopened,
          retained,
          fresh,
          foreignMask: adjusted.includes('<crs:MaskGroupBasedCorrections>'),
          exposure: environment.get(XmpParserService).parseAdjustmentModel(adjusted).model.exposure,
          original: Array.from(await access.readFile(folder, 'photo.dng')),
        };
      } finally {
        environment.destroy();
        await root.removeEntry(name, { recursive: true });
      }
    },
    async rejects(row: unknown, xmp: string) {
      const environment = injector();
      try {
        await environment.get(WorkflowXmpService).embed(parseSidecarWorkflow(row), xmp);
        return false;
      } catch {
        return true;
      } finally {
        environment.destroy();
      }
    },
  },
});
