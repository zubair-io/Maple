import * as publication from './removal-editor-publication';
import { rebindAfterExport } from './removal-editor-rebind';
// Complete local authoring flow for the explicitly installed #3941 experiment.
// Release remains gated on #1472 photo quality, hardware and consumer parity.
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import init, { removal_combine_masks, removal_smart_strokes } from '../raw-pipeline/pkg/raw_wasm';
import { EditorStateService } from '../editor/editor-state.service';
import { LibraryStateService } from '../state/library-state.service';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { ImageCanvasService } from '../components/image-canvas/image-canvas.service';
import { isNonRawExtension } from '../state/raw-extensions';
import type { DecodedImage } from '../raw-pipeline/raw-pipeline.types';
import type { Asset } from '../models/asset';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import type { AdjustmentModel } from '../models/adjustment-model';
import type { RemovalProposal } from './removal-inference.types';
import { RemovalInferenceClient } from './removal-inference-client';
import { RemovalModelStore } from './removal-model-store.service';
import { LocalRemovalAssets } from './local-removal-assets';
import { savedRemovalRecords } from './saved-removal-records';
import { bundleRemovalCompanions } from './removal-companion-bundle';
import { withRemovalRecords } from './removal-editor-recipe';
import { selectionTensors } from './removal-proxy-tensors';
import {
  suggestPeople,
  collectPersonMasks,
  peopleSelectionMessage,
  type RemovalPerson as Person,
} from './removal-person-proposals';

export type RemovalMode = 'paint' | 'smart' | 'people';
export interface RemovalStroke {
  points: readonly (readonly [number, number])[];
  radius: number;
  subtract: boolean;
}
interface OpenPhoto {
  asset: Asset;
  folder: MapleFolderHandle;
  model: AdjustmentModel;
  xml: string;
  source: string;
  width: number;
  height: number;
  prior: string;
  companions: Map<string, Uint8Array>;
  assets: LocalRemovalAssets;
}
interface Draft {
  records: string;
  xml: string;
  proposals: RemovalProposal[];
  companions: Map<string, Uint8Array>;
}

@Injectable({ providedIn: 'root' })
export class RemovalEditorSession {
  private readonly editor = inject(EditorStateService);
  private readonly library = inject(LibraryStateService);
  private readonly files = inject(FolderAccessService);
  readonly pipeline = inject(RawPipelineService);
  readonly sidecars = inject(XmpStoreService);
  private readonly serializer = inject(XmpSerializerService);
  private readonly canvas = inject(ImageCanvasService);
  readonly models = inject(RemovalModelStore);
  readonly active = computed(() => this.editor.armedTool() === 'remove');
  readonly phase = signal<
    'closed' | 'loading' | 'ready' | 'selecting' | 'generating' | 'review' | 'saving' | 'recovery'
  >('closed');
  readonly busy = computed(() =>
    ['loading', 'selecting', 'generating', 'saving'].includes(this.phase()),
  );
  readonly mode = signal<RemovalMode>('paint');
  readonly subtract = signal(false);
  readonly radius = signal(0.015);
  readonly message = signal('');
  readonly selection = signal<Uint8Array>(new Uint8Array());
  readonly protection = signal<Uint8Array>(new Uint8Array());
  readonly people = signal<readonly Person[]>([]);
  readonly preview = signal<DecodedImage | null>(null);
  readonly compare = signal(false);
  readonly stage = signal('');
  readonly canUndoSelection = signal(false);
  readonly canRedoSelection = signal(false);
  readonly canUndoKeep = signal(false);
  photo?: OpenPhoto;
  draft?: Draft;
  inference?: RemovalInferenceClient;
  private tensors?: Awaited<ReturnType<typeof selectionTensors>>;
  private strokes: RemovalStroke[] = [];
  private gestureSizes: number[] = [];
  private redoGestures: RemovalStroke[][] = [];
  private manualProtection: Uint8Array = new Uint8Array();
  committingXml?: string;
  masks: Uint8Array[] = [];
  revision = 0;
  key = '';
  private exportRevision = 0;
  private scopeFolder?: MapleFolderHandle;
  undoRecords?: { prior: string; accepted: string };

  constructor() {
    effect(() => {
      const asset = this.library.focusedAsset();
      const folder = this.library.currentFolder();
      const active = this.active();
      const exportRevision = active ? this.pipeline.exportRevision() : 0;
      const phase = this.phase();
      const xml =
        active && asset ? this.serialize(asset.id, this.library.adjustmentFor(asset.id)()) : '';
      untracked(() => {
        const key = active && asset ? this.keyFor(asset, xml) : '';
        if (
          (this.key === key &&
            this.scopeFolder === folder &&
            this.exportRevision === exportRevision) ||
          (phase === 'saving' &&
            this.committingXml === xml &&
            this.photo?.asset.id === asset?.id &&
            this.photo?.asset.filename === asset?.filename &&
            this.photo?.folder === folder)
        )
          return;
        if (this.key === key && this.scopeFolder === folder && this.photo) {
          if (phase === 'saving') return;
          this.exportRevision = exportRevision;
          void rebindAfterExport(this, () =>
            this.files.readFile(this.photo!.folder, asset!.filename),
          );
          return;
        }
        this.exportRevision = exportRevision;
        this.close();
        this.key = key;
        this.scopeFolder = folder ?? undefined;
        if (active && asset) void this.open(asset, xml);
      });
    });
  }

  setMode(mode: RemovalMode): void {
    if (this.busy() || this.phase() === 'review') return;
    this.clearSelection();
    this.mode.set(mode);
  }
  clearSelection(): void {
    this.revision++;
    this.inference?.cancel();
    this.strokes = [];
    this.gestureSizes = [];
    this.redoGestures = [];
    this.masks = [];
    this.selection.set(new Uint8Array());
    this.canUndoSelection.set(false);
    this.canRedoSelection.set(false);
    this.message.set('');
  }
  async modelsChanged(): Promise<void> {
    if (!this.active() || ['saving', 'review', 'recovery'].includes(this.phase())) return;
    // A model picker may finish while photo hydration has reopened the source.
    // Reopen against the installed snapshot instead of invalidating that load
    // and leaving the panel permanently in Loading.
    await this.retryOpen();
  }
  async retryOpen(): Promise<void> {
    const asset = this.library.focusedAsset();
    if (!asset || !this.active()) return;
    this.close();
    const xml = this.serialize(asset.id, this.library.adjustmentFor(asset.id)());
    this.key = this.keyFor(asset, xml);
    this.scopeFolder = this.library.currentFolder() ?? undefined;
    await this.open(asset, xml);
  }
  async paint(
    points: readonly (readonly [number, number])[],
    cropInputSize: readonly [number, number],
  ): Promise<void> {
    if (this.phase() !== 'ready' || !this.photo || this.mode() === 'people') return;
    const token = ++this.revision;
    const radius = this.radius(),
      subtract = this.subtract();
    this.phase.set('selecting');
    this.message.set('');
    try {
      const mapping = JSON.parse(
        await this.pipeline.removal.map(
          this.photo.xml,
          JSON.stringify({ schema: 1, crop_input_size: cropInputSize, points }),
        ),
      ) as { points: ([number, number] | null)[] };
      this.check(token);
      // A null surround breaks the stroke; it must never connect across an
      // unmapped horizon or clamp the outside pointer onto the image edge.
      const batches: [number, number][][] = [[]];
      for (const point of mapping.points) {
        if (point) batches[batches.length - 1].push(point);
        else if (batches[batches.length - 1].length) batches.push([]);
      }
      const next = batches
        .filter((batch) => batch.length)
        .map((batch) => ({
          points: batch,
          radius,
          subtract,
        }));
      this.strokes = [...this.strokes, ...next];
      if (next.length) this.gestureSizes = [...this.gestureSizes, next.length];
      this.redoGestures = [];
      await this.refreshSelection(token);
    } catch (error) {
      this.fail(error, token);
    } finally {
      if (token === this.revision) this.phase.set('ready');
    }
  }
  async undoSelection(): Promise<void> {
    if (this.busy() || !this.strokes.length || this.phase() === 'review') return;
    const count = this.gestureSizes.at(-1) ?? 1;
    this.redoGestures = [...this.redoGestures, this.strokes.slice(-count)];
    this.gestureSizes = this.gestureSizes.slice(0, -1);
    this.strokes = this.strokes.slice(0, -count);
    const token = ++this.revision;
    this.phase.set('selecting');
    try {
      await this.refreshSelection(token);
    } catch (error) {
      this.fail(error, token);
    } finally {
      if (token === this.revision) this.phase.set('ready');
    }
  }
  async redoSelection(): Promise<void> {
    const gesture = this.redoGestures.at(-1);
    if (!gesture || this.phase() !== 'ready') return;
    this.redoGestures = this.redoGestures.slice(0, -1);
    this.gestureSizes = [...this.gestureSizes, gesture.length];
    this.strokes = [...this.strokes, ...gesture];
    const token = ++this.revision;
    this.phase.set('selecting');
    try {
      await this.refreshSelection(token);
    } catch (error) {
      this.fail(error, token);
    } finally {
      if (token === this.revision) this.phase.set('ready');
    }
  }
  async protectSelection(): Promise<void> {
    if (this.busy() || this.phase() !== 'ready') return;
    this.manualProtection = removal_combine_masks(this.manualProtection, this.selection(), false);
    this.protection.set(this.manualProtection);
    this.clearSelection();
  }
  clearProtection(): void {
    if (this.phase() !== 'ready') return;
    this.manualProtection = new Uint8Array();
    this.protection.set(new Uint8Array());
    this.people.update((people) => people.map((person) => ({ ...person, keep: false })));
    this.clearSelection();
  }

  async detectPeople(): Promise<void> {
    if (!this.photo || this.phase() !== 'ready') return;
    const token = ++this.revision;
    this.phase.set('selecting');
    this.message.set('');
    try {
      const tensors = await this.selectionInputs(token);
      const found = await this.ai().detect(tensors.detector.slice(), [
        this.photo.width,
        this.photo.height,
      ]);
      this.check(token);
      const suggestions = suggestPeople(found, this.photo.width, this.photo.height);
      const masks = await this.masksForPeople(suggestions, token);
      this.check(token);
      this.people.set(suggestions);
      this.masks = masks.people;
      this.selection.set(masks.selection);
      this.protection.set(masks.protection);
      this.message.set(
        suggestions.length
          ? peopleSelectionMessage(this.masks.length > 0)
          : 'No people found. Paint the object instead.',
      );
    } catch (error) {
      this.fail(error, token);
    } finally {
      if (token === this.revision) this.phase.set('ready');
    }
  }
  keepPerson(index: number): void {
    if (this.phase() !== 'ready') return;
    this.clearSelection();
    this.people.update((people) =>
      people.map((person, i) => (i === index ? { ...person, keep: !person.keep } : person)),
    );
  }
  async selectBackgroundPeople(): Promise<void> {
    if (!this.photo || this.phase() !== 'ready' || !this.people().length) return;
    const token = ++this.revision;
    this.phase.set('selecting');
    this.message.set('');
    try {
      const masks = await this.masksForPeople(this.people(), token);
      this.check(token);
      this.masks = masks.people;
      this.selection.set(masks.selection);
      this.protection.set(masks.protection);
      this.message.set(peopleSelectionMessage(this.masks.length > 0));
    } catch (error) {
      this.fail(error, token);
    } finally {
      if (token === this.revision) this.phase.set('ready');
    }
  }

  private async masksForPeople(people: readonly Person[], token: number) {
    if (!people.length)
      return {
        selection: new Uint8Array(),
        protection: this.manualProtection,
        people: [] as Uint8Array[],
      };
    const photo = this.photo!;
    const tensors = await this.selectionInputs(token);
    const context = this.smartRequest(tensors, []);
    return collectPersonMasks(people, this.manualProtection, async (detection) => {
      const [x1, y1, x2, y2] = detection.bounds;
      const clamp = (value: number) => Math.max(0, Math.min(1, value));
      const prompts = [
        { position: [clamp(x1 / photo.width), clamp(y1 / photo.height)], label: 2 },
        { position: [clamp(x2 / photo.width), clamp(y2 / photo.height)], label: 3 },
      ];
      if (
        prompts[0].position[0] >= prompts[1].position[0] ||
        prompts[0].position[1] >= prompts[1].position[1]
      )
        return new Uint8Array();
      const request = JSON.stringify({ ...context, prompts });
      await this.ai().encode(photo.source, request, tensors.encoder.slice());
      const mask = await this.ai().refine(photo.source, request);
      this.check(token);
      return mask;
    });
  }

  remove(): Promise<void> {
    return publication.remove(this);
  }
  cancel(): Promise<void> {
    return publication.cancel(this);
  }
  keep(): Promise<void> {
    return publication.keep(this);
  }
  undoKeep(): Promise<void> {
    return publication.undoKeep(this);
  }

  private async open(asset: Asset, xml: string): Promise<void> {
    const token = this.revision;
    this.phase.set('loading');
    try {
      const folder = this.library.currentFolder();
      const ext = asset.filename.split('.').at(-1)?.toLowerCase() ?? '';
      if (!folder?.native || !folder.write || isNonRawExtension(ext) || asset.isVideo)
        throw new Error(
          'AI removal requires a RAW photo in a folder opened with filesystem write access.',
        );
      await init();
      const assets = new LocalRemovalAssets(this.files, folder, asset.filename);
      const prior = savedRemovalRecords(xml) ?? '[]';
      const companions = new Map(await assets.read(prior));
      const bytes = await this.files.readFile(folder, asset.filename);
      this.check(token);
      const source = await this.pipeline.removal.open({ sourceId: asset.id, bytes, ext });
      this.check(token);
      await this.pipeline.removal.prepareSaved(xml, bundleRemovalCompanions(companions));
      const anchor = JSON.parse(source) as { width: number; height: number };
      this.check(token);
      const models = await this.models.installed();
      this.check(token);
      const photo = {
        asset,
        folder,
        model: this.library.adjustmentFor(asset.id)(),
        xml,
        source,
        width: anchor.width,
        height: anchor.height,
        prior,
        companions,
        assets,
      };
      this.photo = photo;
      this.inference = new RemovalInferenceClient(
        models,
        (stage) => this.photo === photo && this.active() && this.stage.set(stage),
      );
      this.check(token);
      this.phase.set('ready');
      this.canvas.zoomToFit();
    } catch (error) {
      this.fail(error, token);
      if (token === this.revision) this.phase.set('closed');
    }
  }
  async mapOverlay(
    points: readonly (readonly [number, number])[],
    cropInputSize: readonly [number, number],
  ) {
    const photo = this.photo,
      token = this.revision;
    if (!photo) return [];
    const mapped = JSON.parse(
      await this.pipeline.removal.map(
        photo.xml,
        JSON.stringify({ schema: 1, crop_input_size: cropInputSize, points }),
      ),
    ) as { points: ([number, number] | null)[] };
    this.check(token);
    return mapped.points;
  }

  private async refreshSelection(token: number): Promise<void> {
    const photo = this.photo;
    if (!photo) throw new Error('Open the RAW before selecting.');
    let mask: Uint8Array;
    if (!this.strokes.length) mask = new Uint8Array();
    else if (this.mode() === 'paint')
      mask = await this.pipeline.removal.selection(
        JSON.stringify({ schema: 1, strokes: this.strokes }),
      );
    else {
      const tensors = await this.selectionInputs(token);
      const request = removal_smart_strokes(
        JSON.stringify(this.smartRequest(tensors, this.strokes)),
      );
      await this.ai().encode(photo.source, request, tensors.encoder.slice());
      mask = await this.ai().refine(photo.source, request);
    }
    this.check(token);
    this.selection.set(removal_combine_masks(mask, this.protection(), true));
    this.canUndoSelection.set(this.strokes.length > 0);
    this.canRedoSelection.set(this.redoGestures.length > 0);
  }
  private smartRequest(
    tensors: Awaited<ReturnType<typeof selectionTensors>>,
    strokes: readonly RemovalStroke[],
  ) {
    const photo = this.photo!;
    return {
      schema: 1,
      source_width: photo.width,
      source_height: photo.height,
      window: { x: 0, y: 0, width: photo.width, height: photo.height },
      input_width: tensors.inputWidth,
      input_height: tensors.inputHeight,
      prompts: [],
      strokes,
    };
  }
  private async selectionInputs(token: number) {
    if (!this.tensors) {
      const photo = this.photo!;
      const tensors = await selectionTensors(
        await this.pipeline.removal.proxy(photo.xml),
        photo.width,
        photo.height,
      );
      this.check(token);
      this.tensors = tensors;
    }
    this.check(token);
    return this.tensors;
  }
  ai(): RemovalInferenceClient {
    if (!this.inference) throw new Error('Open the removal tool before running AI.');
    return this.inference;
  }
  private serialize(id: string, model: AdjustmentModel): string {
    return this.serializer.serialize(model, this.sidecars.passthroughFor(id));
  }
  keyFor(asset: Asset, xml: string): string {
    return asset.id + '\n' + asset.filename + '\n' + xml;
  }
  cullingFor(photo: OpenPhoto): Asset {
    const asset = this.library.focusedAsset();
    if (
      !asset ||
      asset.id !== photo.asset.id ||
      asset.filename !== photo.asset.filename ||
      this.library.currentFolder() !== photo.folder
    )
      throw new Error('The photo moved before this removal could be saved.');
    return asset;
  }
  resetProxy(): void {
    this.tensors = undefined;
  }
  recipe(photo: OpenPhoto, records: string): string {
    return this.serializer.serialize(
      photo.model,
      withRemovalRecords(this.sidecars.passthroughFor(photo.asset.id), records),
    );
  }
  async restore(photo: OpenPhoto): Promise<void> {
    if (this.library.focusedAsset()?.id !== photo.asset.id) return;
    await this.pipeline.removal.prepareSaved(photo.xml, bundleRemovalCompanions(photo.companions));
  }
  check(token: number): void {
    if (token !== this.revision || !this.active())
      throw new DOMException('Removal operation superseded', 'AbortError');
  }
  fail(error: unknown, token: number): void {
    if (token === this.revision && !(error instanceof DOMException && error.name === 'AbortError'))
      this.message.set(error instanceof Error ? error.message : String(error));
  }
  private close(): void {
    const closingRevision = this.revision + 1;
    if (this.photo && ['review', 'generating', 'recovery'].includes(this.phase()))
      void this.restore(this.photo).catch((error) => {
        // The confirmed main canvas remains visible. A failed restore must
        // retire the draft prefix before any subsequent normal render.
        if (this.revision === closingRevision && !this.active()) {
          this.message.set(error instanceof Error ? error.message : String(error));
          void this.pipeline.closeLiveSession();
          this.pipeline.closeNativeDetail();
        }
      });
    this.revision++;
    this.inference?.dispose();
    this.pipeline.removal.close();
    this.photo = undefined;
    this.scopeFolder = undefined;
    this.draft = undefined;
    this.inference = undefined;
    this.tensors = undefined;
    this.strokes = [];
    this.gestureSizes = [];
    this.redoGestures = [];
    this.masks = [];
    this.undoRecords = undefined;
    this.manualProtection = new Uint8Array();
    this.committingXml = undefined;
    this.selection.set(new Uint8Array());
    this.protection.set(new Uint8Array());
    this.people.set([]);
    this.preview.set(null);
    this.phase.set('closed');
    this.message.set('');
    this.canUndoKeep.set(false);
    this.canUndoSelection.set(false);
    this.canRedoSelection.set(false);
  }
}
