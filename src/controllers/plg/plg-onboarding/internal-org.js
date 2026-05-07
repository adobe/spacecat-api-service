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

import { hasText } from '@adobe/spacecat-shared-utils';

function parseCommaSeparatedEnvList(value) {
  return (value || '').split(',').map((id) => id.trim()).filter(Boolean);
}

export function isInternalOrg(orgId, env) {
  return parseCommaSeparatedEnvList(env.ASO_PLG_EXCLUDED_ORGS).includes(orgId);
}

/**
 * Site IDs that must not use the internal-org waitlist bypass, even when the site lives in an
 * org listed in ASO_PLG_EXCLUDED_ORGS (e.g. customer demo sites in a shared internal org).
 * Comma-separated UUIDs in env ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS.
 */
export function isInternalOrgDemoSite(siteId, env) {
  return parseCommaSeparatedEnvList(env.ASO_PLG_INTERNAL_ORG_DEMO_SITE_IDS).includes(siteId);
}

export function getReviewerIdentity(context) {
  const authInfo = context.attributes?.authInfo;
  const profile = authInfo?.getProfile?.() ?? authInfo?.profile;
  return hasText(profile?.email) ? profile.email : 'admin';
}
