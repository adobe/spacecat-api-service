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

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { expect } from 'chai';

import routeRequiredCapabilities from '../../src/routes/required-capabilities.js';
import * as Capabilities from '../../src/routes/capability-constants.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(testDir, '..', '..');

const READ_ALL_CONSTANTS = Object.entries(Capabilities)
  .filter(([key]) => key.startsWith('CAP_'))
  .map(([, value]) => value);

/**
 * Drift assertions for the readAll capability surface.
 *
 * The capability strings in `routes/required-capabilities.js` (Layer 1) and the
 * `hasS2SCapability(...)` calls inside controllers (Layer 2) must reference identical
 * strings — they're imported from `routes/capability-constants.js`. These tests fail
 * loudly if a capability appears in only one place.
 *
 * See `docs/s2s/READALL_CAPABILITY_DESIGN.md`.
 */
describe('capability-constants drift coverage', () => {
  it('exports at least one readAll constant', () => {
    expect(READ_ALL_CONSTANTS.length).to.be.greaterThan(0);
    READ_ALL_CONSTANTS.forEach((cap) => {
      expect(cap).to.match(/^[a-zA-Z]+:readAll$/, `Capability "${cap}" must be in entity:readAll form`);
    });
  });

  it('every readAll constant is used by at least one route in routeRequiredCapabilities', () => {
    const usedCaps = new Set(Object.values(routeRequiredCapabilities));
    READ_ALL_CONSTANTS.forEach((cap) => {
      expect(usedCaps.has(cap)).to.equal(
        true,
        `Constant "${cap}" is exported but no route in required-capabilities.js requires it. Either map a route to it or remove the constant.`,
      );
    });
  });

  it('every readAll capability used in routeRequiredCapabilities is exported as a constant', () => {
    const routeReadAllCaps = Object.values(routeRequiredCapabilities)
      .filter((cap) => cap.endsWith(':readAll'));
    routeReadAllCaps.forEach((cap) => {
      expect(READ_ALL_CONSTANTS).to.include(
        cap,
        `Route requires "${cap}" but no constant in capability-constants.js exports it. Add an export so controllers reference the same string.`,
      );
    });
  });

  it('every readAll constant is referenced by at least one controller (Layer 2 opt-in)', () => {
    // Read controller source files and grep for the constant names. This catches the
    // failure mode where a constant is exported and mapped at Layer 1 but no controller
    // ever actually checks for it — which would silently make the route admin-only.
    const controllerFiles = [
      join(projectRoot, 'src/controllers/sites.js'),
      join(projectRoot, 'src/controllers/organizations.js'),
    ];
    const controllerSource = controllerFiles
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');

    Object.entries(Capabilities).forEach(([name, value]) => {
      if (!name.startsWith('CAP_')) {
        return;
      }
      const usedAsImport = controllerSource.includes(name);
      const usedAsLiteral = controllerSource.includes(`'${value}'`);
      expect(usedAsImport || usedAsLiteral).to.equal(
        true,
        `Constant ${name} ("${value}") is exported and mapped at Layer 1 but no controller (sites.js / organizations.js) imports it for Layer 2 hasS2SCapability check. Without the Layer 2 check the endpoint stays admin-only — this is a silent denial of intended access.`,
      );
    });
  });
});
