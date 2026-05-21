// Storybook coverage for LoadingBanner — covers the default label and a
// custom progress message so the loading copy is reviewable in isolation.

import type { Meta, StoryObj } from '@storybook/angular';
import { LoadingBannerComponent } from './loading-banner.component';

const meta: Meta<LoadingBannerComponent> = {
  title: 'Banners/LoadingBanner',
  component: LoadingBannerComponent,
  tags: ['autodocs'],
  argTypes: {
    label: { control: 'text' },
  },
};

export default meta;

type Story = StoryObj<LoadingBannerComponent>;

export const Default: Story = {
  args: { label: 'Loading…' },
};

export const CustomLabel: Story = {
  args: { label: 'Indexing folders…' },
};
