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

// @ts-check

/**
 * Type-level regression guard for the STRICT tier (`tsconfig.strict.json`).
 *
 * This directory is checked ONLY by the strict tier; `test/types/base/` is checked only by
 * the base one. The split is load-bearing rather than tidiness: the assertion below expects
 * TS2339, which the base tier suppresses outright, so a single shared fixture would fail the
 * base tier with an unused-directive error (TS2578).
 *
 * What this pins is the strict tier's entire reason for existing. `noImplicitAny: true` is
 * the only thing that makes TypeScript report an unknown member on a JS value — remove it
 * from `tsconfig.strict.json` and this directive goes unused, failing the build. Without
 * this guard, deleting that compiler option is a silent no-op.
 *
 * Nothing here executes: mocha's spec glob does not match `.types.js`.
 */

/**
 * @typedef {import('../../../src/support/serenity/rest-transport.js').
 *   SerenityTransport} SerenityTransport
 */

/** @param {SerenityTransport} transport */
export async function unknownMembersAreReported(transport) {
  // @ts-expect-error - Property 'noSuchMethodAnywhere' does not exist on the transport.
  await transport.noSuchMethodAnywhere();

  // A real method must stay clean, so the assertion above cannot pass merely because the
  // whole value went untyped.
  await transport.listLanguages();
}
