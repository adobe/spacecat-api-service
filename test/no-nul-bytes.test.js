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

import { expect } from 'chai';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Regular files. Excludes symlinks (120000) and, were one ever added, a submodule
// gitlink (160000) — neither has file content to scan, and three of the tracked
// symlinks point at directories, which would raise EISDIR on read.
const REGULAR_BLOB_MODES = new Set(['100644', '100755']);

// Extensions whose contents are legitimately binary. A denylist rather than a
// text allowlist on purpose: an unlisted binary type fails loudly and gets added
// here, whereas an unlisted *text* type would be silently unguarded — which is
// the failure mode this test exists to prevent. Nothing tracked today matches.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif', '.pdf',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.br', '.xlsx',
]);

/**
 * A raw U+0000 in tracked source makes whole-file scanners classify the file as
 * binary and skip it, so `grep -r`, recursive `rg` and `file` stop seeing it.
 * The skip is silent: a search still returns hits from other files, so a result
 * set that is missing a definition reads as complete (issue 3067).
 *
 * Git does not surface this. It sniffs only the first 8000 bytes for a NUL, so a
 * byte past that window leaves `git grep` and `git diff` behaving normally and
 * nothing in review or CI reacts. This test is that missing signal.
 */
describe('tracked source contains no raw NUL byte', () => {
  it('finds no U+0000 in any tracked text file', () => {
    // `--stage` so each entry carries its mode and the scan can keep to regular blobs.
    const scannable = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: repoRoot })
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry) => /^(\d+) [0-9a-f]+ \d+\t(.*)$/s.exec(entry))
      .filter((match) => match && REGULAR_BLOB_MODES.has(match[1]))
      .map((match) => match[2])
      .filter((relative) => !BINARY_EXTENSIONS.has(path.extname(relative).toLowerCase()));

    // Guards the guard: an empty list would make this test vacuously pass.
    expect(scannable.length).to.be.greaterThan(0, 'git ls-files returned no scannable files');

    const offenders = [];
    for (const relative of scannable) {
      const buffer = fs.readFileSync(path.join(repoRoot, relative));
      const offset = buffer.indexOf(0);
      if (offset !== -1) {
        const line = buffer.subarray(0, offset).toString('utf8').split('\n').length;
        offenders.push(`${relative}:${line} (byte offset ${offset})`);
      }
    }

    expect(offenders, `Write the \\0 escape instead of a literal NUL byte:\n  ${offenders.join('\n  ')}`)
      .to.deep.equal([]);
  });
});
