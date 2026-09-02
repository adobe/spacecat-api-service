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

/**
 * @import { FixEntity, Suggestion } from "@adobe/spacecat-shared-data-access"
 */

import { SuggestionDto } from './suggestion.js';

/**
 * Back-fills the legacy top-level `changeDetails.documentPath` from the v2
 * canonical shape's `changeDetails.target.documentPath` (SITES-49140, ADR
 * mysticat-architecture#200) when a writer has migrated to `schemaVersion: 2`
 * but the top-level field a client already reads (e.g. the "Open in AEM
 * Editor" UI action, added in #1835) is absent.
 *
 * The v2 Joi schema is `additionalProperties: false` at the top level, so a
 * v2 writer cannot itself emit both `documentPath` and `schemaVersion: 2` —
 * this normalization has to happen at the read/DTO boundary instead.
 *
 * @param {object} [changeDetails]
 * @returns {object|undefined} changeDetails, with `documentPath` present at
 *   the top level when resolvable from either shape.
 */
export function withLegacyDocumentPath(changeDetails) {
  if (!changeDetails || changeDetails.documentPath !== undefined) {
    return changeDetails;
  }
  const targetDocumentPath = changeDetails.target?.documentPath;
  if (targetDocumentPath === undefined) {
    return changeDetails;
  }
  return { ...changeDetails, documentPath: targetDocumentPath };
}

/**
 * Data transfer object for Fix.
 */
export const FixDto = {

  /**
   * Converts a FixEntity object into a JSON object.
   * @param {Readonly<FixEntity>} fix - FixEntity object.
   * @param {string|null} [locale] - Optional locale code (e.g. 'fr_fr', 'ja_jp').
   * @returns {{
   *  id: string
   *  opportunityId: string
   *  type: string
   *  createdAt: string
   *  updatedAt: string
   *  executedBy: string
   *  executedAt: string
   *  deployedAt: string|null
   *  publishedAt: string
   *  changeDetails: object
   *  status: string
   *  suggestions?: Array<object>
   * }} JSON object.
   */
  toJSON(fix, locale = null) {
    const result = {
      id: fix.getId(),
      opportunityId: fix.getOpportunityId(),
      type: fix.getType(),
      createdAt: fix.getCreatedAt(),
      updatedAt: fix.getUpdatedAt(),
      executedBy: fix.getExecutedBy(),
      executedAt: fix.getExecutedAt(),
      deployedAt: fix.getDeployedAt(),
      publishedAt: fix.getPublishedAt(),
      changeDetails: withLegacyDocumentPath(fix.getChangeDetails()),
      status: fix.getStatus(),
      origin: fix.getOrigin(),
    };

    // Include IMS-resolved user identity when executedBy was enriched at read time
    // eslint-disable-next-line no-underscore-dangle
    if (fix._executedByUser) {
      // eslint-disable-next-line no-underscore-dangle
      const { firstName, lastName, email } = fix._executedByUser;
      result.executedByUser = { firstName, lastName, email };
    }

    // Include suggestions if they are attached to the fix entity
    // eslint-disable-next-line no-underscore-dangle
    if (fix._suggestions && Array.isArray(fix._suggestions)) {
      // eslint-disable-next-line no-underscore-dangle
      result.suggestions = fix._suggestions.map(
        (suggestion) => SuggestionDto.toJSON(suggestion, 'full', null, locale),
      );
    }

    return result;
  },
};
