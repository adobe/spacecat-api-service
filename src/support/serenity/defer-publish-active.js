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
 * The GLOBAL toggle for publish-after-populate (LLMO-5492). When ON, the
 * sub-workspace create path leaves each project a DRAFT (`publishMode: 'skip'`)
 * instead of publishing inline, so a later finalize step (see
 * `handlers/finalize.js`, driven by the DRS-completion trigger in a separate
 * repo) pushes the generated prompts + models and publishes each project once.
 *
 * A single env boolean, DEFAULT OFF, read once per request off `context.env` —
 * the same shape the other global serenity toggles use
 * (`SERENITY_DYNAMIC_ALLOCATION` in dynamic-allocation-active.js,
 * `SERENITY_ALLOW_NON_IMS_AUTH` in rest-transport.js). When OFF, the create path
 * publishes inline byte-for-byte as before this change. Wired to Vault at
 * `dx_mysticat/<env>/api-service`.
 */
export const DEFER_PUBLISH_ENV_FLAG = 'SERENITY_DEFER_PUBLISH';

/**
 * Reads the global defer-publish toggle. `true` ONLY for the exact string
 * `'true'` (env values are strings); anything else — unset, `'false'`, a typo —
 * is OFF. Fail-safe by design (default: publish inline).
 * @param {object} [env] - the request env (`context.env`).
 * @returns {boolean}
 */
export function isSerenityDeferPublishEnabled(env) {
  return env?.[DEFER_PUBLISH_ENV_FLAG] === 'true';
}
