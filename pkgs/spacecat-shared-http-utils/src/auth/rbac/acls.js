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
  if (path.endsWith('/+**')) return path.slice(0, -3);
  if (path.endsWith('/**')) return path.slice(0, -2);
  return path;
}

function pathSorter({ path: path1 }, { path: path2 }) {
  const sp1 = prepPathForSort(path1);
  const sp2 = prepPathForSort(path2);
  return sp2.length - sp1.length;
}

async function getDBAccess(log, tableName = 'spacecat-services-rbac-dev') {
  console.log('§§§ Getting RBAC DB Access');

  return createDataAccess({
    tableNameData: tableName,
    aclCtx: {
      aclEntities: {
        exclude: ['acl', 'role'],
      },
    },
  }, log);
}

async function getDBRoles(dbAccess, {
  imsUserId, imsOrgId, imsGroups, apiKey,
}, log) {
  const idents = [
    `imsID:${imsUserId}`,
    `imsOrgID:${imsOrgId}`,
  ];

  if (imsGroups) {
    for (const [org, groups] of Object.entries(imsGroups)) {
      if (org !== imsOrgId) {
        // eslint-disable-next-line no-continue
        continue;
      }

      for (const group of groups.groups) {
        idents.push(`imsOrgID/groupID:${imsOrgId}/${group.groupid}`);
      }
    }
  }

  if (apiKey) {
    idents.push(`apiKeyID:${apiKey}`);
  }

  const roles = await dbAccess.Role.allRolesByIdentities(imsOrgId, idents);
  const roleNames = roles.map((r) => r.name);
  log.debug(`Found role names for ${imsOrgId} identities ${idents}: ${roleNames}`);
  return roleNames;
}

async function getDBACLs(dbAccess, {
  imsOrgId, roles,
}, log) {
  const acls = await dbAccess.Acl.allAclsByRoleNames(imsOrgId, roles);
  const roleAcls = acls.map((a) => {
    a.acls.sort(pathSorter);
    return {
      role: a.roleName,
      acl: a.acls,
    };
  });
  log.debug((`Found ACLs for ${imsOrgId} roles ${roles}: ${roleAcls}`));
  return roleAcls;
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
    if (!roles) {
      // eslint-disable-next-line no-continue
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const aclList = await getDBACLs(dbAccess, { imsOrgId, roles }, log);
    acls.push(...aclList);
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
