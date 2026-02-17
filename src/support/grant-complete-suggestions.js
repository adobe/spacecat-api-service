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

import {
  isGranted,
  isSuggestionComplete,
  OPPORTUNITY_TYPES,
} from '@adobe/spacecat-shared-utils';

/** Maps opportunity type (e.g. broken-backlinks) to token type for freemium grant. */
const OPPORTUNITY_TYPE_TO_TOKEN_TYPE = {
  [OPPORTUNITY_TYPES.BROKEN_BACKLINKS]: 'BROKEN_BACKLINK',
  [OPPORTUNITY_TYPES.CWV]: 'CWV',
  [OPPORTUNITY_TYPES.ALT_TEXT]: 'ALT_TEXT',
};

/**
 * When the organization is freemium, grants up to remaining token count for suggestions that are
 * complete (per suggestion-complete.js) and not yet granted. Loads suggestions for the opportunity,
 * then runs grant logic. Only runs for opportunity types that have token types and complete
 * handlers (broken-backlinks, cwv, alt-text). Mutates and persists grants on suggestion entities.
 *
 * @param {Object} dataAccess - Data access (Suggestion, Token, Entitlement).
 * @param {Object} site - Site model (getOrganizationId, getId).
 * @param {Object} opportunity - Opportunity model (getType, getId).
 * @returns {Promise<void>}
 */
export async function grantCompleteSuggestionsForOpportunity(dataAccess, site, opportunity) {
  if (!dataAccess || !site || !opportunity) return;

  const { Suggestion, Token, Entitlement } = dataAccess;
  if (!Token || !Suggestion || !Entitlement) return;

  const organizationId = typeof site?.getOrganizationId === 'function' ? site.getOrganizationId() : undefined;
  if (!organizationId || !Entitlement.isFreemium(organizationId)) return;

  const opportunityType = typeof opportunity.getType === 'function' ? opportunity.getType() : opportunity.type;
  const tokenType = OPPORTUNITY_TYPE_TO_TOKEN_TYPE[opportunityType];
  if (!tokenType) return;

  const siteId = typeof site?.getId === 'function' ? site.getId() : undefined;
  if (!siteId) return;

  const opptyId = typeof opportunity?.getId === 'function' ? opportunity.getId() : opportunity.id;
  if (!opptyId) return;

  const suggestionEntities = await Suggestion.allByOpportunityId(opptyId);
  if (!suggestionEntities?.length) return;

  const cycle = new Date().toISOString().slice(0, 7); // YYYY-MM
  const remaining = await Token.getRemainingToken(siteId, tokenType, cycle);
  if (remaining < 1) return;

  const completeUngranted = suggestionEntities
    .filter((s) => !isGranted(s) && isSuggestionComplete(s, opportunityType))
    .sort((a, b) => (a.getRank?.() ?? a.rank ?? 0) - (b.getRank?.() ?? b.rank ?? 0));

  const toGrant = completeUngranted.slice(0, remaining);
  const grantedAt = new Date().toISOString();

  for (const suggestion of toGrant) {
    // eslint-disable-next-line no-await-in-loop -- token use must be sequential per suggestion
    const grant = await Token.useToken(siteId, tokenType, cycle);
    if (!grant) break;
    suggestion.setGrants({
      cycle: grant.cycle,
      tokenId: grant.tokenId,
      grantedAt,
    });
    // eslint-disable-next-line no-await-in-loop -- save must complete before next iteration
    await suggestion.save();
  }
}
