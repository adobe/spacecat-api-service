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

// The PLG opportunity types that are relevant for the displacement check.
// Must stay in sync with LD_AUTO_FIX_FLAGS in plg-onboarding.js, which enables auto-fix for the
// same types.
export const PLG_OPPORTUNITY_TYPES = ['cwv', 'alt-text', 'broken-backlinks'];

const IGNORED_SUGGESTION_STATUSES = new Set(['PENDING_VALIDATION', 'OUTDATED']);

/**
 * Returns true if the given site has suggestions that should block displacement.
 * Blocks displacement if any PLG opportunity (cwv, alt-text, broken-backlinks) has
 * suggestions in any status except PENDING_VALIDATION or OUTDATED — meaning the customer
 * has engaged with the suggestions (NEW, IN_PROGRESS, FIXED, SKIPPED, etc.).
 * Returns true (conservative) on any lookup failure so we never accidentally displace
 * a site that may still have active work.
 */
export async function hasActiveSuggestions(siteId, dataAccess, log) {
  const { Opportunity, Suggestion } = dataAccess;
  try {
    const opportunities = await Opportunity.allBySiteId(siteId);
    const plgOpportunities = opportunities.filter(
      (o) => PLG_OPPORTUNITY_TYPES.includes(o.getType()),
    );

    if (plgOpportunities.length === 0) {
      return false;
    }

    const suggestionLists = await Promise.all(
      plgOpportunities.map((o) => Suggestion.allByOpportunityId(o.getId())),
    );

    return suggestionLists.some(
      (suggestions) => suggestions.some(
        (s) => !IGNORED_SUGGESTION_STATUSES.has(s.getStatus()),
      ),
    );
  } catch (error) {
    log.warn(`Failed to check PLG suggestions for site ${siteId}: ${error.message}`);
    return true; // conservative: do not displace if check fails
  }
}
