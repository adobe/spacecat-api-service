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

import { readFeatureFlag } from './feature-flags-storage.js';

export const LLMO_FEATURE_FLAG_PRODUCT = 'LLMO';
export const LLMO_BRANDALF_FLAG = 'brandalf';
export const LLMO_ONBOARDING_MODE_V1 = 'v1';
export const LLMO_ONBOARDING_MODE_V2 = 'v2';

export function normalizeLlmoOnboardingMode(mode) {
  return mode === LLMO_ONBOARDING_MODE_V2 ? LLMO_ONBOARDING_MODE_V2 : LLMO_ONBOARDING_MODE_V1;
}

export async function readBrandalfFlagOverride(organizationId, postgrestClient) {
  if (!organizationId || !postgrestClient?.from) {
    return null;
  }

  return readFeatureFlag({
    organizationId,
    product: LLMO_FEATURE_FLAG_PRODUCT,
    flagName: LLMO_BRANDALF_FLAG,
    postgrestClient,
  });
}

export async function resolveLlmoOnboardingMode(organizationId, context) {
  const configuredDefault = context?.env?.LLMO_ONBOARDING_DEFAULT_VERSION;
  const defaultMode = normalizeLlmoOnboardingMode(configuredDefault);
  const { log = console } = context || {};
  const postgrestClient = context?.dataAccess?.services?.postgrestClient;

  if (configuredDefault && configuredDefault !== defaultMode) {
    log.warn(
      `Invalid LLMO_ONBOARDING_DEFAULT_VERSION "${configuredDefault}", falling back to ${defaultMode}`,
    );
  }

  try {
    const override = await readBrandalfFlagOverride(organizationId, postgrestClient);
    if (override === true) {
      return LLMO_ONBOARDING_MODE_V2;
    }
    if (override === false) {
      return LLMO_ONBOARDING_MODE_V1;
    }
  } catch (error) {
    log.warn(
      `Failed to resolve brandalf feature flag for organization ${organizationId}: ${error.message}`,
    );
  }

  return defaultMode;
}
