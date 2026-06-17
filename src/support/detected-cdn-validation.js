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

/**
 * API validation for `config.llmo.detectedCdn`.
 *
 * The data-access site config schema (`llmo.detectedCdn`) only accepts a fixed enum. The
 * generic site config PATCH copies `requestBody.config.llmo.detectedCdn` verbatim into the
 * persisted config, so a client sending an array, a stringified array
 * (e.g. `'["Adobe-managed Fastly"]'`) or a human display name (e.g. `'Adobe-managed Fastly'`)
 * gets it stored raw. Because `Config()` swallows the resulting Joi error and falls back to the
 * raw data ("Site configuration validation failed, using provided data"), the malformed value
 * then re-fails validation on every subsequent read. Reject malformed input at the API edge
 * instead - schema is the source of truth.
 *
 * The enum is duplicated here because the data-access package does not export it. Keep this list
 * in sync with `llmo.detectedCdn` in `@adobe/spacecat-shared-data-access`
 * (`src/models/site/config.js`).
 */
export const ALLOWED_DETECTED_CDNS = Object.freeze([
  'aem-cs-fastly',
  'commerce-fastly',
  'byocdn-fastly',
  'byocdn-akamai',
  'byocdn-cloudfront',
  'byocdn-cloudflare',
  'byocdn-imperva',
  'byocdn-other',
  'ams-cloudfront',
  'ams-frontdoor',
  'other',
]);

/**
 * When `configPatch.llmo` includes a `detectedCdn`, validates it against the allowed enum.
 *
 * Like `auditTargetURLsPatchGuard`, this only inspects what the client explicitly sent
 * (`configPatch.llmo.detectedCdn`), not values folded in by the deep-merge - so a partial llmo
 * patch that does not touch `detectedCdn` never re-rejects a pre-existing (possibly legacy) value.
 *
 * @param {Record<string, unknown>} configPatch - The raw `requestBody.config` patch.
 * @param {(message: string) => unknown} badRequestFn - Factory for the controller's 400 response.
 * @returns {null | { error: unknown }} `null` when the patch did not set `detectedCdn` or the
 *   value is valid; `{ error }` (the `badRequestFn` result) to return from the controller.
 */
export function detectedCdnPatchGuard(configPatch, badRequestFn) {
  const llmoPatch = configPatch?.llmo;
  if (llmoPatch === null || typeof llmoPatch !== 'object' || Array.isArray(llmoPatch)) {
    return null;
  }
  if (!Object.prototype.hasOwnProperty.call(llmoPatch, 'detectedCdn')) {
    return null;
  }
  const { detectedCdn } = llmoPatch;
  if (!ALLOWED_DETECTED_CDNS.includes(detectedCdn)) {
    return {
      error: badRequestFn(
        `config.llmo.detectedCdn must be one of: ${ALLOWED_DETECTED_CDNS.join(', ')}`,
      ),
    };
  }
  return null;
}
