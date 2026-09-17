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
 * Internal Slack alerting for the "Force Tier Update" escape hatch (SITES-50179).
 *
 * The onboard Slack command preserves an existing PLG/PRE_ONBOARD ASO entitlement by default
 * (SITES-49886); ticking *Force Tier Update* deliberately overrides that guard. When the override
 * results in a PLG/PRE_ONBOARD → FREE_TRIAL downgrade, `onboardSingleSite` calls this helper so the
 * team gets a high-signal alert every time the protection is bypassed — no manual auditing needed.
 *
 * Posts to the same `plg_onboardings` channel the PLG onboarding lifecycle notifications already
 * use (`SLACK_PLG_ONBOARDING_CHANNEL_ID` + `SLACK_BOT_TOKEN`), so the audience is exactly right and
 * no new infra is required. Fire-and-forget: this is an observability side-channel that must NEVER
 * throw or affect the onboard's own outcome — a Slack failure is logged, not propagated (mirrors
 * `postPlgOnboardingNotification` and `alertQuotaRejection`).
 */

import { postSlackMessage } from '../../utils/slack/base.js';

/**
 * Builds the high-signal alert message for a forced tier downgrade. Kept visually distinct
 * (`:rotating_light:` + a "Force Tier Update" heading) so it stands out from the routine
 * onboarding status traffic in the `plg_onboardings` channel.
 *
 * @param {object} p
 * @param {string} p.baseURL - Site base URL being onboarded.
 * @param {string} [p.organizationId] - SpaceCat organization id.
 * @param {string} [p.imsOrgID] - IMS org id.
 * @param {string} [p.siteId] - Site id.
 * @param {string} [p.entitlementId] - Id of the (now downgraded) ASO entitlement.
 * @param {string} p.fromTier - Tier before the override (PLG or PRE_ONBOARD).
 * @param {string} p.toTier - Tier after the override (FREE_TRIAL).
 * @param {string} [p.profileName] - Onboarding profile used.
 * @param {string} [p.sourceChannelId] - Slack channel the onboard was triggered from.
 * @param {string} [p.sourceThreadTs] - Thread timestamp of the triggering onboard command.
 * @returns {string}
 */
function formatMessage({
  baseURL, organizationId, imsOrgID, siteId, entitlementId,
  fromTier, toTier, profileName, sourceChannelId, sourceThreadTs,
}) {
  const lines = [
    `:rotating_light: *Force Tier Update — ASO entitlement tier overridden* \`${fromTier} → ${toTier}\``,
    `• Site: ${baseURL}`,
    `• SpaceCat Org: \`${organizationId || 'unknown'}\`  IMS Org: \`${imsOrgID || 'unknown'}\``,
    `• Site ID: \`${siteId || 'unknown'}\``,
    `• Entitlement: \`${entitlementId || 'unknown'}\``,
    `• Profile: \`${profileName || 'unknown'}\``,
  ];
  if (sourceChannelId) {
    const threadPart = sourceThreadTs ? ` (thread_ts \`${sourceThreadTs}\`)` : '';
    lines.push(`• Source: <#${sourceChannelId}>${threadPart}`);
  }
  lines.push(`• ${new Date().toISOString()}`);
  return lines.join('\n');
}

/**
 * Alerts the team that a PLG/PRE_ONBOARD → FREE_TRIAL tier downgrade was forced via the onboard
 * command's *Force Tier Update* escape hatch (SITES-50179). Fire-and-forget: never throws; a
 * missing channel/token config or a Slack failure is logged (best-effort) and swallowed.
 *
 * @param {object} payload - See {@link formatMessage} for the accepted fields.
 * @param {object} [env] - Reads `SLACK_PLG_ONBOARDING_CHANNEL_ID` + `SLACK_BOT_TOKEN`.
 * @param {object} [log] - Optional logger.
 * @returns {Promise<void>}
 */
export async function notifyForcedTierDowngrade(payload, env, log) {
  const channelId = env?.SLACK_PLG_ONBOARDING_CHANNEL_ID;
  const token = env?.SLACK_BOT_TOKEN;
  if (!channelId || !token) {
    log?.warn?.('FORCE_TIER_DOWNGRADE_ALERT: PLG channel/token not configured — skipping alert');
    return;
  }
  try {
    await postSlackMessage(channelId, formatMessage(payload), token);
  } catch (e) {
    // Fire-and-forget: alerting must never affect the onboard's own outcome.
    log?.warn?.(`FORCE_TIER_DOWNGRADE_ALERT: failed to post Slack alert: ${e?.message}`);
  }
}
