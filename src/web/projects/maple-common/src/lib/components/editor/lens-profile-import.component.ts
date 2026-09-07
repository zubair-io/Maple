import { uploadServerLensProfile } from '../../lens/lens-profile-server-bridge';
import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  computed,
  inject,
  signal,
} from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { MuiButtonComponent } from '../../ui/button/mui-button.component';
import type { ImportedLensProfile } from '../../lens/lens-profile.types';

@Component({
  selector: 'lens-profile-import',
  standalone: true,
  imports: [MuiButtonComponent],
  templateUrl: './lens-profile-import.component.html',
  styleUrl: './lens-profile-import.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LensProfileImportComponent {
  private readonly library = inject(LibraryStateService);
  private readonly editor = inject(EditorStateService);
  private readonly pipeline = inject(RawPipelineService);
  private readonly injector = inject(Injector);
  private generation = 0;
  private readonly candidateAsset = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly candidate = signal<ImportedLensProfile | null>(null);
  readonly selected = computed(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)().lensProfile : '';
  });
  readonly resolved = computed(() => {
    const id = this.library.focusedAssetId();
    const facts = id ? this.library.lensCorrectionsFor(id).lensProfile : undefined;
    return facts?.reference === this.selected() ? facts : undefined;
  });
  readonly visibleCandidate = computed(() =>
    this.candidateAsset() === this.library.focusedAssetId() ? this.candidate() : null,
  );
  readonly details = computed(() => this.visibleCandidate()?.resolution ?? this.resolved());
  readonly canApply = computed(
    () =>
      this.candidateAsset() === this.library.focusedAssetId() &&
      this.candidate()?.resolution.source === 'lcp',
  );

  async choose(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const asset = this.library.focusedAsset();
    if (!file || !asset) return;
    const generation = ++this.generation;
    this.candidate.set(null);
    this.error.set('');
    this.busy.set(true);
    try {
      const profile = await this.readProfile(file, asset.id, asset.filename);
      if (!this.ownsImport(generation, asset.id)) return;
      this.candidateAsset.set(asset.id);
      this.candidate.set(profile);
    } catch (error) {
      if (this.ownsImport(generation, asset.id)) {
        this.error.set(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation === this.generation) this.busy.set(false);
    }
  }

  private ownsImport(generation: number, assetId: string): boolean {
    return generation === this.generation && assetId === this.library.focusedAssetId();
  }

  private async readProfile(
    file: File,
    assetId: string,
    filename: string,
  ): Promise<ImportedLensProfile> {
    if (file.size > 32 * 1024 * 1024) throw new Error('Lens profiles must be smaller than 32 MiB.');
    const xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      await file.arrayBuffer(),
    );
    const bytes = await this.library.bytesForAsset(assetId);
    const ext = filename.split('.').pop() ?? '';
    const profile = await this.pipeline.importLensProfile(xml, bytes, ext);
    if (this.library.backend === 'self-hosted') {
      const serverReference = await uploadServerLensProfile(this.injector, file);
      if (serverReference !== profile.reference)
        throw new Error('Server and browser lens profiles do not match.');
    }
    return profile;
  }

  apply(): void {
    const candidate = this.candidate();
    if (!candidate || !this.canApply()) return;
    const reference = candidate.resolution.approximations.length
      ? candidate.reference.replace('lcp1:', 'lcp1-ack:')
      : candidate.reference;
    this.write(reference, 'Select lens profile');
    this.candidate.set(null);
  }

  clear(): void {
    this.write('', 'Use embedded lens corrections');
    this.candidate.set(null);
  }

  private write(reference: string, description: string): void {
    const id = this.library.focusedAssetId();
    if (!id) return;
    this.editor.commit('adjustment', description);
    this.library.updateAdjustment(id, { lensProfile: reference });
    this.editor.endEdit();
  }
}
