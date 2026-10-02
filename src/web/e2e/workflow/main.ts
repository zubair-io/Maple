import '@angular/compiler';
import { createEnvironmentInjector, Injector, type EnvironmentInjector } from '@angular/core';
import { FolderAccessService } from '../../projects/maple-common/src/lib/folder-access/folder-access.service';
import { XmpStoreService } from '../../projects/maple-common/src/lib/xmp/xmp-store.service';
import { XmpParserService } from '../../projects/maple-common/src/lib/xmp/xmp-parser.service';
import { XmpSerializerService } from '../../projects/maple-common/src/lib/xmp/xmp-serializer.service';
import { WorkflowVariantStoreService } from '../../projects/maple-common/src/lib/xmp/workflow-variant-store.service';
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
      WorkflowVariantStoreService,
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
    async foreignWb(row: unknown, input: string) {
      const environment = injector();
      const root = await navigator.storage.getDirectory();
      const name = 'maple-foreign-wb-' + crypto.randomUUID();
      const native = await root.getDirectoryHandle(name, { create: true });
      const folder = { native, name, read: true, write: true };
      try {
        const access = environment.get(FolderAccessService);
        const parser = environment.get(XmpParserService);
        const core: WorkflowXmpService = environment.get(WorkflowXmpService);
        await access.writeFile(folder, 'photo.dng', new Uint8Array([1, 0, 255, 42]));
        const before = parser.parseAdjustmentModel(input).model;
        const embedded = await core.embed(parseSidecarWorkflow(row), input);
        await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(embedded));
        const reopened = new TextDecoder().decode(await access.readFile(folder, 'photo.xmp'));
        return {
          before,
          after: parser.parseAdjustmentModel(reopened).model,
          workflow: await core.read(reopened),
          original: Array.from(await access.readFile(folder, 'photo.dng')),
        };
      } finally {
        environment.destroy();
        await root.removeEntry(name, { recursive: true });
      }
    },
    async mutations(input: string) {
      let environment = injector();
      const root = await navigator.storage.getDirectory();
      const directoryName = 'maple-authoring-' + crypto.randomUUID();
      const native = await root.getDirectoryHandle(directoryName, { create: true });
      const folder = { native, name: directoryName, read: true, write: true };
      try {
        const access = environment.get(FolderAccessService);
        await access.writeFile(folder, 'photo.dng', new Uint8Array([1, 0, 255, 42]));
        await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(input));
        const core: WorkflowXmpService = environment.get(WorkflowXmpService);
        const store: WorkflowVariantStoreService = environment.get(WorkflowVariantStoreService);
        const entry = async (xml: string, action = 'adjustment') => ({
          id: crypto.randomUUID(),
          createdAtMs: Date.now(),
          action,
          label: 'Committed exposure',
          adjustmentXmp: await core.checkpoint(xml),
        });
        const first = await store.commit(
          folder,
          'photo.xmp',
          'primary',
          input,
          input,
          await entry(input),
        );
        const captured = await core.checkpoint(first);
        const snapshot = {
          id: crypto.randomUUID(),
          name: 'Warm study 🌅',
          createdAtMs: Date.now(),
          adjustmentXmp: captured,
        };
        const saved = await store.saveSnapshot(folder, 'photo.xmp', 'primary', first, snapshot);
        const edited = saved.replace(
          'crs:ProcessVersion="15.4"',
          'crs:ProcessVersion="15.4" crs:Exposure2012="1.25"',
        );
        const next = await store.commit(
          folder,
          'photo.xmp',
          'primary',
          saved,
          edited,
          await entry(edited),
        );
        const restoreEntry = await entry(captured, 'snapshot-restore');
        const staleEntry = await entry(saved);
        const forgedRestore = await entry(edited, 'snapshot-restore');
        environment.destroy();
        environment = injector();
        const freshCore: WorkflowXmpService = environment.get(WorkflowXmpService);
        const freshStore: WorkflowVariantStoreService = environment.get(
          WorkflowVariantStoreService,
        );
        const reopened = await freshStore.read(folder, 'photo.xmp', 'primary');
        if (reopened === null) throw Error('Committed history disappeared');
        const restored = await freshStore.restore(
          folder,
          'photo.xmp',
          'primary',
          reopened,
          restoreEntry,
        );
        const record = await freshCore.read(restored);
        const reject = async (operation: () => Promise<string>) => {
          try {
            await operation();
            return false;
          } catch {
            return true;
          }
        };
        const stale = await reject(() =>
          freshStore.commit(folder, 'photo.xmp', 'primary', reopened, edited, staleEntry),
        );
        const duplicate = await reject(() =>
          freshStore.saveSnapshot(folder, 'photo.xmp', 'primary', restored, snapshot),
        );
        const forged = await reject(() =>
          freshStore.restore(folder, 'photo.xmp', 'primary', restored, forgedRestore),
        );
        const future = restored.replace('<papp:SchemaVersion>1', '<papp:SchemaVersion>2');
        const futureReject = await reject(() => freshCore.restore(restoreEntry, future));
        return {
          snapshot: record?.snapshots[0],
          expectedSnapshot: snapshot,
          historyCount: record?.history.length,
          latest: record?.history.at(-1),
          expectedRestore: restoreEntry,
          exact: (await freshCore.checkpoint(restored)) === captured,
          modelRestored:
            JSON.stringify(
              environment.get(XmpParserService).parseAdjustmentModel(restored).model,
            ) ===
            JSON.stringify(environment.get(XmpParserService).parseAdjustmentModel(saved).model),
          editedExposure: environment.get(XmpParserService).parseAdjustmentModel(next).model
            .exposure,
          stale,
          duplicate,
          forged,
          futureReject,
          diskUnchanged: (await freshStore.read(folder, 'photo.xmp', 'primary')) === restored,
          original: Array.from(await access.readFile(folder, 'photo.dng')),
        };
      } finally {
        environment.destroy();
        await root.removeEntry(directoryName, { recursive: true });
      }
    },
    async confirmedRace(input: string, absent: boolean) {
      const root = await navigator.storage.getDirectory();
      const directoryName = 'maple-confirmed-race-' + crypto.randomUUID();
      const native = await root.getDirectoryHandle(directoryName, { create: true });
      const folder = { native, name: directoryName, read: true, write: true };
      const environments = [injector(), injector()];
      try {
        const access = environments[0].get(FolderAccessService);
        await access.writeFile(folder, 'photo.dng', new Uint8Array([1, 0, 255, 42]));
        if (!absent) await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(input));
        const attempts = await Promise.allSettled(
          Array.from({ length: 8 }, (_, i) => {
            const store = environments[i % environments.length].get(WorkflowVariantStoreService);
            return store.commit(folder, 'photo.xmp', 'primary', absent ? null : input, input, {
              id: crypto.randomUUID(),
              createdAtMs: 1,
              action: 'adjustment',
              label: 'Exposure',
              adjustmentXmp: input,
            });
          }),
        );
        const store = environments[0].get(WorkflowVariantStoreService);
        const saved = await store.read(folder, 'photo.xmp', 'primary');
        if (saved === null) throw Error('Confirmed sidecar disappeared');
        const core = environments[0].get(WorkflowXmpService);
        const record = await core.read(saved);
        const next = await store.commit(folder, 'photo.xmp', 'primary', saved, input, {
          id: crypto.randomUUID(),
          createdAtMs: 2,
          action: 'adjustment',
          label: 'Retry after reopen',
          adjustmentXmp: input,
        });
        return {
          winners: attempts.filter((attempt) => attempt.status === 'fulfilled').length,
          stale: attempts.filter(
            (attempt) =>
              attempt.status === 'rejected' && String(attempt.reason).includes('changed'),
          ).length,
          count: record?.history.length,
          acknowledged: attempts.some(
            (attempt) => attempt.status === 'fulfilled' && attempt.value === saved,
          ),
          retryCount: (await core.read(next))?.history.length,
          retryAcknowledged: (await store.read(folder, 'photo.xmp', 'primary')) === next,
          original: Array.from(await access.readFile(folder, 'photo.dng')),
        };
      } finally {
        for (const environment of environments) environment.destroy();
        await root.removeEntry(directoryName, { recursive: true });
      }
    },
    async variants(row: unknown, input: string) {
      let environment = injector();
      const root = await navigator.storage.getDirectory();
      const directoryName = 'maple-variant-storage-' + crypto.randomUUID();
      const native = await root.getDirectoryHandle(directoryName, { create: true });
      const folder = { native, name: directoryName, read: true, write: true };
      try {
        const access = environment.get(FolderAccessService);
        await access.writeFile(folder, 'photo.dng', new Uint8Array([1, 0, 255, 42]));
        await access.writeFile(folder, 'photo.xmp', new TextEncoder().encode(input));
        const record = parseSidecarWorkflow(row);
        const store: WorkflowVariantStoreService = environment.get(WorkflowVariantStoreService);
        const creations = await Promise.allSettled([
          store.create(folder, 'photo.xmp', record),
          store.create(folder, 'photo.xmp', record),
        ]);
        const oneCreated =
          creations.filter((result) => result.status === 'fulfilled').length === 1 &&
          creations.filter((result) => result.status === 'rejected').length === 1;
        const edited = input.replace(
          'crs:ProcessVersion="15.4"',
          'crs:ProcessVersion="15.4" crs:Exposure2012="1.25"',
        );
        await store.write(folder, 'photo.xmp', record.variantId, edited);
        const first = await store.read(folder, 'photo.xmp', record.variantId);
        if (first === null) throw Error('Created variant missing');
        const second = {
          ...record,
          variantId: crypto.randomUUID(),
          variantName: 'Alternate',
          snapshots: [],
          history: [],
        };
        await store.create(folder, 'photo.xmp', second, record.variantId);
        environment.destroy();
        environment = injector();
        const reopened: WorkflowVariantStoreService = environment.get(WorkflowVariantStoreService);
        const listed = await reopened.list(folder, 'photo.xmp');
        const secondXml = await reopened.read(folder, 'photo.xmp', second.variantId);
        const reject = async (operation: () => Promise<unknown>) => {
          try {
            await operation();
            return false;
          } catch {
            return true;
          }
        };
        const missing = crypto.randomUUID();
        const missingRead = await reject(() => reopened.read(folder, 'photo.xmp', missing));
        const missingWrite = await reject(() =>
          reopened.write(folder, 'photo.xmp', missing, edited),
        );
        const lostWrite = await reject(() =>
          reopened.write({ ...folder, write: false }, 'photo.xmp', record.variantId, edited),
        );
        const filename = `photo.v${record.variantId}.xmp`;
        const future = first.replace('<papp:SchemaVersion>1', '<papp:SchemaVersion>2');
        await access.writeFile(folder, filename, new TextEncoder().encode(future));
        const futureWrite = await reject(() =>
          reopened.write(folder, 'photo.xmp', record.variantId, edited),
        );
        const futureList = await reject(() => reopened.list(folder, 'photo.xmp'));
        const futureUnchanged =
          new TextDecoder().decode(await access.readFile(folder, filename)) === future;
        const mismatch = first.replace(record.variantId, crypto.randomUUID());
        await access.writeFile(folder, filename, new TextEncoder().encode(mismatch));
        const mismatched = await reject(() => reopened.read(folder, 'photo.xmp', record.variantId));
        return {
          oneCreated,
          listed: listed.map((variant) => variant.variantId).sort(),
          expected: ['primary', record.variantId, second.variantId].sort(),
          retained: await environment.get(WorkflowXmpService).read(first),
          secondExposure:
            secondXml !== null &&
            environment.get(XmpParserService).parseAdjustmentModel(secondXml).model.exposure ===
              1.25,
          missingRead,
          missingWrite,
          lostWrite,
          futureWrite,
          futureList,
          futureUnchanged,
          mismatched,
          sourceUnchanged:
            new TextDecoder().decode(await access.readFile(folder, 'photo.xmp')) === input,
          original: Array.from(await access.readFile(folder, 'photo.dng')),
        };
      } finally {
        environment.destroy();
        await root.removeEntry(directoryName, { recursive: true });
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
