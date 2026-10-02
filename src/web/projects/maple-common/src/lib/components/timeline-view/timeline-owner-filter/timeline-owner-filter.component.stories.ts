import { computed, signal } from '@angular/core';
import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { NEVER, of, throwError } from 'rxjs';
import { TimelineOwnerFilterComponent } from './timeline-owner-filter.component';
import { TimelineStateService } from '../../../state/timeline-state.service';
import { AuthService } from '../../../auth/auth.service';
import { SearchService } from '../../../api/search.service';

function state(mode: 'default' | 'loading' | 'empty' | 'error') {
  return moduleMetadata({
    providers: [
      { provide: AuthService, useValue: { user: signal({ id: 'me' }) } },
      {
        provide: TimelineStateService,
        useFactory: () => {
          const ownerId = signal('');
          return {
            ownerId,
            params: computed(() => ({ hasCapturedAt: true, ownerId: ownerId() })),
            setOwnerId: (id: string) => ownerId.set(id),
          };
        },
      },
      {
        provide: SearchService,
        useValue: {
          facets: () =>
            mode === 'loading'
              ? NEVER
              : mode === 'error'
                ? throwError(() => new globalThis.Error('Offline'))
                : of({
                    owners:
                      mode === 'empty'
                        ? []
                        : [
                            { id: 'me', email: 'me@example.com', count: 4 },
                            { id: 'member', email: 'studio@example.com', count: 8 },
                          ],
                  }),
        },
      },
    ],
  });
}

const meta: Meta<TimelineOwnerFilterComponent> = {
  title: 'Browse/Timeline owner',
  component: TimelineOwnerFilterComponent,
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj<TimelineOwnerFilterComponent>;
export const Default: Story = { decorators: [state('default')] };
export const Loading: Story = { decorators: [state('loading')] };
export const Empty: Story = { decorators: [state('empty')] };
export const Error: Story = { decorators: [state('error')] };
