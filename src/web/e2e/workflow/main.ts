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
    async checkpoints(row: unknown, input: string) {
      const environment = injector();
      const root = await navigator.storage.getDirectory();
      const directoryName = 'maple-variant-checkpoint-' + crypto.randomUUID();
      const native = await root.getDirectoryHandle(directoryName, { create: true });
      const folder = { native, name: directoryName, read: true, write: true };
      try {
        const core: WorkflowXmpService = environment.get(WorkflowXmpService);
        const access = environment.get(FolderAccessService);
        const record = parseSidecarWorkflow(row);
        const embedded = await core.embed(record, input);
        const checkpoint = await core.checkpoint(embedded);
        const basename = await core.variantFilename('photo.MOV.xmp', record.variantId);
        await access.writeFile(folder, 'photo.MOV', new Uint8Array([1, 0, 255, 42]));
        await access.writeFile(folder, basename, new TextEncoder().encode(checkpoint));
        const reopened = new TextDecoder().decode(await access.readFile(folder, basename));
        const start = embedded.indexOf('<papp:Workflow');
        const end = embedded.indexOf('</papp:Workflow>') + '</papp:Workflow>'.length;
        const exact = reopened === embedded.slice(0, start) + embedded.slice(end);
        const parser = environment.get(XmpParserService);
        const unchangedModel =
          JSON.stringify(parser.parseAdjustmentModel(reopened).model) ===
          JSON.stringify(parser.parseAdjustmentModel(embedded).model);
        const reject = async (operation: () => Promise<string>) => {
          try {
            await operation();
            return false;
          } catch {
            return true;
          }
        };
        return {
          basename,
          exact,
          unchangedModel,
          record: await core.read(reopened),
          primary: await core.variantFilename('photo.MOV.xmp', 'primary'),
          plain: (await core.checkpoint(input)) === input,
          invalidPath: await reject(() => core.variantFilename('../photo.xmp', record.variantId)),
          invalidId: await reject(() => core.variantFilename('photo.xmp', '../primary')),
          future: await reject(() =>
            core.checkpoint(embedded.replace('<papp:SchemaVersion>1', '<papp:SchemaVersion>2')),
          ),
          sidecarUnchanged:
            new TextDecoder().decode(await access.readFile(folder, basename)) === reopened,
          original: Array.from(await access.readFile(folder, 'photo.MOV')),
        };
      } finally {
        environment.destroy();
        await root.removeEntry(directoryName, { recursive: true });
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
