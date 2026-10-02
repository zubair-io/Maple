import * as publication from './removal-editor-publication';
import * as painting from './removal-editor-painting';
import * as saved from './removal-editor-saved';
import type { SavedRemovalEntry } from '../generated/removal-models.generated';
import type { PersonBase, PersonGesture } from './removal-person-refinement';
import { rebindAfterExport } from './removal-editor-rebind';
// Complete local authoring flow for the explicitly installed #3941 experiment.
// Release remains gated on #1472 photo quality, hardware and consumer parity.
import { Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import init, { removal_combine_masks } from '../raw-pipeline/pkg/raw_wasm';
import { EditorStateService } from '../editor/editor-state.service';
import { stableStringify } from '../editor/edit-transaction';
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
import { RemovalInferenceClient } from './removal-inference-client';
import { RemovalModelStore } from './removal-model-store.service';
import type { OpenRemovalPhoto as OpenPhoto, RemovalDraft as Draft } from './removal-editor-types';
import { removalEditorStorage } from './removal-editor-storage';
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

@Injectable({ providedIn: 'root' })
export class RemovalEditorSession {
  readonly editor = inject(EditorStateService);
  private readonly library = inject(LibraryStateService);
  private readonly files = inject(FolderAccessService);
  private readonly injector = inject(Injector);
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
  readonly savedRemovals = signal<readonly SavedRemovalEntry[]>([]);
  readonly replacingRemoval = signal<SavedRemovalEntry | null>(null);
  replacementBase: Uint8Array = new Uint8Array();
  readonly refiningPerson = signal<number | null>(null);
  readonly personBases = signal<readonly PersonBase[]>([]);
  readonly canPaint = computed(() => this.mode() !== 'people' || this.refiningPerson() !== null);
  // The camera JPEG can be visible before the decoder reports crop geometry.
  // Brush controls must wait for the same geometry the overlay maps (#3984).
  readonly paintReady = computed(() => {
    const layout = this.canvas.displayLayout();
    return (
      this.phase() === 'ready' &&
      this.canvas.cropInputDimensions() !== null &&
      !!layout &&
      layout.canvasW > 0 &&
      layout.canvasH > 0
    );
  });
  personGestures: PersonGesture[] = [];
  redoPersonGestures: PersonGesture[] = [];
  readonly preview = signal<DecodedImage | null>(null);
  readonly compare = signal(false);
  readonly stage = signal('');
  readonly canUndoSelection = signal(false);
  readonly canRedoSelection = signal(false);
  readonly canUndoKeep = computed(
    () =>
      this.editor.canUndo() &&
      !!this.editor
        .undoHistory()
        .at(-1)
        ?.diff.some((field) => field.key === 'papp:InpaintRemovals'),
  );
  photo?: OpenPhoto;
  draft?: Draft;
  inference?: RemovalInferenceClient;
  private tensors?: Awaited<ReturnType<typeof selectionTensors>>;
  strokes: RemovalStroke[] = [];
  gestureSizes: number[] = [];
  redoGestures: RemovalStroke[][] = [];
  private manualProtection: Uint8Array = new Uint8Array();
  committingXml?: string;
  masks: Uint8Array[] = [];
  revision = 0;
  key = '';
  private exportRevision = 0;
  private scopeFolder?: MapleFolderHandle;

  constructor() {
    effect(() => {
      const active = this.active();
      const asset = active ? this.library.focusedAsset() : null;
      const folder = active ? (this.library.currentFolder() ?? undefined) : undefined;
      const exportRevision = active ? this.pipeline.exportRevision() : 0;
      const phase = this.phase();
      const model = active && asset ? this.library.adjustmentFor(asset.id)() : undefined;
      const xml = asset && model ? this.serialize(asset.id, model) : '';
      untracked(() => {
        const key = active && asset ? this.keyFor(asset, xml) : '';
        const records = this.committingXml ? savedRemovalRecords(this.committingXml) : undefined;
        // As-Shot UI seeds can arrive after decode without changing the
        // serialized RAW recipe. Keep that current model as the save base.
        if (
          this.photo &&
          model &&
          key === this.key &&
          phase !== 'saving' &&
          this.photo.model !== model
        )
          this.photo = { ...this.photo, model };
        if (
          (this.key === key &&
            this.scopeFolder === folder &&
            this.exportRevision === exportRevision) ||
          (phase === 'saving' &&
            this.committingXml !== undefined &&
            this.photo?.asset.id === asset?.id &&
            this.photo?.asset.filename === asset?.filename &&
            this.photo?.folder === folder &&
            // Fresh passthrough XML can change before the confirmed model is
            // adopted. Retain this save only for its before/after models.
            (stableStringify(model) === stableStringify(this.photo?.model) ||
              stableStringify(model) ===
                stableStringify({
                  ...this.photo?.model,
                  inpaintRemovals: records,
                })))
        )
          return;
        if (this.key === key && this.scopeFolder === folder && this.photo) {
          if (phase === 'saving') return;
          this.exportRevision = exportRevision;
          void rebindAfterExport(this, this.photo.readOriginal);
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
    if (this.busy() || this.phase() === 'review' || this.replacingRemoval()) return;
    this.clearSelection();
    this.mode.set(mode);
  }
  clearSelection(): void {
    this.revision++;
    this.inference?.cancel();
    this.strokes = [];
    this.replacementBase = new Uint8Array();
    this.gestureSizes = [];
    this.redoGestures = [];
    this.masks = [];
    this.resetPersonRefinement();
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
  paint(
    points: readonly (readonly [number, number])[],
    cropInputSize: readonly [number, number],
  ): Promise<void> {
    return painting.paint(this, points, cropInputSize);
  }
  undoSelection(): Promise<void> {
    return painting.undoSelection(this);
  }
  redoSelection(): Promise<void> {
    return painting.redoSelection(this);
  }
  refinePerson(index: number | null): void {
    if (this.phase() !== 'ready') return;
    if (index === null || this.personBases().some((base) => base.index === index))
      this.refiningPerson.set(index);
  }
  canRefinePerson(index: number): boolean {
    return this.personBases().some((base) => base.index === index);
  }
  resetPersonRefinement(bases: readonly PersonBase[] = []): void {
    this.personBases.set(bases);
    this.personGestures = [];
    this.redoPersonGestures = [];
    this.refiningPerson.set(null);
    this.canUndoSelection.set(false);
    this.canRedoSelection.set(false);
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
      this.resetPersonRefinement(masks.bases);
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
      this.resetPersonRefinement(masks.bases);
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
        bases: [] as PersonBase[],
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
  editSaved(id: string, active?: boolean): Promise<void> {
    return saved.changeSaved(this, id, active);
  }
  replaceSaved(id: string): void {
    saved.beginReplace(this, id);
  }
  cancelReplacement(): Promise<void> {
    return saved.cancelReplacement(this);
  }

  private async open(asset: Asset, xml: string): Promise<void> {
    const token = this.revision;
    this.phase.set('loading');
    try {
      const ext = asset.filename.split('.').at(-1)?.toLowerCase() ?? '';
      if (isNonRawExtension(ext) || asset.isVideo)
        throw new Error('AI removal requires a RAW photo.');
      await init();
      const storage = await removalEditorStorage(
        this.library,
        this.files,
        this.sidecars,
        this.injector,
        asset,
        xml,
      );
      const { assets } = storage;
      const prior = savedRemovalRecords(xml) ?? '[]';
      const companions = new Map(await assets.read(prior));
      const bytes = await storage.readOriginal();
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
        ...storage,
        model: this.library.adjustmentFor(asset.id)(),
        xml,
        source,
        width: anchor.width,
        height: anchor.height,
        prior,
        companions,
      };
      this.photo = photo;
      this.savedRemovals.set(saved.savedEntries(prior));
      this.inference = new RemovalInferenceClient(
        models,
        (stage) =>
          this.photo?.source === photo.source &&
          this.photo?.asset.id === photo.asset.id &&
          this.active() &&
          this.stage.set(stage),
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

  smartRequest(
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
  async selectionInputs(token: number) {
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
      (this.library.currentFolder() ?? undefined) !== photo.folder ||
      (photo.path !== undefined && this.library.absPathFor(asset.id) !== photo.path)
    )
      throw new Error('The photo moved before this removal could be saved.');
    return asset;
  }
  resetProxy(): void {
    this.tensors = undefined;
  }
  recipe(photo: OpenPhoto, records: string): string {
    return this.serializer.serialize(
      { ...photo.model, inpaintRemovals: records },
      withRemovalRecords(this.sidecars.passthroughFor(photo.asset.id), records),
    );
  }
  async restore(photo: OpenPhoto): Promise<void> {
    if (this.library.focusedAsset()?.id !== photo.asset.id) return;
    await this.pipeline.removal.prepareSaved(
      photo.xml,
      bundleRemovalCompanions(saved.companionsFor(photo.prior, photo.companions)),
    );
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
    this.savedRemovals.set([]);
    this.replacingRemoval.set(null);
    this.replacementBase = new Uint8Array();
    this.scopeFolder = undefined;
    this.draft = undefined;
    this.inference = undefined;
    this.tensors = undefined;
    this.strokes = [];
    this.gestureSizes = [];
    this.redoGestures = [];
    this.masks = [];
    this.resetPersonRefinement();
    this.manualProtection = new Uint8Array();
    this.committingXml = undefined;
    this.selection.set(new Uint8Array());
    this.protection.set(new Uint8Array());
    this.people.set([]);
    this.preview.set(null);
    this.phase.set('closed');
    this.message.set('');
    this.canUndoSelection.set(false);
    this.canRedoSelection.set(false);
  }
}
