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
 * Marks every FIXED suggestion under the given PLG opportunity as OUTDATED.
 * FIXED suggestions represent past customer wins; once the site is offboarded
 * we want the next audit run to start from a clean slate rather than re-surface
 * stale "fixed" entries.
 *
 * Failures are logged and swallowed — cleanup is best-effort and must never
 * block the higher-level offboarding flow.
 *
 * @param {object} opportunity - Opportunity model instance.
 * @param {object} Suggestion - Suggestion collection from dataAccess.
 * @param {object} log - Logger.
 * @returns {Promise<number>} Count of suggestions transitioned (0 on failure).
 */
async function outdateFixedSuggestionsForOpportunity(opportunity, Suggestion, log) {
  const opportunityId = opportunity.getId();
  const opportunityType = opportunity.getType();
  try {
    const fixedSuggestions = await Suggestion.allByOpportunityIdAndStatus(
      opportunityId,
      SuggestionModel.STATUSES.FIXED,
    );

    if (fixedSuggestions.length === 0) {
      return 0;
    }

    await Suggestion.bulkUpdateStatus(fixedSuggestions, SuggestionModel.STATUSES.OUTDATED);
    log.info(
      `PLG cleanup: marked ${fixedSuggestions.length} ${opportunityType} suggestions as OUTDATED `
      + `for opportunity ${opportunityId}`,
    );
    return fixedSuggestions.length;
  } catch (error) {
    log.warn(
      `PLG cleanup: failed to mark FIXED suggestions OUTDATED for ${opportunityType} opportunity `
      + `${opportunityId}: ${error.message}`,
    );
    return 0;
  }
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
 * Cleans up PLG site state when a site is offboarded (waitlisted from ONBOARDED, or
 * displaced by a new domain in the same IMS org). For each PLG opportunity type
 * (cwv, alt-text, broken-backlinks) on the site:
 *   1. FIXED suggestions are transitioned to OUTDATED so the site does not retain
 *      stale "fixed" wins from the previous engagement.
 *   2. All associated FixEntity rows are removed so a future re-onboarding starts
 *      from an empty fix history.
 *
 * Non-PLG opportunities (e.g. structured-data, product-meta) are left untouched.
 * This is best-effort: the function never throws and never aborts on partial failure,
 * because callers (offboarding/displacement flows) cannot afford to be blocked by
 * cleanup — orphaned fix/suggestion rows can be reconciled out-of-band.
 *
 * @param {string} siteId - The offboarded site's id.
 * @param {object} context - Request context (provides dataAccess + log).
 * @returns {Promise<{outdatedCount: number, removedFixCount: number}>}
 */
export async function cleanupPlgSiteSuggestionsAndFixes(siteId, context) {
  const { dataAccess, log } = context;
  const { Opportunity, Suggestion, FixEntity } = dataAccess;

  if (!siteId) {
    log.info('PLG cleanup: no siteId provided, skipping');
    return { outdatedCount: 0, removedFixCount: 0 };
  }

  let opportunities;
  try {
    opportunities = await Opportunity.allBySiteId(siteId);
  } catch (error) {
    log.warn(`PLG cleanup: failed to list opportunities for site ${siteId}: ${error.message}`);
    return { outdatedCount: 0, removedFixCount: 0 };
  }

  const plgOpportunities = opportunities.filter(
    (o) => PLG_CLEANUP_OPPORTUNITY_TYPES.includes(o.getType()),
  );

  if (plgOpportunities.length === 0) {
    log.info(`PLG cleanup: no PLG opportunities found for site ${siteId}`);
    return { outdatedCount: 0, removedFixCount: 0 };
  }

  // Process each opportunity in parallel; per-opportunity helpers swallow their own
  // errors so one failure cannot abort the rest of the cleanup.
  const results = await Promise.all(plgOpportunities.map(async (opportunity) => {
    const [outdatedCount, removedFixCount] = await Promise.all([
      outdateFixedSuggestionsForOpportunity(opportunity, Suggestion, log),
      removeFixEntitiesForOpportunity(opportunity, FixEntity, log),
    ]);
    return { outdatedCount, removedFixCount };
  }));

  const totals = results.reduce(
    (acc, r) => ({
      outdatedCount: acc.outdatedCount + r.outdatedCount,
      removedFixCount: acc.removedFixCount + r.removedFixCount,
    }),
    { outdatedCount: 0, removedFixCount: 0 },
  );

  log.info(
    `PLG cleanup complete for site ${siteId}: marked ${totals.outdatedCount} suggestions OUTDATED, `
    + `removed ${totals.removedFixCount} fix entities across ${plgOpportunities.length} opportunities`,
  );

  return totals;
}
