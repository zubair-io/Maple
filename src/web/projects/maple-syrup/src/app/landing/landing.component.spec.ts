import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { FolderAccessService, LibraryStateService, MapleFolderHandle } from '@maple-common';
import { LandingComponent } from './landing.component';

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
    addImportedAsset: vi.fn(),
    selectedSourceId: { set: vi.fn() },
    selectAsset: vi.fn(),
    openFolder: vi.fn<() => Promise<void>>(),
  };
  const router = {
    navigate: vi.fn<() => Promise<boolean>>(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    folderAccess.openFolder.mockResolvedValue(null);
    folderAccess.openDroppedFolder.mockResolvedValue(null);
    libraryState.openFolder.mockResolvedValue();
    router.navigate.mockResolvedValue(true);

    await TestBed.configureTestingModule({
      imports: [LandingComponent],
      providers: [
        { provide: FolderAccessService, useValue: folderAccess },
        { provide: LibraryStateService, useValue: libraryState },
        { provide: Router, useValue: router },
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
    expect(libraryState.addImportedAsset).not.toHaveBeenCalled();
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
