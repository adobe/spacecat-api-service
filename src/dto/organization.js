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

import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';

/**
 * Data transfer object for Organization.
 */
export const OrganizationDto = {
  /**
   * Converts a Organization object into a JSON object.
   *
   * When `entitlements` is provided, a compact per-product `entitlements` summary
   * (`[{ productCode, tier }]`) is included so callers (e.g. the LLMO UI) can read the
   * TRIAL/PAID plan signal straight from the org fetch without a second round trip. An org
   * can be TRIAL on one product and PAID on another, so the signal is intentionally
   * per-product rather than a single org-wide flag. The list endpoint (`getAll`) omits it to
   * avoid a per-org entitlement fetch (N+1); only the single-org GETs populate it.
   *
   * @param {Readonly<Organization>} organization - Organization object.
   * @param {Array<Readonly<Entitlement>>|null} [entitlements] - Optional entitlements for the
   *   organization; when supplied, added as a compact `entitlements` array.
   * @returns {object} Organization JSON.
   */
  toJSON: (organization, entitlements = null) => ({
    id: organization.getId(),
    name: organization.getName(),
    imsOrgId: organization.getImsOrgId(),
    semrushWorkspaceId: organization.getSemrushWorkspaceId(),
    createdAt: organization.getCreatedAt(),
    updatedAt: organization.getUpdatedAt(),
    config: Config.toDynamoItem(organization.getConfig()),
    ...(Array.isArray(entitlements) ? {
      entitlements: entitlements.map((entitlement) => ({
        productCode: entitlement.getProductCode(),
        tier: entitlement.getTier(),
      })),
    } : {}),
  }),
};
