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
import { DEFAULT_TIMEOUT_MS, usersBaseUrl } from '../serenity/rest-transport.js';
import { SerenityTransportError } from '../serenity/serenity-transport-error.js';

const WORKSPACE_MEMBERS_PATH = '/enterprise/users/api/v1/adobe-ims/workspace-members';

/**
 * Calls Semrush's Adobe IMS Workspace Provisioning API
 * (`POST /enterprise/users/api/v1/adobe-ims/workspace-members`) to grant the
 * calling user admin access to their organization's Semrush workspace.
 *
 * No `Authorization` header is sent on this call — deliberately, and only for
 * this endpoint. This is the one workspace-provisioning path where the calling
 * customer may not exist in Semrush yet (that's the point of the call — it's
 * what creates them there). Semrush's authenticating proxy in front of every
 * *other* gateway endpoint tries to authenticate an incoming `Authorization`
 * header against an existing Semrush user and 401s when that user doesn't
 * exist yet, which is always true for a brand-new customer here. Per Semrush,
 * this endpoint is intentionally reachable anonymously so it can run before
 * that account exists.
 *
 * The caller's Adobe IMS access token still IS the credential: it's sent in
 * the JSON body's `token` field, and Semrush independently validates it
 * against the IMS profile server-side (a trusted source it can't forge) to
 * resolve the user's email and Adobe Organization ID. Per Semrush, once we
 * have S2S in place, this call will instead be a service-to-service call
 * authenticated as "LLMO", carrying the user's email and organization ID
 * directly instead of an IMS token in the body — this body-token shape is an
 * interim workaround for the lack of S2S today.
 *
 * Every other Semrush gateway call in this codebase authenticates via the
 * `Authorization` header (`rest-transport.js`'s `authToken`) because those
 * calls are for customers who already have a Semrush account — do not carry
 * this no-header behavior over to any other Semrush call.
 *
 * @param {Record<string, string|undefined>} env - Runtime env (context.env);
 *   resolves the User Manager gateway origin via `usersBaseUrl` (`SEMRUSH_USERS_BASE_URL`,
 *   falling back to `SEMRUSH_PROJECTS_BASE_URL` when unset) — this is a User Manager
 *   path, not a Project Engine one.
 * @param {string} imsToken - The caller's Adobe IMS access token.
 * @returns {Promise<{ email: string, organizationId: string, workspaceId: string, role: string }>}
 * @throws {SerenityTransportError} the upstream status (400/401/403/409/422/500)
 *   on a non-2xx response, 502 when the request to Semrush itself fails (including
 *   a timeout past `DEFAULT_TIMEOUT_MS`) or the 2xx body is missing `workspace_id`/
 *   `role`.
 */
export async function provisionWorkspaceMember(env, imsToken) {
  const url = `${usersBaseUrl(env)}${WORKSPACE_MEMBERS_PATH}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
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
