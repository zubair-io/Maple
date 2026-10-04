import { Meta, moduleMetadata, StoryObj } from '@storybook/angular';
import { of, throwError } from 'rxjs';
import { ConnectionService } from '../connection.service';
import { captureConnectionFragment } from '../connection-fragment';
import { GoogleDriveComponent } from './google-drive.component';

const meta: Meta<GoogleDriveComponent> = {
  title: 'Pages/Hosted/Connect Google Drive',
  component: GoogleDriveComponent,
  decorators: [
    moduleMetadata({
      providers: [{ provide: ConnectionService, useValue: { validate: () => of(null) } }],
    }),
  ],
  beforeEach: () =>
    captureConnectionFragment(
      { pathname: '/connect/google-drive', hash: '', search: '' },
      { replaceState: () => {} },
    ),
};
export default meta;
type Story = StoryObj<GoogleDriveComponent>;
export const SetupInstructions: Story = {};
export const ExpiredConnection: Story = {
  decorators: [
    moduleMetadata({
      providers: [
        {
          provide: ConnectionService,
          useValue: { validate: () => throwError(() => new Error('Expired story connection')) },
        },
      ],
    }),
  ],
  beforeEach: () =>
    captureConnectionFragment(
      {
        pathname: '/connect/google-drive',
        hash:
          '#' +
          btoa(
            JSON.stringify({
              ticket: 'signed.ticket',
              authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            }),
          ).replace(/=/g, ''),
        search: '',
      },
      { replaceState: () => {} },
    ),
};
