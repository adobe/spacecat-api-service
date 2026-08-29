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

import { hasText } from '@adobe/spacecat-shared-utils';

/**
 * Checks whether the caller is a member of the named IMS group within a given IMS org.
 *
 * Resolves the caller's IMS organizations, finds the one matching `imsOrgId`
 * (`<ident>@<authSrc>`), and looks for a group whose name matches `groupName`
 * (case-insensitive).
 *
 * Fail-closed by design: callers use the result to GRANT access, so any missing
 * input, unmatched org, absent groups list, or IMS lookup failure yields `false`
 * (deny) rather than throwing. This mirrors the LLMO Admin group check used for
 * edge CDN routing authorization.
 *
 * @param {object} context - Request context; must expose `imsClient` with
 *   `getImsUserOrganizations(imsUserToken)`.
 * @param {object} params
 * @param {string} params.imsOrgId - IMS org id in `<ident>@<authSrc>` form.
 * @param {string} params.imsUserToken - The caller's IMS user access token.
 * @param {string} params.groupName - Target IMS group name (exact, case-sensitive match).
 * @param {object} [log] - Optional logger.
 * @returns {Promise<boolean>} `true` only when the caller is a confirmed member.
 */
export async function isImsGroupMember(context, {
  imsOrgId, imsUserToken, groupName,
}, log) {
  if (!hasText(imsOrgId) || !hasText(imsUserToken) || !hasText(groupName)) {
    return false;
  }

  try {
    const orgs = await context.imsClient.getImsUserOrganizations(imsUserToken);
    const matchingOrg = orgs?.find(
      (o) => `${o.orgRef?.ident}@${o.orgRef?.authSrc}` === imsOrgId,
    );
    if (!matchingOrg) {
      return false;
    }
    return matchingOrg.groups?.some(
      (g) => g.groupName === groupName,
    ) ?? false;
  } catch (err) {
    log?.warn?.(`[ims-group] membership check failed: ${err.message}`);
    return false;
  }
}
