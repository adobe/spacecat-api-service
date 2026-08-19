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

import {
  createResponse, forbidden, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';

import AccessControlUtil from '../support/access-control-util.js';
import { notifyProvisioningFailure } from '../support/onboarding/slack-notifier.js';
import { provisionWorkspaceMember } from '../support/onboarding/workspace-provisioning.js';
import { resolveSemrushImsToken } from '../support/utils.js';

/**
 * Controller for the Semrush onboarding / workspace-provisioning endpoint.
 *
 * @param {object} context - Boot-time context injected by the route wiring in
 *   index.js. Unused here: all per-request data (dataAccess, params, attributes)
 *   comes from the `ctx` argument passed to each handler. Kept in the signature
 *   to match the positional factory convention (see ElementsController).
 * @param {object} log - Logger.
 * @param {object} env - Runtime env.
 * @returns {{ triggerOnboarding: (ctx: object) => Promise<Response> }}
 */
export default function OnboardingController(context, log, env) {
  /**
   * POST /v2/orgs/:spaceCatId/semrush-onboarding
   *
   * Grants the caller admin access to their organization's Semrush workspace
   * by calling Semrush's Adobe IMS Workspace Provisioning API with the
   * caller's own IMS access token (resolved via the shared `x-promise-token`
   * flow — see `resolveSemrushImsToken`). On success (including a 409 — the
   * caller was already a member), nothing further happens: no Slack
   * notification, since the user now has access already. On any other
   * failure, a best-effort Slack alert is sent so a CSM can follow up
   * manually — mirroring the old manual-onboarding process this API replaces.
   *
   * @param {object} ctx - Request context.
   * @returns {Promise<Response>}
   */
  const triggerOnboarding = async (ctx) => {
    const { spaceCatId } = ctx.params;

    const org = await ctx.dataAccess.Organization.findById(spaceCatId);
    if (!org) {
      return notFound('Organization not found');
    }

    const accessControlUtil = AccessControlUtil.fromContext(ctx);
    if (!await accessControlUtil.hasAccess(org)) {
      return forbidden('User does not have access to this organization');
    }

    let imsToken;
    try {
      imsToken = await resolveSemrushImsToken(ctx, log, 'onboarding');
    } catch (e) {
      const status = e.status || 401;
      return createResponse({ message: e.message || 'Unable to resolve IMS credentials' }, status);
    }

    try {
      const result = await provisionWorkspaceMember(env, imsToken);
      return ok({ provisioned: true, workspaceId: result.workspaceId, role: result.role });
    } catch (e) {
      // Default unexpected errors (no .status) to 500.
      const status = e.status || 500;

      // We already fetched `org` above for the access check. Read the workspace
      // id straight off it rather than a second Organization.findById.
      const workspaceId = typeof org.getSemrushWorkspaceId === 'function'
        ? (org.getSemrushWorkspaceId() ?? null)
        : null;

      // A 409 means the caller is already a member of this workspace (or its parent) —
      // from their perspective they wanted access and they have it, so this is a
      // success, not a failure needing CSM follow-up. No Slack alert. Semrush's
      // Behavior contract (step 5) guarantees a member always ends up 'admin', so
      // default the role when the 409 body doesn't echo it back.
      if (status === 409) {
        log.info(`[onboarding] workspace provisioning: org=${spaceCatId} caller already a member`);
        return ok({
          provisioned: true,
          alreadyMember: true,
          workspaceId: e.body?.workspace_id ?? workspaceId,
          role: e.body?.role ?? 'admin',
        });
      }

      log.error(`[onboarding] workspace provisioning failed for org=${spaceCatId} status=${status}: ${e.message}`);

      const profile = ctx.attributes?.authInfo?.getProfile?.();
      const email = profile?.trial_email || profile?.email;

      try {
        await notifyProvisioningFailure(env, {
          email: hasText(email) ? email : 'unknown',
          workspaceId,
          spaceCatId,
          reason: `status ${status}: ${e.message || 'unknown error'}`,
        });
      } catch (slackErr) {
        // Best-effort alert — a broken webhook must not mask the original
        // provisioning failure returned to the caller below.
        log.error(`[onboarding] failed to send provisioning-failure alert for org=${spaceCatId}: ${slackErr.message}`);
      }

      return createResponse({ message: 'Failed to provision Semrush workspace access' }, status);
    }
  };

  return { triggerOnboarding };
}
