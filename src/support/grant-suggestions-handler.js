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
  // Sorts CWV suggestions by confidence score (rank) descending so the most
  // impactful pages are granted first. Confidence score is set by the audit
  // worker as projected traffic lost (organic × metric-severity multiplier).
  // Tie-breaks by suggestion ID ascending for deterministic ordering.
  cwv: {
    sortFn: (groupA, groupB) => {
      const rankDiff = groupB.getRank() - groupA.getRank();
      if (rankDiff !== 0) return rankDiff;
      const a = groupA.items[0];
      const b = groupB.items[0];
      const idA = typeof a?.getId === 'function' ? a.getId() : (a?.id ?? '');
      const idB = typeof b?.getId === 'function' ? b.getId() : (b?.id ?? '');
      return idA.localeCompare(idB);
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
  const results = await Promise.allSettled(
    grantIds.map((grantId) => SuggestionGrant.revokeSuggestionGrant(grantId)),
  );
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    throw new Error(`Failed to revoke ${failed.length}/${grantIds.length} grants`);
  }
}

const STALE_STATUSES = new Set([
  SuggestionModel.STATUSES.OUTDATED,
  SuggestionModel.STATUSES.REJECTED,
  SuggestionModel.STATUSES.PENDING_VALIDATION,
]);

const isRevocable = (status) => STALE_STATUSES.has(status)
  || status === SuggestionModel.STATUSES.NEW;

/**
 * Handles a new token cycle: creates the token and migrates
 * existing grants from the previous cycle to the new token.
 *
 * @returns {{ token, didRevoke }} Updated token and whether revokes occurred.
 */
async function handleNewTokenCycle(
  { SuggestionGrant, Token },
  { siteId, tokenType, oppType },
  { grantedIds, grantIds, newSuggestions },
) {
  let token = await Token.findBySiteIdAndTokenType(siteId, tokenType, {
    createIfNotFound: true,
  });

  let didRevoke = false;
  if (grantedIds?.length > 0) {
    await revokeGrants(SuggestionGrant, grantIds);
    didRevoke = true;

    const grantedEntities = newSuggestions
      .filter((s) => grantedIds.includes(s.getId()));
    const grantedGroups = getTopSuggestions(grantedEntities, oppType);
    await grantGroups(SuggestionGrant, grantedGroups, siteId, tokenType);

    token = await Token.findBySiteIdAndTokenType(siteId, tokenType);
  }

  return { token, didRevoke };
}

/**
 * Handles an existing token cycle: checks for stale grants
 * and revokes only those in revocable states.
 *
 * @returns {{ token, didRevoke }} Updated token and whether revokes occurred.
 */
async function handleExistingTokenCycle(
  { Suggestion, SuggestionGrant, Token },
  { siteId, tokenType },
  token,
) {
  const tokenGrants = await SuggestionGrant
    .allByIndexKeys({ tokenId: token.getId() });

  if (!tokenGrants?.length) return { token, didRevoke: false };

  const grantedSuggestionIds = tokenGrants.map((g) => g.getSuggestionId());
  const { data: grantedSuggestions } = await Suggestion
    .batchGetByKeys(grantedSuggestionIds.map((id) => ({ suggestionId: id })));

  const staleGrantIds = [...new Set(
    tokenGrants
      .filter((g) => {
        const s = grantedSuggestions.find((gs) => gs?.getId() === g.getSuggestionId());
        return s && STALE_STATUSES.has(s.getStatus());
      })
      .map((g) => g.getGrantId()),
  )];

  if (staleGrantIds.length === 0) return { token, didRevoke: false };

  const revocableGrantIds = [...new Set(
    tokenGrants
      .filter((g) => {
        const s = grantedSuggestions.find((gs) => gs?.getId() === g.getSuggestionId());
        return s && isRevocable(s.getStatus());
      })
      .map((g) => g.getGrantId()),
  )];

  await revokeGrants(SuggestionGrant, revocableGrantIds);
  const refreshedToken = await Token.findBySiteIdAndTokenType(siteId, tokenType);

  return { token: refreshedToken, didRevoke: true };
}

/**
 * Fills remaining token capacity with top ungranted NEW suggestions.
 */
async function fillRemainingCapacity(
  { SuggestionGrant },
  { siteId, tokenType, oppType },
  {
    newSuggestions, newSuggestionIds, notGrantedIds, didRevoke,
  },
  remaining,
) {
  const currentNotGrantedIds = didRevoke
    ? (await SuggestionGrant.splitSuggestionsByGrantStatus(newSuggestionIds)).notGrantedIds
    : notGrantedIds;

  const notGrantedEntities = newSuggestions
    .filter((s) => currentNotGrantedIds.includes(s.getId()));
  const topGroups = getTopSuggestions(notGrantedEntities, oppType)
    .slice(0, remaining);
  await grantGroups(SuggestionGrant, topGroups, siteId, tokenType);
}

/**
 * Grants top ungranted suggestions for an opportunity.
 *
 * **When a token already exists (current cycle):**
 * Fetches all grants for the current token. If any granted
 * suggestion is in a revocable state (OUTDATED, REJECTED,
 * PENDING_VALIDATION, NEW), revokes only those grants, leaving
 * permanent states (e.g. APPROVED) untouched. Fills remaining
 * capacity from NEW ungranted suggestions.
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
  const { Suggestion, SuggestionGrant, Token } = dataAccess ?? {};
  const siteId = site?.getId();
  const opptyId = opportunity?.getId();
  const oppType = opportunity?.getType();
  const config = oppType ? getTokenGrantConfigByOpportunity(oppType) : null;
  const tokenType = config?.tokenType;

  if (!Suggestion || !SuggestionGrant || !Token || !siteId || !opptyId || !config
    || !tokenType) return;

  const newSuggestions = await Suggestion
    .allByOpportunityIdAndStatus(opptyId, SuggestionModel.STATUSES.NEW);
  const newSuggestionIds = newSuggestions.map((s) => s.getId());
  if (!newSuggestionIds.length) return;

  const { grantedIds, grantIds, notGrantedIds } = await SuggestionGrant
    .splitSuggestionsByGrantStatus(newSuggestionIds);

  const existingToken = await Token.findBySiteIdAndTokenType(siteId, tokenType);
  const collections = { Suggestion, SuggestionGrant, Token };
  const ids = { siteId, tokenType, oppType };

  const { token, didRevoke } = existingToken
    ? await handleExistingTokenCycle(collections, ids, existingToken)
    : await handleNewTokenCycle(collections, ids, { grantedIds, grantIds, newSuggestions });

  if (!token || token.getRemaining() <= 0) return;

  await fillRemainingCapacity(
    collections,
    ids,
    {
      newSuggestions, newSuggestionIds, notGrantedIds, didRevoke,
    },
    token.getRemaining(),
  );
}
