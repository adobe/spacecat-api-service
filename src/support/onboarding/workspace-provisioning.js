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

import { hasText, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import { baseUrl, DEFAULT_TIMEOUT_MS } from '../serenity/rest-transport.js';
import { SerenityTransportError } from '../serenity/serenity-transport-error.js';

const WORKSPACE_MEMBERS_PATH = '/enterprise/users/api/v1/adobe-ims/workspace-members';

/**
 * Calls Semrush's Adobe IMS Workspace Provisioning API
 * (`POST /enterprise/users/api/v1/adobe-ims/workspace-members`) to grant the
 * calling user admin access to their organization's Semrush workspace.
 *
 * The caller's Adobe IMS access token IS the credential — Semrush validates it
 * directly against Adobe IMS and resolves the user's email and Adobe
 * Organization ID from it server-side. We send the same token on both the
 * `Authorization` header and the JSON body's `token` field: the header is how
 * every other Semrush gateway call in this codebase authenticates
 * (`rest-transport.js`'s `authToken`), and the body field is this specific
 * API's documented contract.
 *
 * @param {Record<string, string|undefined>} env - Runtime env (context.env);
 *   resolves the gateway origin via `SEMRUSH_PROJECTS_BASE_URL`.
 * @param {string} imsToken - The caller's Adobe IMS access token.
 * @returns {Promise<{ email: string, organizationId: string, workspaceId: string, role: string }>}
 * @throws {SerenityTransportError} the upstream status (400/401/403/409/422/500)
 *   on a non-2xx response, 502 when the request to Semrush itself fails (including
 *   a timeout past `DEFAULT_TIMEOUT_MS`) or the 2xx body is missing `workspace_id`/
 *   `role`.
 */
export async function provisionWorkspaceMember(env, imsToken) {
  const url = `${baseUrl(env)}${WORKSPACE_MEMBERS_PATH}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${imsToken}`,
      },
      body: JSON.stringify({ token: imsToken }),
      // Caps the upstream call so a hung Semrush connection doesn't pin the
      // Lambda for its full ~29s API Gateway execution budget — same ceiling
      // every other direct Semrush call in this codebase uses (rest-transport.js).
      // A timeout surfaces as an AbortError/TimeoutError, caught below like any
      // other network failure.
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e.code || e.name || 'network error';
    throw new SerenityTransportError(502, `workspace-members request failed: ${reason}`);
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new SerenityTransportError(
      response.status,
      `workspace-members request failed with status ${response.status}`,
      body,
    );
  }

  // The OpenAPI contract declares workspaceId/role as required strings on the
  // 200 response. A 2xx with either missing is a contract violation from
  // Semrush, not a value we can pass through to the controller/client — treat
  // it as an upstream failure (502) rather than returning undefined fields.
  if (!hasText(body?.workspace_id) || !hasText(body?.role)) {
    throw new SerenityTransportError(502, 'workspace-members returned an invalid response', body);
  }

  return {
    email: body?.email,
    organizationId: body?.organization_id,
    workspaceId: body?.workspace_id,
    role: body?.role,
  };
}
