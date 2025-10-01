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
 * @import { FixEntity } from "@adobe/spacecat-shared-data-access"
 */

/**
 * Data transfer object for Site.
 */
export const FixDto = {

  /**
   * Converts a Suggestion object into a JSON object.
   * @param {Readonly<FixEntity>} fix - FixEntity object.
   * @returns {{
   *  id: string
   *  suggestionId: string
   *  type: string
   *  executedBy: string
   *  executedAt: string
   *  publishedAt: string
   *  changeDetails: object
   *  status: string
   * }} JSON object.
   */
  toJSON(fix) {
    return {
      id: fix.getId(),
      opportunityId: fix.getOpportunityId(),
      type: fix.getType(),
      createdAt: fix.getCreatedAt(),
      executedBy: fix.getExecutedBy(),
      executedAt: fix.getExecutedAt(),
      publishedAt: fix.getPublishedAt(),
      changeDetails: fix.getChangeDetails(),
      status: fix.getStatus(),
      origin: fix.getOrigin(),
    };
  },
};
