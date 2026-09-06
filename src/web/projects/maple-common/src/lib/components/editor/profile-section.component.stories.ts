import { signal } from '@angular/core';
import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { ProfileSectionComponent } from './profile-section.component';
import { EditorStateService } from '../../editor/editor-state.service';
import { LibraryStateService } from '../../state/library-state.service';
import { defaultAdjustmentModel, type AdjustmentModel } from '../../models/adjustment-model';

function state(profile: AdjustmentModel['profile'], focused = true) {
  return moduleMetadata({
    providers: [
      {
        provide: LibraryStateService,
        useFactory: () => {
          const adjustment = signal({ ...defaultAdjustmentModel(), profile });
          return {
            focusedAssetId: signal(focused ? 'story-photo' : null),
            adjustmentFor: () => adjustment,
            updateAdjustment: (_id: string, patch: Partial<AdjustmentModel>) =>
              adjustment.update((current) => ({ ...current, ...patch })),
          };
        },
      },
      { provide: EditorStateService, useValue: { commit: () => {}, endEdit: () => {} } },
    ],
  });
}

const meta: Meta<ProfileSectionComponent> = {
  title: 'Editor/Profile',
  component: ProfileSectionComponent,
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj<ProfileSectionComponent>;

export const Default: Story = { decorators: [state('Auto')] };
export const Neutral: Story = { decorators: [state('Neutral')] };
export const Empty: Story = { decorators: [state('Auto', false)] };
