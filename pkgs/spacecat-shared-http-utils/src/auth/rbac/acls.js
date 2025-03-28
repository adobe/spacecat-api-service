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

import { createDataAccess } from '@adobe/spacecat-shared-data-access';

function prepPathForSort(path) {
  if (path.endsWith('/**')) return path.slice(0, -2);
  return path;
}

export function pathSorter({ path: path1 }, { path: path2 }) {
  const sp1 = prepPathForSort(path1);
  const sp2 = prepPathForSort(path2);
  return sp2.length - sp1.length;
}

async function getDBAccess(log, tableName = 'spacecat-services-rbac-dev') { // TODO pick up from config
  return createDataAccess({
    tableNameData: tableName,
    aclCtx: {
      aclEntities: {
        exclude: ['role', 'roleMember'],
      },
    },
  }, log);
}

async function getDBRoles(dbAccess, {
  imsUserId, imsOrgId, imsGroups, apiKey,
}, log) {
  const idents = [`imsOrgID:${imsOrgId}`];
  if (imsUserId) {
    idents.push(`imsID:${imsUserId}`);
  }

  if (imsGroups) {
    for (const grp of imsGroups) {
      if (grp.orgId !== imsOrgId) {
        // eslint-disable-next-line no-continue
        continue;
      }

      idents.push(`imsOrgID/groupID:${imsOrgId}/${grp.groupId}`);
    }
  }

  if (apiKey) {
    idents.push(`apiKeyID:${apiKey}`);
  }

  const roleMemberships = await dbAccess.RoleMember.allRoleMembershipByIdentities(imsOrgId, idents);
  const roles = await Promise.all(roleMemberships.map(async (rm) => rm.getRole()));
  log.debug(`Found role membership names for ${imsOrgId} identities ${idents}: ${roles.map((r) => r.getName())}`);
  return roles;
}

export default async function getAcls({
  imsUserId, imsOrgs, imsGroups, apiKey,
}, log) {
  const dbAccess = await getDBAccess(log);

  const acls = [];

  // Normally there is only 1 organization, but the API returns an array so
  // we'll iterate over it and use all the ACLs we find.
  for (const imsOrgId of imsOrgs) {
    // eslint-disable-next-line no-await-in-loop
    const roles = await getDBRoles(dbAccess, {
      imsUserId, imsOrgId, imsGroups, apiKey,
    }, log);

    roles.forEach((r) => {
      const acl = [...r.getAcl()];
      acl.sort(pathSorter);
      const entry = {
        role: r.getName(),
        acl,
      };

      acls.push(entry);
    });
  }

  return {
    acls,
    aclEntities: {
      // Right now only check organization and site
      exclude: [
        'apiKey', 'audit', 'configuration', 'experiment',
        'importJob', 'importUrl', 'keyEvent', 'latestAudit',
        'opportunity', 'siteCandidate', 'siteTopPage', 'suggestion',
      ],
    },
  };
}
