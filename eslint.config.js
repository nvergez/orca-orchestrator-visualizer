import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'prototype'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // `bin/` is plain .mjs on purpose: it is the one file a Node too old to run orca-viz
    // must still be able to load, so it is never compiled and never imports node:sqlite.
    files: ['src/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}', 'bin/**/*.mjs', '*.{ts,js}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
    },
  },
  {
    files: ['src/client/**/*.tsx', 'test/client/**/*.tsx'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: {
      globals: globals.browser,
    },
  }
);
