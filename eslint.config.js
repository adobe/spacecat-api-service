/*
 * Copyright 2021 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { defineConfig, globalIgnores } from '@eslint/config-helpers'
import {recommended, source, test} from '@adobe/eslint-config-helix';

export default defineConfig([
  globalIgnores([
    '.vscode/*',
    '.idea/*',
    'coverage/*',
    'dist/*',
    'node_modules/*',
    'test/*/fixtures/*',
    'third-party/*'
  ]),
  {
    extends: [ recommended ],
    plugins: {
      import: recommended.plugins.import,
    },
    rules: {
      'no-unused-expressions': 'off',
      'import/no-unresolved': ['error', { ignore: ['@octokit/rest'] }],
    },
  },
  {
    ...source,
    files: [...source.files],
  },
  {
    ...test,
    files: [...test.files],
    rules: {
      'no-console': 'off',
      'func-names': 'off',
    },
  },
  // Semrush AI Visibility proxy: wire-format snake_case, dense protobuf mapping, vendor-style loops.
  {
    files: [
      'src/support/ai-visibility/**/*.js',
      'src/controllers/ai-visibility.js',
      'test/support/ai-visibility/**/*.js',
      'test/controllers/ai-visibility.test.js',
    ],
    rules: {
      camelcase: 'off',
      'max-len': 'off',
      'max-statements-per-line': 'off',
      'no-await-in-loop': 'off',
      'no-continue': 'off',
      'no-nested-ternary': 'off',
      'no-plusplus': 'off',
      'no-return-await': 'off',
      'no-underscore-dangle': 'off',
      'no-use-before-define': 'off',
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'object-curly-newline': 'off',
      'prefer-promise-reject-errors': 'off',
    },
  },
]);
