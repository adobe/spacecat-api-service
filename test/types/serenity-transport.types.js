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
 * Type-level regression guard for the Semrush transport contract.
 *
 * Nothing here runs: the file is asserted by `tsc`, not by mocha, whose spec glob
 * (`test/ ** / *.test.js`) does not match `.types.js`. It is in the `tsconfig.json`
 * `include` list, so `npm run type-check` covers it.
 *
 * Each `@ts-expect-error` fails the build if the error it expects STOPS happening, which
 * pins both halves of the gate. Dropping a transport method's own `@param` tags makes its
 * assertions legal again; widening the parameter below back to `@param {object} transport`
 * makes ALL of them legal. Either way the now-unused directives fail type-check (TS2578).
 * Both halves are load-bearing: the named type alone does not restore arity checking,
 * because undocumented parameters are implicitly `any` and therefore optional.
 *
 * The scope of that pin is this file's own parameter. A production call site that widens
 * its transport back to `{object}` is not detectable from here — the convention for those
 * is written down in `src/support/serenity/CLAUDE.md`.
 *
 * What is deliberately NOT asserted here: an unknown member (`transport.noSuchMethod()`).
 * `noImplicitAny: false` suppresses TS2339 in JS files even against a fully-typed
 * receiver, so that check exists only in the strict tier (`tsconfig.strict.json`).
 */

/**
 * @typedef {import('../../src/support/serenity/rest-transport.js').
 *   SerenityTransport} SerenityTransport
 */

/**
 * @param {SerenityTransport} transport
 * @param {string} parentWorkspaceId
 */
export async function transportContractIsEnforced(transport, parentWorkspaceId) {
  // Arity. `resources` is required by `handlers.createWorkspaceV2Form`; omitting it
  // serializes the body without the key, which the live gateway tolerates and the
  // spec-generated vendor mock refuses.
  // @ts-expect-error - Expected 3 arguments, but got 2.
  await transport.createSubworkspace(parentWorkspaceId, 'title');

  // Body shape, derived from the generated contract: `ai` carries unit counts.
  // @ts-expect-error - string is not assignable to { projects?: number, prompts?: number }.
  await transport.createSubworkspace(parentWorkspaceId, 'title', { ai: 'unlimited' });

  // Argument types.
  // @ts-expect-error - number is not assignable to parameter of type string.
  await transport.publishProject(1, 'project-id');

  // Arity on a Project Engine method.
  // @ts-expect-error - Expected 4 arguments, but got 2.
  await transport.createPromptsByIds('workspace-id', 'project-id');

  // The contract-valid calls must stay clean — `{}` is how the spec expresses
  // "no allocation", since every field inside `resources` is itself optional.
  await transport.createSubworkspace(parentWorkspaceId, 'title', {});
  await transport.createPromptsByIds('workspace-id', 'project-id', ['a prompt'], ['tag-id']);
}
