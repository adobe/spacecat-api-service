/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';

import { expect } from 'chai';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, '..', '..');
const COMMITTED_TYPES = resolvePath(REPO_ROOT, 'src', 'support', 'semrush', 'generated', 'api.d.ts');
const OPENAPI_ENTRY = resolvePath(REPO_ROOT, 'docs', 'openapi', 'api.yaml');

/**
 * Guards against drift between `docs/openapi/api.yaml` and the committed
 * `src/support/semrush/generated/api.d.ts`. CI re-runs `openapi-typescript`
 * into a tempdir and diffs against the committed file — if anyone forgets
 * to run `npm run gen:types:semrush` after changing the spec, this test
 * fails loudly.
 */
describe('OpenAPI types — generated `.d.ts` is up-to-date', function whenInSync() {
  // Generating the file shells out to openapi-typescript, parses + writes
  // the bundle, so the budget is generous.
  this.timeout(60_000);

  let tempDir;
  let tempOutput;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spacecat-types-'));
    tempOutput = join(tempDir, 'api.d.ts');
    const result = spawnSync(
      'npx',
      [
        'openapi-typescript',
        OPENAPI_ENTRY,
        '-o', tempOutput,
        '--root-types',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(
        `openapi-typescript failed (exit ${result.status}):\n${result.stderr || result.stdout}`,
      );
    }
  });

  after(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('regenerated output matches the committed file byte-for-byte', () => {
    const committed = readFileSync(COMMITTED_TYPES, 'utf8');
    const regenerated = readFileSync(tempOutput, 'utf8');
    if (committed !== regenerated) {
      // Produce a useful first-divergence message rather than dumping 30k lines.
      const committedLines = committed.split('\n');
      const regenLines = regenerated.split('\n');
      const max = Math.max(committedLines.length, regenLines.length);
      for (let i = 0; i < max; i += 1) {
        if (committedLines[i] !== regenLines[i]) {
          const expected = committedLines[i] ?? '<EOF>';
          const actual = regenLines[i] ?? '<EOF>';
          throw new Error([
            `Generated types drift from docs/openapi/api.yaml at line ${i + 1}.`,
            '  Re-run: npm run gen:types:semrush',
            `  Committed: ${expected}`,
            `  Regenerated: ${actual}`,
          ].join('\n'));
        }
      }
    }
    expect(committed).to.equal(regenerated);
  });
});
