/*
 * Copyright 2025 Adobe. All rights reserved.
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
import { getTokenGrantConfigByOpportunity } from '@adobe/spacecat-shared-utils';

/**
 * Default sort: by rank ascending, then id ascending.
 */
function defaultSortFn(groupA, groupB) {
  const a = groupA[0];
  const b = groupB[0];
  const rankA = typeof a?.getRank === 'function' ? a.getRank() : (a?.rank ?? 0);
  const rankB = typeof b?.getRank === 'function' ? b.getRank() : (b?.rank ?? 0);
  if (rankA !== rankB) return rankA - rankB;
  const idA = typeof a?.getId === 'function' ? a.getId() : (a?.id ?? '');
  const idB = typeof b?.getId === 'function' ? b.getId() : (b?.id ?? '');
  return idA.localeCompare(idB);
}

/**
 * Per-opportunity grouping and sorting strategies.
 * Each entry can define `groupFn` and/or `sortFn`.
 * Opportunities not listed here use the defaults
 * (one group per suggestion, sorted by rank asc then id asc).
 */
const OPPORTUNITY_STRATEGIES = {
  // Example: group broken-backlinks suggestions by source URL
  // 'broken-backlinks': {
  //   groupFn: (suggestions) => { ... },
  //   sortFn: (groupA, groupB) => { ... },
  // },
};

/**
 * Groups and sorts suggestions for grant selection.
 * Each group consumes one token when granted.
 * Uses per-opportunity strategies from OPPORTUNITY_STRATEGIES,
 * falling back to default (one group per suggestion, rank asc).
 *
 * @param {Array} suggestions - Suggestion entities or plain objects.
 * @param {string} [opportunityName] - Opportunity name for
 *   strategy lookup.
 * @returns {Array<Array>} Sorted groups of suggestions.
 */
export function getTopSuggestions(suggestions, opportunityName) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return [];
  }
  const strategy = OPPORTUNITY_STRATEGIES[opportunityName] || {};
  const { groupFn, sortFn } = strategy;
  // c8 ignore: groupFn branch covered when strategies are added
  const groups = groupFn
    ? groupFn(suggestions) /* c8 ignore next */
    : suggestions.map((s) => [s]);
  return [...groups].sort(sortFn ?? defaultSortFn);
}

/**
 * Grants top ungranted suggestions for an opportunity. Ensures a
 * token exists for the current cycle; if none, creates one with
 * total = (config max) minus already-granted count. Then grants
 * top ungranted groups up to the remaining token count.
 *
 * @param {Object} dataAccess - Data access collections.
 * @param {Object} site - Site model (getId()).
 * @param {Object} opportunity - Opportunity model
 *   (getId(), getType()).
 * @returns {Promise<void>}
 */
export async function grantSuggestionsForOpportunity(dataAccess, site, opportunity) {
  const Suggestion = dataAccess?.Suggestion;
  const Token = dataAccess?.Token;
  const siteId = site?.getId();
  const opptyId = opportunity?.getId();
  const oppType = opportunity?.getType();
  const config = oppType
    ? getTokenGrantConfigByOpportunity(oppType) : null;
  const tokenType = config?.tokenType;

  if (!Suggestion || !Token || !siteId || !opptyId || !config) return;

  const { STATUSES } = SuggestionModel;
  const newSuggestions = await Suggestion
    .allByOpportunityIdAndStatus(opptyId, STATUSES.NEW);
  const newSuggestionIds = newSuggestions.map((s) => s.getId());
  if (!newSuggestionIds.length) return;

  let token = await Token.findBySiteIdAndTokenType(siteId, tokenType);
  if (!token) {
    const { grantIds } = await Suggestion
      .splitSuggestionsByGrantStatus(newSuggestionIds);
    const suppliedTotal = Math.max(1, config.tokensPerCycle - (grantIds?.length ?? 0));
    token = await Token.findBySiteIdAndTokenType(siteId, tokenType, {
      createIfNotFound: true,
      total: suppliedTotal,
    });
  }

  const remaining = token.getRemaining();
  if (remaining <= 0) return;

  const { notGrantedIds } = await Suggestion
    .splitSuggestionsByGrantStatus(newSuggestionIds);
  const notGrantedEntities = newSuggestions
    .filter((s) => notGrantedIds.includes(s.getId()));
  const topGroups = getTopSuggestions(notGrantedEntities, oppType)
    .slice(0, remaining);
  await Promise.all(
    topGroups.map((group) => {
      const ids = group.map((s) => s.getId()).filter(Boolean);
      return ids.length > 0
        ? Suggestion.grantSuggestions(ids, siteId, tokenType)
        : Promise.resolve();
    }),
  );
}
