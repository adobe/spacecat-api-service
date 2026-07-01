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

import { prependSchema } from '@adobe/spacecat-shared-utils';

/**
 * A pattern is trusted as scoped to the site's base path only when it is an exact match or
 * uses the `/*` pathname-prefix convention (see @adobe/spacecat-shared-tokowaka-client's
 * buildUrlMatcher). Any other pattern is compiled as a regex and matched against the full
 * URL downstream, so a literal `startsWith` check on the pattern text is not sound —
 * e.g. `/kings/.*|/wolves/.*` starts with `/kings` but, once compiled, also matches
 * `/wolves/...` via the `|` alternation. We fail closed for anything we cannot verify.
 *
 * The base path is derived the same way @adobe/spacecat-shared-utils's isWithinSiteScope
 * derives it (case-preserving, trailing slash stripped) rather than via toPathname, which
 * lower-cases its result — using toPathname here would make this pattern-side check
 * case-insensitive while the URL-side check (isWithinSiteScope) stays case-sensitive,
 * silently accepting/rejecting the same casing differently depending on which check ran.
 * @param {string} pathPattern - the pattern to check.
 * @param {string} siteBaseUrl - the site's base URL defining the scope (e.g. "bulk.com/uk"),
 * mirroring the siteBaseUrl argument of @adobe/spacecat-shared-utils's isWithinSiteScope.
 * @returns {boolean} true if the pattern is confirmed to be within the site's scope.
 */
// TODO: move to @adobe/spacecat-shared-utils once it stabilizes.
export function isPathPatternWithinSiteScope(pathPattern, siteBaseUrl) {
  if (typeof pathPattern !== 'string') {
    return false;
  }
  if (!siteBaseUrl) {
    return true;
  }

  let siteBasePath;
  try {
    const rawPath = new URL(prependSchema(siteBaseUrl)).pathname;
    siteBasePath = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  } catch {
    return false;
  }

  if (!siteBasePath || siteBasePath === '/') {
    return true;
  }

  if (pathPattern.endsWith('/*')) {
    const prefix = pathPattern.slice(0, -2);
    return prefix === siteBasePath || prefix.startsWith(`${siteBasePath}/`);
  }
  // eslint-disable-next-line no-useless-escape
  if (/[|()\[\]^$+*?\\.]/.test(pathPattern)) {
    return false;
  }
  return pathPattern === siteBasePath || pathPattern.startsWith(`${siteBasePath}/`);
}
