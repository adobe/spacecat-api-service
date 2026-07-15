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
  badRequest, createResponse, forbidden, notFound, ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';

import AccessControlUtil from '../support/access-control-util.js';
import { notifyOnboarding } from '../support/onboarding/slack-notifier.js';

/**
 * Best-effort per-org notification cooldown. Guards against a buggy client or MFE
 * retry loop hammering the Slack channel with duplicate onboarding pings.
 *
 * Deliberately minimal: this Map is module-scoped, so — like the workspace cache
 * — it is PER LAMBDA CONTAINER. It de-dupes serial retries that land on the same
 * warm container but does NOT bound a flood fanned out across many concurrent
 * containers. A hard cross-instance guarantee would need shared state (an org
 * `lastNotifiedAt` column or a shared store); that is not warranted for this
 * low-QPS, authenticated, `hasAccess`-gated endpoint today. The cooldown is armed
 * only AFTER a successful send, so a failed notification stays immediately
 * retryable.
 */
const ONBOARDING_COOLDOWN_MS = 30 * 1000; // 30s per org
const onboardingCooldown = new Map();

/**
 * Controller for the Semrush onboarding notification endpoint.
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

    const profile = ctx.attributes?.authInfo?.getProfile?.();
    const email = profile?.trial_email || profile?.email;
    if (!hasText(email)) {
      return badRequest('Unable to determine customer email from the request identity');
    }

    // We already fetched `org` above for the access check. Read the workspace
    // id straight off it rather than routing through resolveWorkspaceId — that
    // avoids a second Organization.findById on a cold cache, and (since the
    // resolver can serve a 30s negative-cached null) reports the org's true
    // current workspace for an org that was just given one.
    const workspaceId = typeof org.getSemrushWorkspaceId === 'function'
      ? (org.getSemrushWorkspaceId() ?? null)
      : null;

    const lastNotified = onboardingCooldown.get(spaceCatId);
    if (lastNotified && Date.now() - lastNotified < ONBOARDING_COOLDOWN_MS) {
      log.info(`[onboarding] skipping notification for org=${spaceCatId}: within ${ONBOARDING_COOLDOWN_MS}ms cooldown`);
      return ok({ notified: false, workspaceId, reason: 'recently notified' });
    }

    try {
      await notifyOnboarding(env, { email, workspaceId, spaceCatId });
    } catch (e) {
      // Default unexpected errors (no .status) to 500; only notifyOnboarding's
      // explicit 502 (webhook failure) surfaces as a gateway error.
      const status = e.status || 500;
      // The webhook URL is a secret (its path carries the Slack token).
      // notifyOnboarding is contracted to keep it out of thrown messages, but
      // redact it here defensively so a future change there can never leak it
      // into server logs.
      const webhookUrl = env?.SLACK_ONBOARDING_WEBHOOK_URL;
      const reason = webhookUrl && typeof e.message === 'string'
        ? e.message.split(webhookUrl).join('[redacted]')
        : (e.message || 'unknown error');
      log.error(`[onboarding] notification failed for org=${spaceCatId} status=${status}: ${reason}`);
      return createResponse({ message: 'Failed to send onboarding notification' }, status);
    }

    // Arm the cooldown only after a confirmed send so a failed notification
    // (the catch above returns before this) stays immediately retryable.
    onboardingCooldown.set(spaceCatId, Date.now());

    return ok({ notified: true, workspaceId });
  };

  return { triggerOnboarding };
}
