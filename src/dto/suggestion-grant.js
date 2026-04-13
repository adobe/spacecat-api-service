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
 * Data transfer object for SuggestionGrant.
 */
export const SuggestionGrantDto = {
  /**
   * Converts a SuggestionGrant object into a JSON object.
   * @param {Readonly<SuggestionGrant>} grant - SuggestionGrant object.
   * @returns {{
   *   id: string,
   *   grantId: string,
   *   suggestionId: string,
   *   siteId: string,
   *   tokenId: string,
   *   tokenType: string,
   *   grantedAt: string,
   * }}
   */
  toJSON: (grant) => ({
    id: grant.getId(),
    grantId: grant.getGrantId(),
    suggestionId: grant.getSuggestionId(),
    siteId: grant.getSiteId(),
    tokenId: grant.getTokenId(),
    tokenType: grant.getTokenType(),
    grantedAt: grant.getGrantedAt(),
  }),
};
