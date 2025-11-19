/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { buildAggregationKeyFromSuggestion } from '@adobe/spacecat-shared-utils';

/**
 * Data transfer object for Suggestion.
 */
export const SuggestionDto = {

  /**
   * Converts a Suggestion object into a JSON object.
   * @param {Readonly<Suggestion>} suggestion - Suggestion object.
   * @returns {{
   *  id: string,
   *  opportunityId: string,
   *  type: string,
   *  rank: number,
   *  data: object,
   *  kpiDeltas: object,
   *  status: string,
   *  createdAt: string,
   *  updatedAt: string,
   *  updatedBy: string,
   * }} JSON object.
   */
  toJSON: (suggestion) => {
    const data = suggestion.getData();
    const aggregationKey = buildAggregationKeyFromSuggestion(data);
    return {
      id: suggestion.getId(),
      opportunityId: suggestion.getOpportunityId(),
      type: suggestion.getType(),
      rank: suggestion.getRank(),
      status: suggestion.getStatus(),
      data: {
        ...data,
        aggregationKey,
      },
      kpiDeltas: suggestion.getKpiDeltas(),
      createdAt: suggestion.getCreatedAt(),
      updatedAt: suggestion.getUpdatedAt(),
      updatedBy: suggestion.getUpdatedBy(),
    };
  },
};
