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

import { hasText } from '@adobe/spacecat-shared-utils';

/**
 * Shared input validation for the serenity surface. The slice key is
 * `(brandId, geoTargetId, languageCode)` — every handler (markets +
 * prompts) needs to validate `languageCode` and `geoTargetId` to the
 * same shape, so the regex and the normalizers live here.
 *
 * `languageCode` is a BCP-47 primary subtag (lowercase, 2–3 letters)
 * optionally with a 2–4 letter region/script subtag.
 */
export const LANGUAGE_TAG_REGEX = /^[a-z]{2,3}(-[a-z]{2,4})?$/;

/**
 * Lowercases and validates `value` against `LANGUAGE_TAG_REGEX`.
 * Returns the normalized form on success, `null` on missing or malformed.
 */
export function normalizeLanguageCode(value) {
  if (!hasText(value)) {
    return null;
  }
  const lower = String(value).toLowerCase();
  return LANGUAGE_TAG_REGEX.test(lower) ? lower : null;
}

/**
 * Returns a positive integer geoTargetId if `value` already parses as one
 * (the controller's `parsedQuery` does the string→int conversion for query
 * params; for body fields the handlers parse with `Number()`). Returns
 * `null` otherwise.
 */
export function normalizeGeoTargetId(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}
