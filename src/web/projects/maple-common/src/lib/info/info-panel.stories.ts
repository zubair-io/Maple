// Storybook coverage for InfoPanel — both slots (inspector pane +
// phone bottom sheet) against a stub asset with full EXIF / GPS /
// keywords, plus the null-asset state for the layout placeholder.

import type { Meta, StoryObj } from '@storybook/angular';
import { moduleMetadata } from '@storybook/angular';
import { InfoPanelComponent } from './info-panel.component';
import { LibraryStateService } from '../state/library-state.service';
import { signal } from '@angular/core';
import type { Asset } from '../models/asset';

const STUB_ASSET: Asset = {
  id: 'asset-storybook-1',
  filename: 'IMG_0042.dng',
  folderId: 'folder-1',
  rating: 4,
  flag: 'pick',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
  camera: 'Hasselblad L3D-100c',
  lens: '24-70mm f/2.8',
  aperture: 'f/8.0',
  shutter: '1/250',
  iso: 200,
  focalLength: '35mm',
  capturedAt: '2026-04-01',
  keywords: ['travel', 'paris', '2026', 'golden hour'],
  gps: { lat: 48.8584, lon: 2.2945 },
  city: 'Paris',
};

class FakeLibraryStateService {
  // Mutable signal so the user can poke flags + stars in Storybook and
  // see the chip / star fill state respond.
  private _flag = signal<'pick' | 'unflagged' | 'reject'>('pick');
  private _rating = signal(4);

  setFlag = (_id: string, flag: 'pick' | 'unflagged' | 'reject') => this._flag.set(flag);
  setRating = (_id: string, rating: number) => this._rating.set(rating);
  focusedAssetId = signal<string | undefined>('asset-storybook-1');
}

const meta: Meta<InfoPanelComponent> = {
  title: 'Info/InfoPanel',
  component: InfoPanelComponent,
  decorators: [
    moduleMetadata({
      providers: [{ provide: LibraryStateService, useValue: new FakeLibraryStateService() }],
    }),
  ],
  tags: ['autodocs'],
};

export default meta;

type Story = StoryObj<InfoPanelComponent>;

export const InspectorPane: Story = {
  args: {
    asset: STUB_ASSET,
    insideSheet: false,
  },
};

export const PhoneSheet: Story = {
  args: {
    asset: STUB_ASSET,
    insideSheet: true,
  },
};

export const InspectorPaneEmpty: Story = {
  args: {
    asset: null,
    insideSheet: false,
  },
};
