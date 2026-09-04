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
import { readdirSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, relative } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../..');
const SRC_DIR = join(REPO_ROOT, 'src');

// A site's org is mutated either directly (`site.setOrganizationId(...)`) or via a helper
// that does (`reassignSiteOrganization(...)`, `reparentSiteProject(...)`). Match all three
// so no reassignment path escapes the backstop.
const ORG_MUTATION_RE = /\.setOrganizationId\(|reassignSiteOrganization\(|reparentSiteProject\(/;

/**
 * LLMO-7284 mechanical backstop.
 *
 * AC12's org-reassignment enrollment guard (assertSiteOrgReassignmentSafe) cannot live
 * at the mutation itself: the actual re-parent, `site.setOrganizationId()`, is in the
 * external spacecat-shared package. So the guard is opt-in per call site, and a NEW
 * reassignment path added later would silently orphan enrollments unless the author
 * remembers to wire the guard. A hand-maintained prose inventory of call sites goes
 * stale; this test makes the inventory mechanical.
 *
 * Every file that calls `site.setOrganizationId(...)` must appear below with an explicit
 * note on why it is safe. Adding a NEW such file (or removing an existing one) fails this
 * test, forcing a deliberate decision: wire assertSiteOrgReassignmentSafe (preferred), or
 * document why the path is exempt and add it here.
 */
const ALLOWLISTED_ORG_MUTATION_FILES = new Map([
  // Guarded: routes through assertSiteOrgReassignmentSafe before the mutation.
  ['src/support/slack/actions/approve-org.js', 'guarded by assertSiteOrgReassignmentSafe'],
  ['src/support/slack/actions/set-ims-org-modal.js', 'guarded by assertSiteOrgReassignmentSafe'],
  ['src/support/slack/actions/onboard-llmo-modal.js', 'guarded by assertSiteOrgReassignmentSafe'],
  ['src/controllers/llmo/llmo-onboarding.js', 'guarded by assertSiteOrgReassignmentSafe'],
  // Self-gating: inline enrollment guard or revoke/gate-first before the move.
  ['src/support/slack/actions/move-plg-site.js', 'revokes/gates enrollments before moving'],
  ['src/controllers/plg/plg-onboarding/bypass-handlers.js', 'inline enrollment gate (not fail-closed on null read; tracked follow-up)'],
  ['src/controllers/plg/plg-onboarding/onboarding-flow.js', 'reassigns only from internal/demo orgs'],
  // Not an org-reassignment of an enrolled customer site (first-assignment / project scope).
  ['src/controllers/plg/plg-onboarding.js', 'PLG onboarding first-assignment path'],
  ['src/controllers/plg/plg-onboarding/entitlement.js', 'entitlement flow, gated upstream'],
  ['src/controllers/project.js', 'project re-parent, not a site enrollment move'],
]);

function walkJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...walkJsFiles(abs));
    } else if (entry.endsWith('.js')) {
      out.push(abs);
    }
  }
  return out;
}

describe('site org-reassignment call-site backstop (LLMO-7284)', () => {
  it('every file mutating a site org is on the reviewed allowlist', () => {
    const offenders = walkJsFiles(SRC_DIR)
      .filter((abs) => ORG_MUTATION_RE.test(readFileSync(abs, 'utf8')))
      .map((abs) => relative(REPO_ROOT, abs));

    const actual = new Set(offenders);
    const allowed = new Set(ALLOWLISTED_ORG_MUTATION_FILES.keys());

    const unlisted = [...actual].filter((f) => !allowed.has(f));
    const stale = [...allowed].filter((f) => !actual.has(f));

    expect(
      unlisted,
      `New site.setOrganizationId() call site(s) not on the reviewed allowlist: ${unlisted.join(', ')}. `
      + 'Wire assertSiteOrgReassignmentSafe (or document the exemption) and add the file to '
      + 'ALLOWLISTED_ORG_MUTATION_FILES in this test.',
    ).to.deep.equal([]);

    expect(
      stale,
      `Allowlisted file(s) no longer mutate a site org; remove them from the allowlist: ${stale.join(', ')}.`,
    ).to.deep.equal([]);
  });

  it('files tagged "guarded" still call assertSiteOrgReassignmentSafe', () => {
    // Enumeration proves the file mutates a site org; this proves the ones we claim
    // are guarded still actually invoke the guard. Removing the guard call (while
    // leaving the mutation) must fail here rather than silently rot the allowlist note.
    const unguarded = [...ALLOWLISTED_ORG_MUTATION_FILES.entries()]
      .filter(([, note]) => note.startsWith('guarded by assertSiteOrgReassignmentSafe'))
      .filter(([file]) => !readFileSync(join(REPO_ROOT, file), 'utf8').includes('assertSiteOrgReassignmentSafe'))
      .map(([file]) => file);

    expect(
      unguarded,
      `File(s) tagged "guarded" no longer call assertSiteOrgReassignmentSafe: ${unguarded.join(', ')}. `
      + 'Re-wire the guard or move the entry to a self-gating/exempt note.',
    ).to.deep.equal([]);
  });
});
