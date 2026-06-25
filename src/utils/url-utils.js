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
 * Extracts the pathname from a URL string, stripping trailing slashes on non-root paths.
 * Falls back to the raw string when the URL is not parseable (e.g. invalid or relative).
 *
 * @param {string} url
 * @returns {string} pathname, or the original string on parse failure
 */
export function toPathname(url) {
  try {
    const { pathname } = new URL(url);
    return pathname === '/' ? pathname : pathname.replace(/\/$/, '').toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

// TODO: move to spacecat-shared-util
export function hasSamePathname(url, referenceUrl) {
  return toPathname(url) === toPathname(referenceUrl);
}

// TODO: move to spacecat-shared-util
export function allHaveSamePathname(urls, referenceUrl) {
  return urls.every((url) => hasSamePathname(url, referenceUrl));
}
