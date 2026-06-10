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

const BEARER_PREFIX = 'Bearer ';

/**
 * Pulls the IMS bearer token from an inbound request context, or returns null
 * when the caller is not IMS-authenticated.
 *
 * The Semrush gateway only understands IMS user tokens; anything else (scoped
 * API key, S2S JWT, or an auth object we can't classify) must not be forwarded.
 * This is intentionally stricter than the serenity proxy's throwing
 * `requireImsBearer`: it requires a recognisable IMS auth type rather than
 * letting an unknown shape through, and it returns null (rather than throwing)
 * so callers can decide how to handle a non-IMS caller.
 *
 * @param {object} context - The request context.
 * @returns {string|null} The bearer token, or null when absent / non-IMS auth.
 */
export function extractImsBearer(context) {
  const authInfo = context?.attributes?.authInfo;
  if (!authInfo?.getType || authInfo.getType() !== 'ims') {
    return null;
  }
  const header = context?.pathInfo?.headers?.authorization;
  if (!hasText(header) || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.substring(BEARER_PREFIX.length);
  return hasText(token) ? token : null;
}
