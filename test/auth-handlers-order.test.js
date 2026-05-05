/*
 * Copyright 2025 Adobe. All rights reserved.
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
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const testDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Executable contract for the authHandlers order in src/index.js.
 *
 * We parse the source file rather than importing it because src/index.js has
 * heavy boot-time side effects (wires the full controller + middleware chain).
 * This test verifies the literal ordering of entries in the AUTH_HANDLERS
 * array so the contract documented in src/index.js cannot silently regress.
 */
describe('src/index.js authHandlers order contract', () => {
  let source;

  before(() => {
    source = fs.readFileSync(path.join(testDir, '..', 'src', 'index.js'), 'utf8');
  });

  it('places GitHubWebhookHmacHandler before path-agnostic handlers', () => {
    // Extract the AUTH_HANDLERS array literal
    const match = source.match(/const AUTH_HANDLERS\s*=\s*\[([^\]]+)\]/);
    expect(match, 'AUTH_HANDLERS array not found in src/index.js').to.not.be.null;

    const order = match[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const ghIdx = order.indexOf('GitHubWebhookHmacHandler');
    expect(ghIdx).to.be.greaterThan(-1, 'GitHubWebhookHmacHandler must be in AUTH_HANDLERS');

    // Path-agnostic handlers must come after the path-scoped HMAC handler so
    // webhook requests do not reach them and fail with a misleading 401.
    ['JwtHandler', 'AdobeImsHandler', 'ScopedApiKeyHandler', 'LegacyApiKeyHandler'].forEach((name) => {
      const idx = order.indexOf(name);
      expect(idx).to.be.greaterThan(-1, `${name} must be in AUTH_HANDLERS`);
      expect(ghIdx).to.be.lessThan(idx, `GitHubWebhookHmacHandler must come before ${name}`);
    });
  });
});
