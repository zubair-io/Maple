// Storybook coverage for MapleButton — exercises each visual variant + the
// disabled/active states. Stories here intentionally avoid wiring services
// or signals from the app shell: the button is a leaf primitive.

import type { Meta, StoryObj } from '@storybook/angular';
import { MapleButtonComponent } from './maple-button.component';

const meta: Meta<MapleButtonComponent> = {
  title: 'Primitives/MapleButton',
  component: MapleButtonComponent,
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: ['primary', 'secondary', 'ghost', 'pill', 'small'],
    },
    size: {
      control: { type: 'select' },
      options: ['sm', 'md', 'lg'],
    },
    active: { control: 'boolean' },
    disabled: { control: 'boolean' },
  },
  render: (args) => ({
    props: args,
    template: `<maple-button [variant]="variant" [size]="size" [active]="active" [disabled]="disabled">Render</maple-button>`,
  }),
};

export default meta;

type Story = StoryObj<MapleButtonComponent>;

export const Primary: Story = {
  args: {
    variant: 'primary',
    size: 'md',
    active: false,
    disabled: false,
  },
};

export const Secondary: Story = {
  args: {
    variant: 'secondary',
    size: 'md',
    active: false,
    disabled: false,
  },
};

export const Ghost: Story = {
  args: {
    variant: 'ghost',
    size: 'md',
    active: false,
    disabled: false,
  },
};

export const PillActive: Story = {
  args: {
    variant: 'pill',
    size: 'md',
    active: true,
    disabled: false,
  },
};

export const Disabled: Story = {
  args: {
    variant: 'primary',
    size: 'md',
    active: false,
    disabled: true,
  },
};
