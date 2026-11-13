import { TestBed } from '@angular/core/testing';
import { Injector } from '@angular/core';
import { afterEach, expect, it } from 'vitest';
import { LibraryStore } from '../state/library-store.service';
import type { LibraryStateService } from '../state/library-state.service';
import { LibraryWorkflowVariants } from '../state/library-workflow-variants';
import { ServerRemovalSidecars } from './server-removal-sidecars';

afterEach(() => TestBed.resetTestingModule());

it('refuses a server variant before requesting the primary removal sidecar', async () => {
  const variants = new LibraryWorkflowVariants(() => ['photo']);
  variants.bind('photo', '/photos/photo.dng', crypto.randomUUID());
  TestBed.configureTestingModule({
    providers: [{ provide: LibraryStore, useValue: { workflowVariants: variants } }],
  });
  const library = {
    settleSidecarWrites: async () => undefined,
    absPathFor: () => '/photos/photo.dng',
  } as unknown as LibraryStateService;
  const sidecars = new ServerRemovalSidecars(library, TestBed.inject(Injector));
  await expect(sidecars.capture('photo')).rejects.toThrow(
    'Object removal in server variants is not available yet.',
  );
});
