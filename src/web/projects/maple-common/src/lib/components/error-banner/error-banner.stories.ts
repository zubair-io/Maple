// Storybook coverage for ErrorBanner — exercises the default error, a
// hint-link variant, and a no-retry variant (when retry doesn't make sense
// for the underlying failure).

import type { Meta, StoryObj } from '@storybook/angular';
import { ErrorBannerComponent } from './error-banner.component';

const meta: Meta<ErrorBannerComponent> = {
  title: 'Banners/ErrorBanner',
  component: ErrorBannerComponent,
  tags: ['autodocs'],
  argTypes: {
    message: { control: 'text' },
    retryLabel: { control: 'text' },
    showRetry: { control: 'boolean' },
    hintHref: { control: 'text' },
    hintLabel: { control: 'text' },
  },
};

export default meta;

type Story = StoryObj<ErrorBannerComponent>;

export const Default: Story = {
  args: {
    message: 'Could not reach the Self-Hosted API.',
    retryLabel: 'Retry',
    showRetry: true,
    hintHref: null,
    hintLabel: null,
  },
};

export const WithHintLink: Story = {
  args: {
    message: 'No folders are indexed yet.',
    retryLabel: 'Retry',
    showRetry: true,
    hintHref: '/admin',
    hintLabel: 'Configure folders',
  },
};

export const NoRetry: Story = {
  args: {
    message: 'Sign in required.',
    retryLabel: 'Retry',
    showRetry: false,
    hintHref: null,
    hintLabel: null,
  },
};
