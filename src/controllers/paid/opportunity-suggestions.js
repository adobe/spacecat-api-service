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

function createEmptySuggestionBuckets(opportunityIds) {
  return new Map(
    opportunityIds.map((opportunityId) => [opportunityId, {
      newSuggestions: [],
      hasPendingValidation: false,
    }]),
  );
}

function partitionSuggestionsByOpportunity(opportunityIds, suggestions = []) {
  const suggestionsByOpportunityId = createEmptySuggestionBuckets(opportunityIds);

  suggestions.forEach((suggestion) => {
    const opportunityId = suggestion.getOpportunityId();
    const bucket = suggestionsByOpportunityId.get(opportunityId);
    if (!bucket) {
      return;
    }

    if (suggestion.getStatus() === 'NEW') {
      bucket.newSuggestions.push(suggestion);
    } else if (suggestion.getStatus() === 'PENDING_VALIDATION') {
      bucket.hasPendingValidation = true;
    }
  });

  return suggestionsByOpportunityId;
}

async function loadSuggestionsWithBatchGet(Suggestion, opportunityIds) {
  const result = await Suggestion.batchGetByKeys(
    opportunityIds.map((opportunityId) => ({ opportunityId })),
  );
  return {
    suggestionsByOpportunityId: partitionSuggestionsByOpportunity(
      opportunityIds,
      result?.data ?? [],
    ),
    failedOpportunityIds: new Set(),
  };
}

async function loadSuggestionsIndividually(Suggestion, opportunityIds, log) {
  const suggestionsByOpportunityId = new Map();
  const failedOpportunityIds = new Set();

  const results = await Promise.allSettled(
    opportunityIds.map(async (opportunityId) => {
      const allSuggestions = (await Suggestion.allByOpportunityId(opportunityId)) ?? [];
      const newSuggestions = allSuggestions.filter((suggestion) => suggestion.getStatus() === 'NEW');
      const hasPendingValidation = allSuggestions.some(
        (suggestion) => suggestion.getStatus() === 'PENDING_VALIDATION',
      );

      return { newSuggestions, hasPendingValidation };
    }),
  );

  opportunityIds.forEach((opportunityId, index) => {
    const result = results[index];
    if (result.status === 'fulfilled') {
      suggestionsByOpportunityId.set(opportunityId, result.value);
      return;
    }

    log?.warn?.('Failed to fetch suggestions for opportunity, excluding from results', {
      opportunityId,
      error: result.reason?.message,
    });
    failedOpportunityIds.add(opportunityId);
  });

  return { suggestionsByOpportunityId, failedOpportunityIds };
}

export async function loadSuggestionsByOpportunityIds(Suggestion, opportunityIds, log) {
  if (!opportunityIds.length) {
    return {
      suggestionsByOpportunityId: new Map(),
      failedOpportunityIds: new Set(),
    };
  }

  if (typeof Suggestion.batchGetByKeys === 'function') {
    try {
      return await loadSuggestionsWithBatchGet(Suggestion, opportunityIds);
    } catch (error) {
      log?.warn?.('Batch suggestion fetch failed, falling back to per-opportunity queries', {
        error: error?.message,
      });
    }
  }

  return loadSuggestionsIndividually(Suggestion, opportunityIds, log);
}

export default loadSuggestionsByOpportunityIds;
