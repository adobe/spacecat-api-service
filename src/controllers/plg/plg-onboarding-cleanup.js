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

import { Suggestion as SuggestionModel } from '@adobe/spacecat-shared-data-access';

/**
 * Opportunity types that participate in the PLG auto-fix lifecycle.
 * Kept in sync with the LD auto-fix flags and the displacement check
 * in plg-onboarding.js (PLG_OPPORTUNITY_TYPES).
 */
export const PLG_CLEANUP_OPPORTUNITY_TYPES = ['cwv', 'alt-text', 'broken-backlinks'];

/**
 * Suggestions in any of these statuses are transitioned to OUTDATED on re-onboarding
 * so the next audit run starts from a clean slate without re-surfacing prior-lifecycle
 * wins (FIXED), in-flight work (IN_PROGRESS), or terminal/dismissed entries
 * (SKIPPED, ERROR, REJECTED).
 */
export const STATUSES_TO_OUTDATE = new Set([
  SuggestionModel.STATUSES.FIXED,
  SuggestionModel.STATUSES.IN_PROGRESS,
  SuggestionModel.STATUSES.SKIPPED,
  SuggestionModel.STATUSES.ERROR,
  SuggestionModel.STATUSES.REJECTED,
]);

/**
 * Suggestions in any of these statuses are reset to NEW on re-onboarding so they
 * re-enter the normal pipeline rather than stay stuck in a mid-flight state from the
 * previous lifecycle.
 */
export const STATUSES_TO_RESET_TO_NEW = new Set([
  SuggestionModel.STATUSES.PENDING_VALIDATION,
]);

/**
 * Bulk-transitions the given suggestions to `targetStatus`. No-op when the input is
 * empty. Failures are logged and swallowed — cleanup is best-effort.
 *
 * @param {object} Suggestion - Suggestion collection from dataAccess.
 * @param {Array} suggestions - Suggestion model instances to transition.
 * @param {string} targetStatus - The target Suggestion status.
 * @param {string} opportunityType - Opportunity type, for logging.
 * @param {string} opportunityId - Opportunity id, for logging.
 * @param {object} log - Logger.
 * @returns {Promise<number>} Count of suggestions transitioned (0 on failure / no-op).
 */
async function bulkTransitionSuggestions(
  Suggestion,
  suggestions,
  targetStatus,
  opportunityType,
  opportunityId,
  log,
) {
  if (suggestions.length === 0) {
    return 0;
  }
  try {
    await Suggestion.bulkUpdateStatus(suggestions, targetStatus);
    log.info(
      `PLG cleanup: transitioned ${suggestions.length} ${opportunityType} suggestions to `
      + `${targetStatus} for opportunity ${opportunityId}`,
    );
    return suggestions.length;
  } catch (error) {
    log.warn(
      `PLG cleanup: failed to transition ${opportunityType} suggestions to ${targetStatus} for `
      + `opportunity ${opportunityId}: ${error.message}`,
    );
    return 0;
  }
}

/**
 * Resets all suggestions for the given PLG opportunity to a clean baseline:
 *   - statuses in {@link STATUSES_TO_OUTDATE} → OUTDATED
 *   - statuses in {@link STATUSES_TO_RESET_TO_NEW} → NEW
 *   - everything else (e.g. NEW, APPROVED) is left untouched.
 *
 * Does a single fetch via `allByOpportunityId` and partitions in memory to keep the
 * round-trip count down. Failures are logged and swallowed — cleanup is best-effort.
 *
 * @param {object} opportunity - Opportunity model instance.
 * @param {object} Suggestion - Suggestion collection from dataAccess.
 * @param {object} log - Logger.
 * @returns {Promise<{outdatedCount: number, resetToNewCount: number}>}
 */
async function resetSuggestionsForOpportunity(opportunity, Suggestion, log) {
  const opportunityId = opportunity.getId();
  const opportunityType = opportunity.getType();

  let suggestions;
  try {
    suggestions = await Suggestion.allByOpportunityId(opportunityId);
  } catch (error) {
    log.warn(
      `PLG cleanup: failed to list suggestions for ${opportunityType} opportunity `
      + `${opportunityId}: ${error.message}`,
    );
    return { outdatedCount: 0, resetToNewCount: 0 };
  }

  const toOutdate = suggestions.filter((s) => STATUSES_TO_OUTDATE.has(s.getStatus()));
  const toResetToNew = suggestions.filter((s) => STATUSES_TO_RESET_TO_NEW.has(s.getStatus()));

  // Run both transitions in parallel; each helper isolates its own failure so a single
  // bulk-update error does not block the other transition.
  const [outdatedCount, resetToNewCount] = await Promise.all([
    bulkTransitionSuggestions(
      Suggestion,
      toOutdate,
      SuggestionModel.STATUSES.OUTDATED,
      opportunityType,
      opportunityId,
      log,
    ),
    bulkTransitionSuggestions(
      Suggestion,
      toResetToNew,
      SuggestionModel.STATUSES.NEW,
      opportunityType,
      opportunityId,
      log,
    ),
  ]);

  return { outdatedCount, resetToNewCount };
}

/**
 * Deletes every FixEntity attached to the given PLG opportunity. A FixEntity
 * may be re-created on the next audit run — leaving stale ones around can
 * confuse downstream auto-fix logic that resumes/replays past fixes.
 *
 * Failures are logged and swallowed — cleanup is best-effort.
 *
 * @param {object} opportunity - Opportunity model instance.
 * @param {object} FixEntity - FixEntity collection from dataAccess.
 * @param {object} log - Logger.
 * @returns {Promise<number>} Count of fix entities removed (0 on failure).
 */
async function removeFixEntitiesForOpportunity(opportunity, FixEntity, log) {
  const opportunityId = opportunity.getId();
  const opportunityType = opportunity.getType();
  try {
    const fixEntities = await FixEntity.allByOpportunityId(opportunityId);

    if (fixEntities.length === 0) {
      return 0;
    }

    await FixEntity.removeByIds(fixEntities.map((f) => f.getId()));
    log.info(
      `PLG cleanup: removed ${fixEntities.length} ${opportunityType} fix entities for `
      + `opportunity ${opportunityId}`,
    );
    return fixEntities.length;
  } catch (error) {
    log.warn(
      `PLG cleanup: failed to remove fix entities for ${opportunityType} opportunity `
      + `${opportunityId}: ${error.message}`,
    );
    return 0;
  }
}

/**
 * Cleans up PLG site state right before a `PlgOnboarding` record transitions to
 * `ONBOARDED`. For each PLG opportunity type (cwv, alt-text, broken-backlinks) on
 * the site:
 *   1. Suggestions in {@link STATUSES_TO_OUTDATE} are transitioned to OUTDATED so
 *      stale wins / in-flight / terminal entries from the previous PLG lifecycle do
 *      not re-surface.
 *   2. Suggestions in {@link STATUSES_TO_RESET_TO_NEW} are reset to NEW so they
 *      re-enter the normal pipeline.
 *   3. All associated FixEntity rows are removed so a future re-onboarding starts
 *      from an empty fix history.
 *
 * Non-PLG opportunities (e.g. structured-data, product-meta) are left untouched.
 * This is best-effort: the function never throws and never aborts on partial failure,
 * because callers (onboarding flow) cannot afford to be blocked by cleanup —
 * orphaned fix/suggestion rows can be reconciled out-of-band.
 *
 * @param {string} siteId - The site being (re-)onboarded.
 * @param {object} context - Request context (provides dataAccess + log).
 * @returns {Promise<{outdatedCount: number, resetToNewCount: number, removedFixCount: number}>}
 */
export async function cleanupPlgSiteSuggestionsAndFixes(siteId, context) {
  const { dataAccess, log } = context;
  const { Opportunity, Suggestion, FixEntity } = dataAccess;

  const emptyResult = { outdatedCount: 0, resetToNewCount: 0, removedFixCount: 0 };

  if (!siteId) {
    log.info('PLG cleanup: no siteId provided, skipping');
    return emptyResult;
  }

  let opportunities;
  try {
    opportunities = await Opportunity.allBySiteId(siteId);
  } catch (error) {
    log.warn(`PLG cleanup: failed to list opportunities for site ${siteId}: ${error.message}`);
    return emptyResult;
  }

  const plgOpportunities = opportunities.filter(
    (o) => PLG_CLEANUP_OPPORTUNITY_TYPES.includes(o.getType()),
  );

  if (plgOpportunities.length === 0) {
    log.info(`PLG cleanup: no PLG opportunities found for site ${siteId}`);
    return emptyResult;
  }

  // Process each opportunity in parallel; per-opportunity helpers swallow their own
  // errors so one failure cannot abort the rest of the cleanup.
  const results = await Promise.all(plgOpportunities.map(async (opportunity) => {
    const [{ outdatedCount, resetToNewCount }, removedFixCount] = await Promise.all([
      resetSuggestionsForOpportunity(opportunity, Suggestion, log),
      removeFixEntitiesForOpportunity(opportunity, FixEntity, log),
    ]);
    return { outdatedCount, resetToNewCount, removedFixCount };
  }));

  const totals = results.reduce(
    (acc, r) => ({
      outdatedCount: acc.outdatedCount + r.outdatedCount,
      resetToNewCount: acc.resetToNewCount + r.resetToNewCount,
      removedFixCount: acc.removedFixCount + r.removedFixCount,
    }),
    { ...emptyResult },
  );

  log.info(
    `PLG cleanup complete for site ${siteId}: marked ${totals.outdatedCount} suggestions OUTDATED, `
    + `reset ${totals.resetToNewCount} suggestions to NEW, removed ${totals.removedFixCount} fix `
    + `entities across ${plgOpportunities.length} opportunities`,
  );

  return totals;
}
