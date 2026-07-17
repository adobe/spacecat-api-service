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

import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js';
import TierClient from '@adobe/spacecat-shared-tier-client';

const LLMO_PRODUCT_CODE = EntitlementModel.PRODUCT_CODES.LLMO;

// Cadence labels accepted by DRS `createSchedule` for the recurring
// "prompt suggestion" pipelines (the `SCHEDULE_CADENCES` enum in the drs-client).
// DRS derives the concrete cron expression server-side from the label
// (frequency:'cron', with per-site hour jitter for twice_monthly) — we never send
// raw cron, so a misconfigured/leaked caller cannot schedule a fleet-wide Fargate
// storm; an unknown value is rejected server-side.
//   'twice_monthly' → 1st & 15th (honest label; not a true 14-day interval)
//   'quarterly'     → 1st of Jan/Apr/Jul/Oct
// Kept as local literals (matching SCHEDULE_CADENCES values) so this module loads
// against the currently-installed client; can be swapped for the imported
// SCHEDULE_CADENCES const once drs-client 1.14.0 is installed.
// See local/drs-prompt-suggestions-schedules-onboarding-plan.md ("Cadence expression").
const DRS_CADENCE_TWICE_MONTHLY = 'twice_monthly';
const DRS_CADENCE_QUARTERLY = 'quarterly';

// The recurring "prompt suggestion" pipelines registered for every paying LLMO
// site. Each providerId+cadence pair is declared exactly once here and iterated
// by ensurePromptSuggestionSchedules, so adding a pipeline is a one-line change
// and no per-provider code can drift out of sync.
//
// NOTE on `prompt_generation_agentic_traffic` ("citation attempts"): "Citation
// Attempt" is the renamed *output* of the agentic-traffic pipeline — there is no
// standalone citation-attempt provider — so this id will NOT grep from the word
// "citation". DRS's per-provider Fargate whitelist (`AT_FARGATE_WHITELIST`) is
// the real enablement gate; leave agentic-traffic un-whitelisted in an env until
// its Postgres-format migration is confirmed healthy (plan Phase 0.2) so the
// best-effort first run cannot automate a known-failing pipeline.
export const PROMPT_SUGGESTION_PIPELINES = [
  { name: 'SEMrush prompts', providerId: 'prompt_generation_semrush', cadence: DRS_CADENCE_TWICE_MONTHLY },
  { name: 'citation attempts', providerId: 'prompt_generation_agentic_traffic', cadence: DRS_CADENCE_TWICE_MONTHLY },
  { name: 'synthetic personas', providerId: 'prompt_generation_synthetic_personas', cadence: DRS_CADENCE_QUARTERLY },
];

/**
 * Reports whether a site is on the paying (PAID) LLMO tier, which decides the
 * prompt-suggestion behavior: PAID → a recurring schedule; anything else
 * (FREE_TRIAL, or an entitlement that cannot be read) → a single on-demand run
 * (onboarding path only) / skipped (re-provision endpoint).
 *
 * Fails safe to trial: if the current LLMO entitlement is absent or the lookup
 * throws, this returns `false` (and logs a WARN) rather than assuming PAID, so a
 * site whose paying status is unknown never gets a recurring, fleet-wide Fargate
 * schedule.
 *
 * @param {object} site - The SpaceCat site model.
 * @param {object} context - The request context (passed to TierClient).
 * @returns {Promise<boolean>} True only when the current LLMO tier is PAID.
 */
export async function isPayingLlmoSite(site, context) {
  const { log } = context;
  try {
    const tierClient = await TierClient.createForSite(context, site, LLMO_PRODUCT_CODE);
    const { entitlement } = await tierClient.checkValidEntitlement();
    if (!entitlement) {
      log.warn(`Could not determine LLMO tier for site ${site.getId()} `
        + '(no entitlement found); defaulting to one-time (trial) prompt-suggestion runs');
      return false;
    }
    return entitlement.getTier() === EntitlementModel.TIERS.PAID;
  } catch (error) {
    log.warn(`Failed to read LLMO tier for site ${site.getId()}; `
      + `defaulting to one-time (trial) prompt-suggestion runs: ${error.message}`);
    return false;
  }
}

/**
 * Runs one prompt-suggestion provider for a site, tier-gated. Shared body for
 * {@link ensurePromptSuggestionSchedules}.
 *
 * - **Paying (`isPaying === true`)**: registers a recurring DRS schedule
 *   (`createSchedule`) with an immediate first run.
 * - **Trial / non-paying (any other value)**: submits a single on-demand run
 *   (`submitJob`) with NO recurring schedule. These three providers are
 *   on-demand-capable, so a one-shot job is valid and gives a trial site its
 *   first suggestions without committing recurring Fargate load.
 *
 * Split error semantics: the immediate first run is best-effort — if it produces
 * nothing (e.g. brand/base-prompt data not present yet) the next scheduled run
 * (paying) self-heals. A `createSchedule` (schedule REGISTRATION) failure is NOT
 * best-effort: the site would never get a recurring schedule and nothing
 * self-heals, so it propagates to the caller. This helper therefore does not
 * swallow the failure itself; {@link ensurePromptSuggestionSchedules} catches it
 * per-pipeline and records a 'failed' status. The one-shot `submitJob` failure is
 * handled the same way (propagated, recorded by the caller) so both paths share
 * one per-pipeline try/catch.
 *
 * NOTE: `createSchedule` derives the tenant-isolation key from `siteId`
 * server-side and REJECTS any caller-supplied imsOrgId, so we deliberately do not
 * thread imsOrgId/orgId into it.
 *
 * @param {object} params
 * @param {object} params.drsClient - Configured DRS client.
 * @param {string} params.providerId - DRS provider id to schedule/run.
 * @param {string} params.cadence - One of DRS_CADENCE_* labels (paying path only).
 * @param {string} params.siteId - SpaceCat site UUID.
 * @param {boolean} params.isPaying - True → recurring schedule; else one-shot run.
 * @param {object} params.log - Logger.
 * @param {Function} [params.say] - Optional Slack say callback.
 * @returns {Promise<object|null>} The createSchedule/submitJob result, or null when
 *   DRS is not configured.
 */
export async function registerPromptSuggestionSchedule({
  drsClient, providerId, cadence, siteId, isPaying, log, say = () => {},
}) {
  if (!drsClient.isConfigured()) {
    log.debug(`DRS client not configured, skipping ${providerId} schedule for site ${siteId}`);
    return null;
  }

  // Trial / non-paying (or indeterminate tier): run the pipeline ONCE via an
  // on-demand submitJob, with no recurring schedule.
  if (!isPaying) {
    const job = await drsClient.submitJob({
      provider_id: providerId,
      source: 'onboarding',
      priority: 'HIGH',
      parameters: { siteId },
    });
    log.info(`Submitted one-time DRS ${providerId} run (trial site) `
      + `job=${job?.job_id ?? 'unknown'} for site ${siteId}`);
    say(`:zap: Submitted one-time DRS ${providerId} run (trial site) for site ${siteId}`);
    return job;
  }

  // Paying (PAID): register the recurring schedule with an immediate first run.
  // Default enable_brand_presence off (plan Phase 0.4): these prompt-suggestion
  // pipelines must not push unexpected load into the brand-presence pipeline / SNS
  // allowlist unless a site is explicitly BP-enabled. `providerIds` is an array
  // (the job_config.provider_ids envelope) even for a single-provider pipeline.
  const result = await drsClient.createSchedule({
    siteId,
    providerIds: [providerId],
    cadence,
    description: `${providerId} prompt-suggestion schedule (onboarding)`,
    enableBrandPresence: false,
    triggerImmediately: true,
  });

  log.info(`Registered DRS ${providerId} schedule ${result?.scheduleId ?? 'unknown'} `
    + `(cadence=${cadence}) for site ${siteId}${result?.alreadyExisted ? ' (already existed)' : ''}`);
  say(`:calendar_spiral: Registered DRS ${providerId} schedule for site ${siteId}`);
  return result;
}

/**
 * Idempotently ensures every prompt-suggestion pipeline (see
 * {@link PROMPT_SUGGESTION_PIPELINES}) is provisioned for a site, tier-gated:
 * paying sites get a recurring schedule (immediate first run), trial/non-paying
 * sites get a single on-demand run per pipeline (no recurring schedule). See
 * {@link registerPromptSuggestionSchedule}.
 *
 * Error ownership is single-layer: each pipeline is wrapped in its own try/catch
 * that owns the failure (logs at ERROR + emits an operator Slack signal) and
 * never rethrows, so one pipeline's failure (schedule REGISTRATION on the paying
 * path, or the one-shot submit on the trial path) neither aborts the batch nor
 * masks the other pipelines. Because no callback rejects, the pipelines run under
 * `Promise.all` (not `allSettled`).
 *
 * Failure contract: instead of an opaque sentinel, this returns per-pipeline
 * results so callers (the onboarding side-effect, the re-provision endpoint, a
 * reconciler) can report real outcomes:
 *
 *   {
 *     results: [{ providerId, status, error? }],
 *     allSucceeded: boolean,
 *   }
 *
 * `status` is one of: 'created' (new recurring schedule), 'already-existed'
 * (idempotent no-op — treated as success), 'submitted' (trial one-shot run), or
 * 'failed' (with `error`). `allSucceeded` is true iff no pipeline failed. A
 * not-configured DRS client short-circuits to `{ results: [], allSucceeded: true }`.
 *
 * @param {object} params
 * @param {object} params.drsClient - Configured DRS client.
 * @param {string} params.siteId - SpaceCat site UUID.
 * @param {boolean} params.isPaying - True → recurring schedules; else one-shot runs.
 * @param {object} params.log - Logger.
 * @param {Function} [params.say] - Optional Slack say callback.
 * @returns {Promise<{results: Array<object>, allSucceeded: boolean}>} Per-pipeline
 *   results ({providerId, status, error?}) and an aggregate success flag.
 */
export async function ensurePromptSuggestionSchedules({
  drsClient, siteId, isPaying, log, say = () => {},
}) {
  // Short-circuit once for an unconfigured client instead of letting each
  // per-pipeline registerPromptSuggestionSchedule log "not configured" N times.
  if (!drsClient.isConfigured()) {
    log.debug(`DRS client not configured, skipping prompt-suggestion schedules for site ${siteId}`);
    return { results: [], allSucceeded: true };
  }

  const results = await Promise.all(
    PROMPT_SUGGESTION_PIPELINES.map(async ({ name, providerId, cadence }) => {
      try {
        const result = await registerPromptSuggestionSchedule({
          drsClient, providerId, cadence, siteId, isPaying, log, say,
        });
        // Map the raw DRS result to a per-pipeline status. already-existed is an
        // idempotent no-op and counts as success.
        let status;
        if (!isPaying) {
          status = 'submitted';
        } else if (result?.alreadyExisted) {
          status = 'already-existed';
        } else {
          status = 'created';
        }
        return { providerId, status };
      } catch (scheduleError) {
        // Pipeline REGISTRATION/SUBMIT failure (distinct from the best-effort
        // immediate run): on the paying path the site would never get a recurring
        // schedule and nothing self-heals; on the trial path the one-shot run
        // never fires. Either way, surface it loudly with full context. The batch
        // still completes, mirroring the brand-activation side-effect handling in
        // brands.js (activateBrand). `status` is the upstream HTTP status when the
        // DRS client attaches one, else 'unknown'.
        const status = scheduleError.status ?? 'unknown';
        // Wording tracks the branch: paying → createSchedule (recurring schedule),
        // trial/non-paying → submitJob (one-shot run). "schedule" alone would
        // misdescribe the trial-path failure.
        const mode = isPaying ? 'schedule' : 'one-shot run';
        log.error(`Failed to run/register DRS ${name} prompt-suggestion (${mode}) `
          + `provider_id=${providerId} site_id=${siteId} status=${status}: ${scheduleError.message}`);
        say(`:warning: Failed to run/register DRS ${name} prompt-suggestion (${mode}) `
          + `for site ${siteId} (will need manual trigger)`);
        return { providerId, status: 'failed', error: scheduleError.message };
      }
    }),
  );

  const allSucceeded = results.every((r) => r.status !== 'failed');
  return { results, allSucceeded };
}
