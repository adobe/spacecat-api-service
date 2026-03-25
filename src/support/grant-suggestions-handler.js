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
 * Extracts rank from a suggestion entity or plain object.
 */
function getSuggestionRank(s) {
  return typeof s?.getRank === 'function' ? s.getRank() : (s?.rank ?? 0);
}

/**
 * Creates a suggestion group object.
 * @param {Array} items - Suggestions in this group.
 * @param {Function} [rankFn] - Custom rank function for the group.
 *   Defaults to the rank of the first item.
 * @returns {{ items: Array, getRank: Function }}
 */
function createGroup(items, rankFn) {
  return {
    items,
    getRank: rankFn ?? (() => getSuggestionRank(items[0])),
  };
}

/**
 * Default sort: by group rank ascending, then first item id ascending.
 */
function defaultSortFn(groupA, groupB) {
  const rankA = groupA.getRank();
  const rankB = groupB.getRank();
  if (rankA !== rankB) return rankA - rankB;
  const a = groupA.items[0];
  const b = groupB.items[0];
  const idA = typeof a?.getId === 'function' ? a.getId() : (a?.id ?? '');
  const idB = typeof b?.getId === 'function' ? b.getId() : (b?.id ?? '');
  return idA.localeCompare(idB);
}

/**
 * Per-opportunity grouping and sorting strategies.
 *
 * Each entry is keyed by opportunity type and may define:
 *
 *   groupFn(suggestions) => Array<Group>
 *     Groups suggestions into logical units. Each group is created via
 *     createGroup(items, rankFn?) and consumes one token when granted.
 *     Use this when multiple suggestions should be treated as a single
 *     grantable unit (e.g. all backlinks pointing to the same broken URL).
 *     The optional rankFn overrides how the group's rank is computed;
 *     if omitted, the group rank defaults to the first item's rank.
 *     Not needed when each suggestion should be granted independently
 *     (the default is one group per suggestion).
 *
 *   sortFn(groupA, groupB) => number
 *     Custom comparator for ordering groups. Receives group objects
 *     with { items, getRank() }. Use this when the default sort
 *     (rank ascending, then first item's id ascending) does not match
 *     the desired grant priority for this opportunity type.
 *     Not needed when the default ascending-rank order is correct.
 *
 * Opportunities not listed here use the defaults: one group per
 * suggestion, sorted by rank ascending then id ascending.
 */
const OPPORTUNITY_STRATEGIES = {
  // Groups suggestions by target URL (url_to) so all backlinks pointing to the
  // same broken URL are granted as a single unit. The group rank is the highest
  // rank among its items, since higher rank = top priority opportunity.
  'broken-backlinks': {
    groupFn: (suggestions) => {
      const groups = new Map();
      for (const suggestion of suggestions) {
        const data = typeof suggestion?.getData === 'function'
          ? suggestion.getData()
          : suggestion?.data;
        const urlTo = data?.url_to ?? data?.urlTo ?? '';
        if (!groups.has(urlTo)) {
          groups.set(urlTo, []);
        }
        groups.get(urlTo).push(suggestion);
      }
      return [...groups.values()].map(
        (items) => createGroup(
          items,
          () => Math.max(...items.map(getSuggestionRank)),
        ),
      );
    },
  },
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
 * @returns {Array<{items: Array, getRank: Function}>} Sorted groups.
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
    : suggestions.map((s) => createGroup([s]));
  return [...groups].sort(sortFn ?? defaultSortFn);
}

/**
 * Grants suggestion groups using the SuggestionGrant.grantSuggestions RPC.
 *
 * @param {Object} SuggestionGrant - SuggestionGrant collection.
 * @param {Array} groups - Groups from getTopSuggestions.
 * @param {string} siteId - Site ID.
 * @param {string} tokenType - Token type.
 * @returns {Promise<void>}
 */
async function grantGroups(SuggestionGrant, groups, siteId, tokenType) {
  await Promise.all(
    groups.map((group) => {
      const ids = group.items.map((s) => s.getId()).filter(Boolean);
      return ids.length > 0
        ? SuggestionGrant.grantSuggestions(ids, siteId, tokenType)
        : Promise.resolve();
    }),
  );
}

/**
 * Revokes grants by their grant IDs using the shared
 * SuggestionGrant.revokeSuggestionGrant RPC. Each call atomically
 * deletes the suggestion_grants rows and decrements the token used count.
 *
 * @param {Object} SuggestionGrant - SuggestionGrant collection.
 * @param {string[]} grantIds - Unique grant IDs to revoke.
 * @returns {Promise<void>}
 */
async function revokeGrants(SuggestionGrant, grantIds) {
  if (!grantIds?.length) return;
  await Promise.all(
    grantIds.map((grantId) => SuggestionGrant.revokeSuggestionGrant(grantId)),
  );
}

/**
 * Grants top ungranted suggestions for an opportunity.
 *
 * **When a token already exists (current cycle):**
 * Fetches all grants for the current token. If any granted
 * suggestion has OUTDATED or REJECTED status, revokes all
 * grants for this token, then re-grants only the non-stale
 * ones. Fills remaining capacity from NEW ungranted suggestions.
 *
 * **When no token exists (new cycle):**
 * Creates a new token with the default tokensPerCycle total.
 * Revokes old grants from the previous cycle and re-grants them
 * with the new token. Then fills remaining capacity from NEW
 * ungranted suggestions.
 *
 * @param {Object} dataAccess - Data access collections.
 * @param {Object} site - Site model (getId()).
 * @param {Object} opportunity - Opportunity model
 *   (getId(), getType()).
 * @returns {Promise<void>}
 */
export async function grantSuggestionsForOpportunity(dataAccess, site, opportunity) {
  const Suggestion = dataAccess?.Suggestion;
  const SuggestionGrant = dataAccess?.SuggestionGrant;
  const Token = dataAccess?.Token;
  const siteId = site?.getId();
  const opptyId = opportunity?.getId();
  const oppType = opportunity?.getType();
  const config = oppType
    ? getTokenGrantConfigByOpportunity(oppType) : null;
  const tokenType = config?.tokenType;

  if (!Suggestion || !SuggestionGrant || !Token || !siteId || !opptyId || !config
    || !tokenType) return;

  const { STATUSES } = SuggestionModel;
  const newSuggestions = await Suggestion
    .allByOpportunityIdAndStatus(opptyId, STATUSES.NEW);
  const newSuggestionIds = newSuggestions.map((s) => s.getId());
  if (!newSuggestionIds.length) return;

  const { grantedIds, grantIds } = await SuggestionGrant
    .splitSuggestionsByGrantStatus(newSuggestionIds);

  let token = await Token.findBySiteIdAndTokenType(siteId, tokenType);
  const isNewToken = !token;

  if (isNewToken) {
    // New cycle: create token with default tokensPerCycle total
    token = await Token.findBySiteIdAndTokenType(siteId, tokenType, {
      createIfNotFound: true,
    });

    // Revoke old grants from previous cycle and re-grant with new token
    if (grantedIds?.length > 0) {
      await revokeGrants(SuggestionGrant, grantIds);

      const grantedEntities = newSuggestions
        .filter((s) => grantedIds.includes(s.getId()));
      const grantedGroups = getTopSuggestions(grantedEntities, oppType);
      await grantGroups(SuggestionGrant, grantedGroups, siteId, tokenType);

      // Re-fetch token to get updated remaining after re-grants
      token = await Token.findBySiteIdAndTokenType(siteId, tokenType);
      if (!token) return;
    }
  } else {
    // Existing token: fetch all grants for this token and check for stale suggestions
    const tokenGrants = await SuggestionGrant
      .allByIndexKeys({ tokenId: token.getId() });

    if (tokenGrants?.length > 0) {
      const grantedSuggestionIds = tokenGrants.map((g) => g.getSuggestionId());
      const grantedSuggestions = await Promise.all(
        grantedSuggestionIds.map((id) => Suggestion.findById(id)),
      );

      const hasStale = grantedSuggestions.some(
        (s) => s && (s.getStatus() === STATUSES.OUTDATED
          || s.getStatus() === STATUSES.REJECTED),
      );

      if (hasStale) {
        // Revoke all grants for this token; remaining token granting below
        // will re-grant eligible suggestions along with new ones
        const uniqueGrantIds = [...new Set(tokenGrants.map((g) => g.getGrantId()))];
        await revokeGrants(SuggestionGrant, uniqueGrantIds);

        // Re-fetch token to get updated remaining after revokes
        token = await Token.findBySiteIdAndTokenType(siteId, tokenType);
        if (!token) return;
      }
    }
  }

  const remaining = token.getRemaining();
  if (remaining <= 0) return;

  // Re-fetch grant status since revokes may have changed it
  const freshNewIds = newSuggestions.map((s) => s.getId());
  const { notGrantedIds: currentNotGrantedIds } = await SuggestionGrant
    .splitSuggestionsByGrantStatus(freshNewIds);

  const notGrantedEntities = newSuggestions
    .filter((s) => currentNotGrantedIds.includes(s.getId()));
  const topGroups = getTopSuggestions(notGrantedEntities, oppType)
    .slice(0, remaining);
  await grantGroups(SuggestionGrant, topGroups, siteId, tokenType);
}
