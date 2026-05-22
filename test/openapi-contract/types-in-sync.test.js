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
import {
  mkdtempSync, readFileSync, rmSync, statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';

import { expect } from 'chai';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(HERE, '..', '..');
const OPENAPI_ENTRY = resolvePath(REPO_ROOT, 'docs', 'openapi', 'api.yaml');

/**
 * The OpenAPI -> TypeScript codegen lives in `npm run gen:types:semrush` and
 * writes to `src/support/semrush/generated/api.d.ts`. That output is not
 * committed (see .gitignore — no runtime code imports it; dev/CI regenerates
 * on demand), so this test verifies the spec is valid input for the codegen
 * rather than diffing against a frozen committed artifact.
 */
describe('OpenAPI types — codegen runs cleanly against the spec', function whenInSync() {
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

  it('produces a non-empty .d.ts that defines the operations object', () => {
    const { size } = statSync(tempOutput);
    expect(size).to.be.greaterThan(1000);

    const content = readFileSync(tempOutput, 'utf8');
    // Sanity: the codegen lays down a top-level `operations` interface — if
    // that is missing the spec didn't surface any operationIds.
    expect(content).to.match(/export interface operations/);
  });
});
