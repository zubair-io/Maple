import { Meta, moduleMetadata, StoryObj } from '@storybook/angular';
import { of } from 'rxjs';
import { ConnectionService } from '../connection.service';
import { captureConnectionFragment } from '../connection-fragment';
import { GoogleDriveReturnComponent } from './google-drive-return.component';

const meta: Meta<GoogleDriveReturnComponent> = {
  title: 'Pages/Hosted/Return From Google Drive',
  component: GoogleDriveReturnComponent,
  decorators: [
    moduleMetadata({
      providers: [{ provide: ConnectionService, useValue: { validate: () => of(null) } }],
    }),
  ],
  beforeEach: () =>
    captureConnectionFragment(
      { pathname: '/connect/google-drive/return', hash: '', search: '' },
      { replaceState: () => {} },
    ),
};
export default meta;
type Story = StoryObj<GoogleDriveReturnComponent>;
export const MissingConnection: Story = {};
