// Storybook coverage for MapleCollapsible — exercises the open / collapsed
// states plus the optional right-aligned label.

import type { Meta, StoryObj } from '@storybook/angular';
import { MapleCollapsibleComponent } from './maple-collapsible.component';

const meta: Meta<MapleCollapsibleComponent> = {
  title: 'Primitives/MapleCollapsible',
  component: MapleCollapsibleComponent,
  tags: ['autodocs'],
  argTypes: {
    label: { control: 'text' },
    defaultOpen: { control: 'boolean' },
    padInner: { control: 'boolean' },
    rightLabel: { control: 'text' },
  },
  render: (args) => ({
    props: args,
    template: `
      <maple-collapsible
        [label]="label"
        [defaultOpen]="defaultOpen"
        [padInner]="padInner"
        [rightLabel]="rightLabel"
      >
        <p style="color: var(--color-text-main); font-size: 12px;">
          Inspector content goes here. Sliders, toggles, and labels render in
          this slot.
        </p>
      </maple-collapsible>
    `,
  }),
};

export default meta;

type Story = StoryObj<MapleCollapsibleComponent>;

export const Default: Story = {
  args: {
    label: 'Tone',
    defaultOpen: true,
    padInner: true,
    rightLabel: null,
  },
};

export const Collapsed: Story = {
  args: {
    label: 'Color',
    defaultOpen: false,
    padInner: true,
    rightLabel: null,
  },
};

export const WithRightLabel: Story = {
  args: {
    label: 'Detail',
    defaultOpen: true,
    padInner: true,
    rightLabel: 'Auto',
  },
};
