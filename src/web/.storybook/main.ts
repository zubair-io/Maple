// Storybook configuration for the Maple Angular workspace.
//
// Storybook is wired against the `maple` project via the
// `architect.storybook.options.styles` entry in `angular.json`, which
// points at `projects/maple/src/styles.scss` so Tailwind and the global
// `tokens.scss` are picked up automatically. Stories live next to their
// components under `projects/**/*.stories.ts` so any project (maple,
// maple-common, maple-syrup) can contribute without further config
// changes.

import type { StorybookConfig } from '@storybook/angular';

const config: StorybookConfig = {
  stories: ['../projects/**/*.mdx', '../projects/**/*.stories.@(ts|mdx)'],
  addons: ['@storybook/addon-a11y', '@storybook/addon-docs'],
  framework: {
    name: '@storybook/angular',
    options: {},
  },
  docs: {},
};

export default config;
