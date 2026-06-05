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

import { hasText, isNonEmptyObject } from '@adobe/spacecat-shared-utils';

/**
 * Case-insensitive header lookup on a headers object
 *
 * @param {Object} [headers] - Request headers map
 * @param {string} name - Header name
 * @returns {string|undefined} Raw header value, or undefined if absent
 */
export function getHeaderCaseInsensitive(headers, name) {
  if (!isNonEmptyObject(headers)) {
    return undefined;
  }
  const lower = name.toLowerCase();
  const key = Object.keys(headers).find((k) => k.toLowerCase() === lower);
  return key ? headers[key] : undefined;
}

/**
 * Reads a header from context.pathInfo.headers (case-insensitive).
 * Returns a trimmed string, or null when the header is absent, empty, or whitespace-only.
 *
 * @param {Object} context - Request context
 * @param {string} name - Header name (e.g. from `utils/constants.js`)
 * @returns {string|null} Trimmed header value, or null if absent / empty
 */
export function getHeader(context, name) {
  const raw = getHeaderCaseInsensitive(context?.pathInfo?.headers, name);
  if (!hasText(raw)) {
    return null;
  }
  const trimmed = String(raw).trim();
  return hasText(trimmed) ? trimmed : null;
}
