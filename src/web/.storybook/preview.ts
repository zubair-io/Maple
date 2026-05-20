// Global Storybook preview configuration.
//
// Defaults a dark background to match Maple's editor chrome (the tokens.scss
// `--color-bg` resolves to the dark surface used throughout the app) and
// enables addon-a11y on every story.

import type { Preview } from '@storybook/angular';

const preview: Preview = {
  parameters: {
    backgrounds: {
      default: 'maple-dark',
      values: [
        { name: 'maple-dark', value: '#161616' },
        { name: 'light', value: '#ffffff' },
      ],
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      // Fail CI on serious/critical accessibility violations once stories
      // have been audited. For now we only report so the suite is green
      // while components are still being annotated.
      test: 'todo',
    },
  },
};

export default preview;
