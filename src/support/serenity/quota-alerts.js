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

/**
 * Internal Slack alerting for Serenity AI-resource quota exhaustion (serenity-docs#72 §5).
 *
 * Mechanism: a direct, fire-and-forget Slack post from the rejection site (the spec's option 2 —
 * "a direct best-effort Slack post from the rejection site... elevated Slack client already
 * available in the request context"). A CloudWatch-alarm-on-metric route (option 1) is preferred
 * by the spec for zero request-path code, but this repo has no infra-as-code surface reachable
 * from an application PR to wire that alarm, so this module is the code-only path available here.
 *
 * Global kill-switch (`SERENITY_QUOTA_ALERTS_ENABLED`, default OFF) mirrors the existing
 * `SERENITY_*` env-flag pattern (dynamic-allocation-active.js, rest-transport.js) — adding this
 * capability is not the same as turning it on; ops configure the channel/token and flip it.
 *
 * Dedup (§5: "repeated attempts by the same org+brand+case within a window collapse into one
 * alert with an attempt counter"): an in-memory, module-scoped Map, keyed by
 * `orgId:brandId:caseType:dimension`. The FIRST rejection in a window posts immediately; every
 * later one in the same window is silently tallied (no re-post) — "a customer clicking retry
 * five times is one sales signal, not five pages." This is warm-Lambda-container-scoped state
 * (no DynamoDB/persistent store), the same shape as this codebase's existing per-container caches
 * (markets.js's language cache, resource-lock.js's in-process lock) — sufficient for collapsing a
 * rapid retry burst, not a cross-invocation guarantee.
 */

import { postSlackMessage } from '../../utils/slack/base.js';

/** @typedef {'brandCarveExhausted'|'orgPoolExhausted'|'brandAiLimit'} QuotaCase */

export const DEDUP_WINDOW_MS = 15 * 60 * 1000;

/** @type {Map<string, { count: number, firstAt: number }>} */
const seen = new Map();

/** Test-only reset — mirrors `clearLanguageCache` / `clearResourceLocks` in this module family. */
export function clearQuotaAlertDedup() {
  seen.clear();
}

function isEnabled(env) {
  return env?.SERENITY_QUOTA_ALERTS_ENABLED === 'true';
}

/**
 * @param {object} p
 * @param {string | null} [p.orgId]
 * @param {string | null} [p.brandId]
 * @param {string} [p.workspaceId]
 * @param {string} p.caseType
 * @param {string} [p.dimension]
 */
function dedupeKey({
  orgId, brandId, workspaceId, caseType, dimension,
}) {
  // workspaceId is included so call sites that cannot thread org/brand context down this deep
  // (some prompt/model handlers) still dedupe PER TENANT rather than collapsing every org/brand
  // hitting the same case+dimension into one bucket when orgId/brandId are both absent.
  return `${orgId || 'unknown'}:${brandId || workspaceId || 'unknown'}:${caseType}:${dimension || 'unknown'}`;
}

/**
 * @param {object} p
 * @param {number} p.count attempts collapsed into this alert.
 * @param {string} [p.orgId]
 * @param {string} [p.brandId]
 * @param {string} [p.workspaceId]
 * @param {string} [p.market] e.g. "US/en"
 * @param {QuotaCase} p.caseType
 * @param {'projects'|'prompts'} [p.dimension]
 * @param {number} [p.attempted] units the rejected operation needed.
 * @param {number} [p.used]
 * @param {number} [p.carved] sum of child carves against the pool (org-pool case only).
 * @param {number} [p.total]
 * @returns {string}
 */
function formatMessage({
  count, orgId, brandId, workspaceId, market, caseType, dimension, attempted, used, carved, total,
}) {
  const lines = [
    `:rotating_light: *Serenity quota rejection* — \`${caseType}\`${count > 1 ? ` (×${count} in the last ${Math.round(DEDUP_WINDOW_MS / 60000)}m)` : ''}`,
    `• Org: \`${orgId || 'unknown'}\`  Brand: \`${brandId || 'unknown'}\`${workspaceId ? `  Workspace: \`${workspaceId}\`` : ''}`,
  ];
  if (market) {
    lines.push(`• Market: \`${market}\``);
  }
  if (dimension) {
    lines.push(`• Dimension: \`${dimension}\`  Attempted: \`${attempted ?? 'n/a'}\``);
  }
  if (used !== undefined || total !== undefined) {
    const carvedPart = carved !== undefined ? `  Carved: \`${carved}\`` : '';
    lines.push(`• used: \`${used ?? 'n/a'}\`${carvedPart}  total: \`${total ?? 'n/a'}\``);
  }
  lines.push(`• ${new Date().toISOString()}`);
  return lines.join('\n');
}

/**
 * Alerts on a single quota rejection event (any of the three cases, §2 — including the
 * deliberately-swallowed best-effort provisioning rejection, §5 bullet 2: "That swallow is still
 * a quota rejection... MUST emit the same (deduplicated) alert, marked as originating from the
 * best-effort provisioning path"). Fire-and-forget: never throws, never affects the caller's
 * response — a Slack failure is logged, not propagated.
 *
 * `payload` is the same shape {@link formatMessage} takes (minus `count`, added here), plus an
 * optional `swallowed: boolean` — true when this rejection was absorbed by a best-effort caller
 * rather than returned to the customer as an error (still alerts, per §5).
 *
 * @param {object} payload
 * @param {object} env
 * @param {object} [log]
 * @returns {Promise<void>}
 */
export async function alertQuotaRejection(payload, env, log) {
  if (!isEnabled(env)) {
    return;
  }
  const key = dedupeKey(payload);
  const now = Date.now();
  const entry = seen.get(key);
  if (entry && now - entry.firstAt < DEDUP_WINDOW_MS) {
    entry.count += 1;
    return;
  }
  seen.set(key, { count: 1, firstAt: now });

  const channelId = env?.SERENITY_QUOTA_ALERTS_SLACK_CHANNEL_ID;
  const token = env?.SLACK_BOT_TOKEN;
  if (!channelId || !token) {
    log?.warn?.('SERENITY_QUOTA_ALERT: channel/token not configured — skipping Slack post', { key });
    return;
  }
  try {
    const message = formatMessage({ ...payload, count: 1 })
      + (payload.swallowed ? '\n• _originates from a best-effort provisioning swallow — no customer-visible error_' : '');
    await postSlackMessage(channelId, message, token);
  } catch (e) {
    // Fire-and-forget: alerting must never affect the API response or the rejection's own outcome.
    log?.warn?.('SERENITY_QUOTA_ALERT: failed to post Slack alert', { key, error: e?.message });
  }
}

/**
 * Alerts that a §4.1 atomicity rollback itself failed — "a rollback that itself fails is
 * alerted as an engineering defect (residual draft prompts, §5), never silently logged." This
 * is a DISTINCT signal from a routine quota rejection: it means a prompt this request staged is
 * now STRANDED as a live, unpublished draft upstream (the exact state the rollback exists to
 * prevent), not that a customer hit their limit. Fire-and-forget, same as {@link
 * alertQuotaRejection}; gated on the same kill-switch/channel config since there is no separate
 * incident-alerting destination in this codebase.
 *
 * @param {object} p
 * @param {string | null} [p.orgId]
 * @param {string | null} [p.brandId]
 * @param {string} p.workspaceId
 * @param {string} p.projectId
 * @param {string[]} p.semrushPromptIds the ids that could not be deleted — still live upstream.
 * @param {string} [p.rollbackError] the delete call's own failure message (already redacted by
 *   the caller — never pass a raw upstream error here).
 * @param {object} env
 * @param {object} [log]
 * @returns {Promise<void>}
 */
export async function alertRollbackFailure({
  orgId, brandId, workspaceId, projectId, semrushPromptIds, rollbackError,
}, env, log) {
  if (!isEnabled(env)) {
    return;
  }
  // Distinct dedup key (own caseType) so this never collapses into, or gets suppressed by, an
  // ordinary quota-rejection alert's window for the same org/brand.
  const key = dedupeKey({
    orgId, brandId, workspaceId, caseType: 'rollbackFailed', dimension: 'prompts',
  });
  const now = Date.now();
  const entry = seen.get(key);
  if (entry && now - entry.firstAt < DEDUP_WINDOW_MS) {
    entry.count += 1;
    return;
  }
  seen.set(key, { count: 1, firstAt: now });

  const channelId = env?.SERENITY_QUOTA_ALERTS_SLACK_CHANNEL_ID;
  const token = env?.SLACK_BOT_TOKEN;
  if (!channelId || !token) {
    log?.warn?.('SERENITY_QUOTA_ALERT: channel/token not configured — skipping rollback-failure post', { key });
    return;
  }
  try {
    const message = [
      ':rotating_light: *Serenity quota-rollback FAILED — stranded draft prompts* :bug:',
      `• Org: \`${orgId || 'unknown'}\`  Brand: \`${brandId || 'unknown'}\`  Workspace: \`${workspaceId}\``,
      `• Project: \`${projectId}\`  Prompt ids (still live, unpublished): \`${semrushPromptIds.join(', ')}\``,
      `• Rollback error: \`${rollbackError || 'n/a'}\``,
      `• ${new Date().toISOString()}`,
    ].join('\n');
    await postSlackMessage(channelId, message, token);
  } catch (e) {
    log?.warn?.('SERENITY_QUOTA_ALERT: failed to post rollback-failure alert', { key, error: e?.message });
  }
}

/**
 * Early-warning alert (§5, in addition to the hard-exhaustion alert above): fires when the org
 * pool's free capacity drops below a configurable fraction — "so the account team can be engaged
 * *before* the customer hits the wall." Consumes the SAME advisory pool-free read
 * `ensureAiHeadroom` already performs on every top-up (`recordPoolFreeRatio`'s call site);
 * see resource-manager.js.
 *
 * @param {object} p
 * @param {string | null | undefined} [p.orgId]
 * @param {string} p.parentWorkspaceId
 * @param {'projects'|'prompts'} p.dimension
 * @param {number} p.free
 * @param {number} p.total
 * @param {object} env
 * @param {object} [log]
 * @returns {Promise<void>}
 */
export async function alertPoolFreeThreshold({
  orgId, parentWorkspaceId, dimension, free, total,
}, env, log) {
  if (!isEnabled(env)) {
    return;
  }
  const thresholdFraction = Number(env?.SERENITY_POOL_FREE_ALERT_THRESHOLD ?? 0.1);
  if (!(total > 0) || free / total >= thresholdFraction) {
    return;
  }
  const key = dedupeKey({
    orgId: orgId || parentWorkspaceId, brandId: 'org-pool', caseType: 'poolFreeThreshold', dimension,
  });
  const now = Date.now();
  const entry = seen.get(key);
  if (entry && now - entry.firstAt < DEDUP_WINDOW_MS) {
    entry.count += 1;
    return;
  }
  seen.set(key, { count: 1, firstAt: now });

  const channelId = env?.SERENITY_QUOTA_ALERTS_SLACK_CHANNEL_ID;
  const token = env?.SLACK_BOT_TOKEN;
  if (!channelId || !token) {
    log?.warn?.('SERENITY_QUOTA_ALERT: channel/token not configured — skipping pool-free threshold post', { key });
    return;
  }
  try {
    const pct = Math.round((free / total) * 100);
    const message = [
      ':warning: *Serenity org pool free capacity below threshold*',
      `• Parent workspace: \`${parentWorkspaceId}\`  Dimension: \`${dimension}\``,
      `• free: \`${free}\` / total: \`${total}\` (${pct}%, threshold ${Math.round(thresholdFraction * 100)}%)`,
      `• ${new Date().toISOString()}`,
    ].join('\n');
    await postSlackMessage(channelId, message, token);
  } catch (e) {
    log?.warn?.('SERENITY_QUOTA_ALERT: failed to post pool-free threshold alert', { key, error: e?.message });
  }
}
