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

// A sinon fake created at module scope lands on sinon's default sandbox and
// outlives every test in the file. Any other spec calling `sinon.restore()`
// drops it from that sandbox's collection, after which `sinon.reset()` no
// longer clears it and call history accumulates across tests — a failure that
// surfaces only in serial runs, never under `mocha --parallel` (issue 2932).
const FAKE_FACTORY = '/^(stub|spy|fake|mock|createStubInstance|useFakeTimers)$/';
// Both call shapes the repo uses: `sinon.stub()` and, via
// `import sinon, { stub } from 'sinon'`, a bare `stub()`.
const SINON_FAKE = `CallExpression[callee.object.name='sinon'][callee.property.name=${FAKE_FACTORY}]`;
const BARE_FAKE = `CallExpression[callee.type='Identifier'][callee.name=${FAKE_FACTORY}]`;
// `:not(:function *)` narrows these to fakes evaluated at module load. A fake
// built inside a factory function is created per call and is not the hazard,
// so it must not be flagged. This is a lexical test, not an execution-timing
// one, so it cannot see a fake built by a helper that is itself called at
// module load — build fakes in `beforeEach` and the distinction never arises.
//
// A fake declared directly in a `describe` body shares the hazard — mocha
// evaluates suite callbacks during collection, so it too is created once for
// the whole suite. That form is not covered here: it is long-established style
// in this suite (hundreds of call sites), so enforcing it is a migration of its
// own rather than something this rule can turn on. What is covered is the shape
// that actually broke, and the one a new file is most likely to reach for.
const SINON_SHARED_FAKE = `${SINON_FAKE}:not(:function *), ${BARE_FAKE}:not(:function *)`;
const SINON_SHARED_FAKE_MESSAGE = 'Create sinon fakes per test, inside beforeEach, on a '
  + 'sandbox from sinon.createSandbox() that afterEach restores. A fake created at module '
  + 'scope is shared by every test in the file.';

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
      'import/no-unresolved': ['error', { ignore: ['@octokit/rest', 'exceljs', 'iso-3166'] }],
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
      'no-restricted-syntax': [
        'error',
        'ForInStatement',
        'LabeledStatement',
        'WithStatement',
        {
          selector: SINON_SHARED_FAKE,
          message: SINON_SHARED_FAKE_MESSAGE,
        },
      ],
    },
  },
]);
