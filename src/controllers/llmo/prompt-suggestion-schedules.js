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

import {
  ok,
  badRequest,
  notFound,
  forbidden,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import { isNonEmptyObject, isValidUUID } from '@adobe/spacecat-shared-utils';
import DrsClient from '@adobe/spacecat-shared-drs-client';

import AccessControlUtil from '../../support/access-control-util.js';
import { CAP_PROMPT_SUGGESTION_SCHEDULE_WRITE } from '../../routes/capability-constants.js';
import {
  ensurePromptSuggestionSchedules,
  isPayingLlmoSite,
} from '../../support/prompt-suggestion-schedules.js';

const ROUTE = 'POST /sites/:siteId/prompt-suggestion-schedules';

/**
 * Controller for the reusable per-site prompt-suggestion schedule provisioning
 * endpoint (`POST /sites/:siteId/prompt-suggestion-schedules`).
 *
 * This is the api-service slice of the recurring-schedule creation flow that also
 * runs as a best-effort onboarding side-effect. It exists so other components can
 * (re)provision a site's recurring DRS prompt-suggestion pipelines out of band:
 *   - the fulfillment-worker, after a Commerce trial→paid tier flip (follow-up),
 *   - a reconciler that backfills PAID LLMO sites missing schedules (follow-up),
 *   - the admin trial→paid reaction in entitlements.createSiteEntitlement.
 *
 * The single mechanism is the site's CURRENT LLMO tier, re-derived server-side —
 * the caller may not supply a tier/isPaying. Only paying sites get recurring
 * schedules; a non-paying site is a no-op (skipped) because the trial one-shot run
 * is an onboarding-only behavior (submitJob is not idempotent, so a
 * re-provision/backfill endpoint must be paying-only). The underlying
 * createSchedule is idempotent, so repeat calls are safe and already-existing
 * schedules count as success.
 *
 * @param {object} ctx - Request context.
 * @returns {object} Prompt-suggestion schedules controller.
 * @constructor
 */
function PromptSuggestionSchedulesController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess, log } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Site } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Dual-layer write authorization: admin bypass first, then a fresh consumer
   * fetch (`hasS2SCapability`) for S2S consumers. Returns a forbidden Response
   * when denied, null when access is granted.
   * @param {object} context - Request context.
   * @returns {Promise<Response|null>}
   */
  const authorizeWrite = async (context) => {
    const requestId = context?.invocation?.id || 'unknown';
    const isAdmin = accessControlUtil.hasAdminAccess();
    const s2sResult = isAdmin
      ? { allowed: false, reason: 'admin-bypass' }
      : await accessControlUtil.hasS2SCapability(CAP_PROMPT_SUGGESTION_SCHEDULE_WRITE);
    if (!isAdmin && !s2sResult.allowed) {
      log.info(`[acl] Denied ${ROUTE} - reason=${s2sResult.reason} clientId=${s2sResult.clientId || 'n/a'} consumerId=${s2sResult.consumerId || 'n/a'} requestId=${requestId}`);
      return forbidden('Forbidden');
    }
    if (s2sResult.allowed) {
      log.info(`[s2s] ${ROUTE} granted clientId=${s2sResult.clientId || 'n/a'} consumerId=${s2sResult.consumerId || 'n/a'} capability=${CAP_PROMPT_SUGGESTION_SCHEDULE_WRITE} requestId=${requestId}`);
    }
    return null;
  };

  /**
   * (Re)provisions the recurring DRS prompt-suggestion schedules for a site, if
   * (and only if) it is currently on the paying LLMO tier.
   * @param {object} context - Request context.
   * @returns {Promise<Response>}
   */
  const createSchedules = async (context) => {
    const denied = await authorizeWrite(context);
    if (denied) {
      return denied;
    }

    const { siteId } = context.params;
    if (!isValidUUID(siteId)) {
      return badRequest('Site ID required');
    }

    const clientId = context.s2sConsumer?.getClientId?.() || 'n/a';

    try {
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      let drsClient;
      try {
        drsClient = DrsClient.createFrom(context);
      } catch (drsClientError) {
        log.error(`[prompt-suggestion-schedules] DRS client creation failed site_id=${siteId} clientId=${clientId}: ${drsClientError.message}`);
        return internalServerError('DRS client is not available');
      }
      if (!drsClient.isConfigured()) {
        log.error(`[prompt-suggestion-schedules] DRS client not configured site_id=${siteId} clientId=${clientId}`);
        return internalServerError('DRS client is not configured');
      }

      // Re-derive the tier server-side; never trust a caller-supplied tier.
      const isPaying = await isPayingLlmoSite(site, context);
      if (!isPaying) {
        log.info(`[prompt-suggestion-schedules] Skipped (site not paying) site_id=${siteId} clientId=${clientId}`);
        return ok({
          siteId,
          isPaying: false,
          skipped: true,
          reason: 'not-paying',
          allSucceeded: true,
          results: [],
        });
      }

      const { results, allSucceeded } = await ensurePromptSuggestionSchedules({
        drsClient,
        siteId,
        isPaying: true,
        log,
      });

      const summary = results.map((r) => `${r.providerId}:${r.status}`).join(',');
      if (allSucceeded) {
        log.info(`[prompt-suggestion-schedules] Provisioned recurring schedules site_id=${siteId} clientId=${clientId} results=${summary}`);
      } else {
        log.error(`[prompt-suggestion-schedules] One or more pipelines failed site_id=${siteId} clientId=${clientId} results=${summary}`);
      }

      return ok({
        siteId,
        isPaying: true,
        skipped: false,
        allSucceeded,
        results,
      });
    } catch (e) {
      log.error(`[prompt-suggestion-schedules] Failed site_id=${siteId} clientId=${clientId}: ${e.message}`);
      return internalServerError('Failed to provision prompt-suggestion schedules');
    }
  };

  return {
    createSchedules,
  };
}

export default PromptSuggestionSchedulesController;
