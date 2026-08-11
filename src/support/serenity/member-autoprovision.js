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
import { isSemrushTransportError, unwrapTransportCause } from './errors.js';
import { mintSemrushImsToken } from './semrush-ims-token.js';
import { createSerenityTransport } from './rest-transport.js';

const DEFAULT_ROLE = 'role/workspace/viewer';

/**
 * True when the error is a Semrush auth denial (HTTP 401/403) on an outbound call.
 * 403 is the fixable "authenticated but not yet a workspace member" case; 401 (an
 * invalid/expired token) is included for completeness, but the single non-looping
 * retry below makes an unfixable 401 harmless.
 *
 * @param {unknown} e
 * @returns {boolean}
 */
export function isSemrushMembershipDenied(e) {
  const err = unwrapTransportCause(e);
  return isSemrushTransportError(err) && (err.status === 401 || err.status === 403);
}

/**
 * Runs a Semrush data read and, if it fails because the caller is not yet a member of
 * the workspace (upstream 401/403), provisions the caller onto the workspace (viewer
 * role) using the DEDICATED Semrush IMS technical-account token, then runs the read
 * exactly once more.
 *
 * Guarantees:
 *  - SINGLE retry — never loops, even if the retry also 401/403s.
 *  - Best-effort provisioning: if the grant itself fails (e.g. 422 "no user units", or a
 *    token-mint config error), the ORIGINAL read error is surfaced — the grant error
 *    never masks why the read failed.
 *  - Transparent no-op (runs the read once, unwrapped) when disabled, when
 *    workspaceId/memberEmail is missing, or when the error is not a Semrush 401/403.
 *
 * The read keeps using the caller's own transport (passed in via `run`); provisioning
 * uses a SEPARATE admin transport built from the minted service token.
 *
 * @template T
 * @param {object} params
 * @param {() => Promise<T>} params.run - executes the Semrush read; must be safe to call twice.
 * @param {object} params.env
 * @param {{ info: Function, error: (m: string, meta?: object) => void }} params.log
 * @param {boolean} params.enabled - the SERENITY_MEMBER_AUTOPROVISION flag.
 * @param {string | null | undefined} params.workspaceId - the resolved brand workspace.
 * @param {string | null | undefined} params.memberEmail - the calling user's email.
 * @param {string} [params.role] - Semrush role to grant (default `role/workspace/viewer`).
 * @returns {Promise<T>}
 */
export async function withMemberAutoProvision({
  run, env, log, enabled, workspaceId, memberEmail, role = DEFAULT_ROLE,
}) {
  if (!enabled) {
    return run();
  }
  try {
    return await run();
  } catch (readError) {
    // The truthiness checks also narrow the `string | null | undefined` params to
    // `string` for TS (hasText is not a type guard — see this dir's CLAUDE.md).
    if (!isSemrushMembershipDenied(readError)
      || !workspaceId || !hasText(workspaceId)
      || !memberEmail || !hasText(memberEmail)) {
      throw readError;
    }
    try {
      log.info('[serenity] auto-provisioning workspace member after upstream 401/403', {
        workspaceId,
      });
      const imsToken = await mintSemrushImsToken(env, log);
      const adminTransport = createSerenityTransport({ env, imsToken });
      await adminTransport.addWorkspaceMembers(workspaceId, [memberEmail], role);
    } catch (provisionError) {
      // Provisioning is best-effort: surface the ORIGINAL read error (the 401/403), not
      // the grant error, so a "no seats" (422) or mint-config failure never masks the
      // reason the read failed. The grant error is logged for diagnosis only.
      log.error('[serenity] member auto-provision failed; surfacing original read error', {
        workspaceId,
        provisionError: provisionError?.message,
      });
      throw readError;
    }
    // Provisioned — retry the read exactly once. If it still fails, that error propagates
    // (no further provisioning attempt).
    return run();
  }
}
