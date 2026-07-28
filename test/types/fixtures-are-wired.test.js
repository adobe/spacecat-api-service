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

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect } from 'chai';

/**
 * The type fixtures in `test/types/**` are enforced by being COMPILED — they carry
 * `@ts-expect-error` directives that fail the build if the errors they pin stop
 * happening. That makes them silently deletable: drop the fixture's directory from a
 * tsconfig `include`, or delete the file, and `npm run type-check` still exits 0
 * because nothing is left to complain. The guards pin the types; this pins the guards.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** tsconfigs carry `//` comments, which `JSON.parse` rejects. */
function readTsconfig(name) {
  const raw = readFileSync(path.join(repoRoot, name), 'utf-8');
  const stripped = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return JSON.parse(stripped);
}

describe('type fixtures stay wired into the type-check tiers', () => {
  const cases = [
    ['tsconfig.json', 'test/types/base/**/*.js', 'test/types/base/serenity-transport.types.js'],
    ['tsconfig.strict.json', 'test/types/strict/**/*.js', 'test/types/strict/serenity-transport-strict.types.js'],
  ];

  cases.forEach(([config, includeGlob, fixture]) => {
    it(`${config} includes ${includeGlob}`, () => {
      expect(readTsconfig(config).include).to.include(includeGlob);
    });

    it(`${fixture} exists and asserts something`, () => {
      const full = path.join(repoRoot, fixture);
      expect(existsSync(full), `${fixture} is missing`).to.equal(true);
      // A fixture with no directives compiles clean and guards nothing.
      expect(readFileSync(full, 'utf-8')).to.include('@ts-expect-error');
    });
  });
});
