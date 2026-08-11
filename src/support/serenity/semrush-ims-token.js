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

import { hasText } from '@adobe/spacecat-shared-utils';
import { ErrorWithStatusCode } from '../utils.js';

const TOKEN_PATH = '/ims/token/v3';
// Scopes required to manage Semrush workspace members via the User Manager API
// (user_management_sdk is the operative one). Overridable via SEMRUSH_IMS_TECH_SCOPE.
const DEFAULT_SCOPES = 'openid,AdobeID,user_management_sdk,additional_info.projectedProductContext';

/**
 * Builds the IMS token endpoint URL from `IMS_HOST` (accepts a bare host such as
 * `ims-na1.adobelogin.com` or a full origin). This is only the IMS *host* — the
 * dedicated Semrush IMS identity's own credentials come from the SEMRUSH_IMS_TECH_*
 * vars below — so stage/prod stay switchable via the env var the service already
 * carries, with no extra URL secret.
 *
 * @param {object} env
 * @returns {string} the absolute `/ims/token/v3` URL.
 */
function imsTokenUrl(env) {
  const raw = typeof env?.IMS_HOST === 'string' ? env.IMS_HOST.trim() : '';
  if (!hasText(raw)) {
    throw new ErrorWithStatusCode(
      'IMS_HOST is not set; cannot mint the Semrush IMS token',
      503,
    );
  }
  const origin = raw.startsWith('http') ? raw : `https://${raw}`;
  return new URL(TOKEN_PATH, origin).href;
}

/**
 * Mints an IMS access token for the DEDICATED Semrush IMS technical account via the
 * `client_credentials` grant, and returns it for use as the bearer on Semrush User
 * Manager calls. This deliberately does NOT use the calling user's token: the flow
 * must be able to provision a user who is not yet a member of the workspace, so the
 * grant runs as this dedicated Semrush IMS identity (which holds the member-management
 * rights), not as the end user.
 *
 * Credentials come from `SEMRUSH_IMS_TECH_ID` / `SEMRUSH_IMS_TECH_SECRET` (Vault:
 * dx_mysticat/<env>/api-service). The token endpoint host is derived from `IMS_HOST`;
 * scopes default to `DEFAULT_SCOPES` and are overridable via `SEMRUSH_IMS_TECH_SCOPE`.
 *
 * Never logs the credentials or the minted token — only the IMS-side error code and
 * HTTP status on failure.
 *
 * @param {object} env - runtime env (reads IMS_HOST, SEMRUSH_IMS_TECH_ID,
 *   SEMRUSH_IMS_TECH_SECRET, optional SEMRUSH_IMS_TECH_SCOPE).
 * @param {{ error: (msg: string, meta?: object) => void }} log
 * @returns {Promise<string>} the IMS access token (no 'Bearer ' prefix).
 */
export async function mintSemrushImsToken(env, log) {
  const clientId = typeof env?.SEMRUSH_IMS_TECH_ID === 'string' ? env.SEMRUSH_IMS_TECH_ID.trim() : '';
  const clientSecret = typeof env?.SEMRUSH_IMS_TECH_SECRET === 'string'
    ? env.SEMRUSH_IMS_TECH_SECRET.trim()
    : '';
  if (!hasText(clientId) || !hasText(clientSecret)) {
    throw new ErrorWithStatusCode(
      'SEMRUSH_IMS_TECH_ID and SEMRUSH_IMS_TECH_SECRET must be set to mint the Semrush IMS token',
      503,
    );
  }
  const scope = hasText(env?.SEMRUSH_IMS_TECH_SCOPE)
    ? env.SEMRUSH_IMS_TECH_SCOPE.trim()
    : DEFAULT_SCOPES;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  // Resolve the endpoint BEFORE the network try/catch so a config error (missing
  // IMS_HOST → 503) is not rewrapped as a 502 transport failure.
  const url = imsTokenUrl(env);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (e) {
    throw new ErrorWithStatusCode(
      `Failed to reach IMS to mint the Semrush IMS token: ${e?.message}`,
      502,
    );
  }

  let json = null;
  try {
    json = await response.json();
  } catch { /* non-JSON error body handled below */ }

  if (!response.ok || !hasText(json?.access_token)) {
    // Do NOT log the credentials or token — only the IMS-side error signal.
    log.error('Semrush IMS token mint failed', {
      status: response.status,
      imsError: typeof json?.error === 'string' ? json.error : '',
    });
    throw new ErrorWithStatusCode('Failed to mint the Semrush IMS token', 502);
  }
  return json.access_token;
}
