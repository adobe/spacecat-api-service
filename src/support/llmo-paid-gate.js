/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import TierClient from '@adobe/spacecat-shared-tier-client';
import { Entitlement as EntitlementModel } from '@adobe/spacecat-shared-data-access';

/**
 * Returns true when the organization holds a PAID LLMO entitlement.
 *
 * PAID is stricter than the platform's any-tier "LLMO-enabled" bar. Entitlements have no
 * status column (getStatus() is an unbacked stub; revocation = row delete), so a PAID row
 * existing is the "currently paying" signal.
 *
 * Lives here rather than inline in the (`// @ts-check`) brands controller because the
 * `@adobe/spacecat-shared-data-access` package does not declare `Entitlement` in its
 * published `.d.ts`, so importing it from a type-checked file fails `tsc --checkJs`.
 *
 * @param {object} context - Request context (env, dataAccess, etc.).
 * @param {object} organization - The resolved organization model.
 * @returns {Promise<boolean>} True if the org has a PAID LLMO entitlement.
 */
export async function hasPaidLlmoEntitlement(context, organization) {
  const tierClient = TierClient.createForOrg(
    context,
    organization,
    EntitlementModel.PRODUCT_CODES.LLMO,
  );
  const { entitlement } = await tierClient.checkValidEntitlement();
  return Boolean(entitlement) && entitlement.getTier() === EntitlementModel.TIERS.PAID;
}
