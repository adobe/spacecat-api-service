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
import {
  createSuggestion,
} from '../temp-mocks/mocks.js';
// from '@adobe/spacecat-shared-data-access/src/models/suggestion.js';

/**
 * Data transfer object for Site.
 */
export const SuggestionDto = {

  /**
   * Converts a JSON object into a Suggestion object.
   * @param {object} jsonObject - JSON object.
   * @returns {Readonly<Suggestion>} Suggestion object.
   */
  fromJson: (jsonObject) => {
    const suggestionData = {
      id: jsonObject.id,
      opportunityId: jsonObject.opportunityId,
      auditId: jsonObject.auditId,
      type: jsonObject.type,
      rank: jsonObject.rank,
      data: jsonObject.data,
      kpiDeltas: jsonObject.kpiDeltas,
      status: jsonObject.status,
      createdAt: jsonObject.createdAt,
      updatedAt: jsonObject.updatedAt,
    };
    return createSuggestion(suggestionData);
  },

  /**
   * Converts a Suggestion object into a JSON object.
   * @param {Readonly<Suggestion>} suggestion - Suggestion object.
   * @returns {{
   *  id: string,
   *  opportunityId: string,
   *  auditId: string,
   *  type: string,
   *  rank: number,
   *  data: object,
   *  kpiDeltas: object,
   *  status: string,
   *  createdAt: Date,
   *  updatedAt: Date,
   * }} JSON object.
   */
  toJSON: (suggestion) => ({
    id: suggestion.getId(),
    opportunityId: suggestion.getOpportunityId(),
    auditId: suggestion.getAuditId(),
    type: suggestion.getType(),
    rank: suggestion.getRank(),
    data: suggestion.getData(),
    kpiDeltas: suggestion.getKpiDeltas(),
    status: suggestion.getStatus(),
    createdAt: suggestion.getCreatedAt(),
    updatedAt: suggestion.getUpdatedAt(),
  }),
};
