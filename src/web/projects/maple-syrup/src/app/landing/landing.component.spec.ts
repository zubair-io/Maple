import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { FolderAccessService, LibraryStateService, MapleFolderHandle } from '@maple-common';
import { LandingComponent, SINGLE_FILE_PERSISTENCE } from './landing.component';

describe('LandingComponent', () => {
  let fixture: ComponentFixture<LandingComponent>;
  let component: LandingComponent;

  const folder: MapleFolderHandle = {
    name: 'raws',
    read: true,
    write: true,
  };
  const folderAccess = {
    hasFsAccess: true,
    openFolder: vi.fn<() => Promise<MapleFolderHandle | null>>(),
    openDroppedFolder: vi.fn<() => Promise<MapleFolderHandle | null>>(),
  };
  const libraryState = {
    enterSingleFileWorkspace: vi.fn(),
    openFolder: vi.fn<() => Promise<void>>(),
  };
  const router = {
    navigate: vi.fn<() => Promise<boolean>>(),
  };
  const persistSingleFile = vi.fn<(id: string, file: File, xmp?: string) => Promise<void>>();

  beforeEach(async () => {
    vi.clearAllMocks();
    folderAccess.openFolder.mockResolvedValue(null);
    folderAccess.openDroppedFolder.mockResolvedValue(null);
    libraryState.openFolder.mockResolvedValue();
    router.navigate.mockResolvedValue(true);
    persistSingleFile.mockResolvedValue();

    await TestBed.configureTestingModule({
      imports: [LandingComponent],
      providers: [
        { provide: FolderAccessService, useValue: folderAccess },
        { provide: LibraryStateService, useValue: libraryState },
        { provide: Router, useValue: router },
        { provide: SINGLE_FILE_PERSISTENCE, useValue: persistSingleFile },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(LandingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('shows a specific error for an unsupported picked file', async () => {
    const input = {
      files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })],
      value: 'notes.txt',
    };

    await component.onFilePicked({ target: input } as unknown as Event);
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('notes.txt');
    expect(alert.textContent).toContain('not a supported RAW or image file');
    expect(libraryState.enterSingleFileWorkspace).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('persists a picked file before entering the single-file workspace', async () => {
    const file = new File(['raw'], 'photo.DNG', { type: 'image/x-adobe-dng' });
    const input = { files: [file], value: 'photo.DNG' };

    await component.onFilePicked({ target: input } as unknown as Event);

    expect(persistSingleFile).toHaveBeenCalledOnce();
    const assetId = persistSingleFile.mock.calls[0][0];
    expect(libraryState.enterSingleFileWorkspace).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'photo.DNG',
      assetId,
      false,
      undefined,
    );
    expect(router.navigate).toHaveBeenCalledWith(['/edit', assetId]);
  });

  it('opens memory-only and carries a persistent warning when browser persistence fails', async () => {
    persistSingleFile.mockRejectedValue(new Error('quota exceeded'));
    const file = new File(['raw'], 'photo.DNG', { type: 'image/x-adobe-dng' });
    const input = { files: [file], value: 'photo.DNG' };

    await component.onFilePicked({ target: input } as unknown as Event);
    const assetId = persistSingleFile.mock.calls[0][0];
    expect(libraryState.enterSingleFileWorkspace).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'photo.DNG',
      assetId,
      true,
      undefined,
    );
    expect(router.navigate).toHaveBeenCalledWith(['/edit', assetId]);
  });

  it('imports a matching XMP with the photo and persists both across reload', async () => {
    const photo = new File(['raw'], 'photo.DNG', { type: 'image/x-adobe-dng' });
    const xmpText =
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description /></rdf:RDF>';
    const xmp = new File([xmpText], 'photo.xmp', { type: 'application/rdf+xml' });
    const input = { files: [photo, xmp], value: 'photo.DNG' };

    await component.onFilePicked({ target: input } as unknown as Event);

    const assetId = persistSingleFile.mock.calls[0][0];
    expect(persistSingleFile).toHaveBeenCalledWith(assetId, photo, xmpText);
    expect(libraryState.enterSingleFileWorkspace).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'photo.DNG',
      assetId,
      false,
      xmpText,
    );
  });

  it('rejects an XMP that does not match the selected photo', async () => {
    const photo = new File(['raw'], 'photo.DNG', { type: 'image/x-adobe-dng' });
    const xmp = new File(['xmp'], 'other.xmp', { type: 'application/rdf+xml' });
    const input = { files: [photo, xmp], value: 'photo.DNG' };

    await component.onFilePicked({ target: input } as unknown as Event);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'does not match',
    );
    expect(persistSingleFile).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('rejects malformed paired XMP before changing or persisting the session', async () => {
    const photo = new File(['raw'], 'photo.DNG', { type: 'image/x-adobe-dng' });
    const xmp = new File(['<not-xmp/>'], 'photo.xmp', { type: 'application/rdf+xml' });
    const input = { files: [photo, xmp], value: 'photo.DNG' };

    await component.onFilePicked({ target: input } as unknown as Event);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'not a valid sidecar',
    );
    expect(persistSingleFile).not.toHaveBeenCalled();
    expect(libraryState.enterSingleFileWorkspace).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('opens a dropped writable folder through the shared folder path', async () => {
    folderAccess.openDroppedFolder.mockResolvedValue(folder);
    const preventDefault = vi.fn();
    const dataTransfer = { files: { item: () => null } } as unknown as DataTransfer;

    await component.onDrop({ preventDefault, dataTransfer } as unknown as DragEvent);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(folderAccess.openDroppedFolder).toHaveBeenCalledWith(dataTransfer);
    expect(libraryState.openFolder).toHaveBeenCalledWith(folder);
    expect(router.navigate).toHaveBeenCalledWith(['/browse']);
  });

  it('announces an empty or unsupported drop instead of ignoring it', async () => {
    const dataTransfer = { files: { item: () => null } } as unknown as DataTransfer;

    await component.onDrop({ preventDefault: vi.fn(), dataTransfer } as unknown as DragEvent);
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('Drop a supported RAW, image, or folder');
  });
});
