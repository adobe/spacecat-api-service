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

/* eslint-env mocha */

import { expect } from 'chai';
import esmock from 'esmock';

import { pathSorter } from '../../../src/auth/rbac/acls.js';

describe('RBAC', () => {
  it('test path sorter', () => {
    const sampleACL = [
      { path: '/aa/aa/aa', actions: ['C'] },
      { path: '/qqq/rrr/sss', actions: [] },
      { path: '/a', actions: ['R'] },
      { path: '/bbcc/bbcc/**', actions: ['C', 'R', 'U', 'D'] },
    ];
    const expectedACL = [
      { path: '/qqq/rrr/sss', actions: [] },
      { path: '/bbcc/bbcc/**', actions: ['C', 'R', 'U', 'D'] },
      { path: '/aa/aa/aa', actions: ['C'] },
      { path: '/a', actions: ['R'] },
    ];

    sampleACL.sort(pathSorter);
    expect(sampleACL).to.deep.equal(expectedACL);
  });

  it('test getAcls', async () => {
    const acl1 = [{
      actions: ['R'],
      path: '/a/b/c/**',
    }, {
      actions: ['C', 'R', 'U', 'D'],
      path: '/a/b/c/d',
    }];
    const acl2 = [{
      actions: ['C'],
      path: '/x/y/z',
    }];
    const r1 = {
      getName: () => 'role1',
      getAcl: () => acl1,
    };
    const r2 = {
      getName: () => 'role2',
      getAcl: () => acl2,
    };
    const mockRoleMembers = [
      { getRole: () => r1 },
      { getRole: () => r2 },
    ];
    const mockRoleMembersFn = (oid, ids) => {
      if (oid === 'BAABAABAA@AdobeOrg') {
        if (ids.length === 4
          && ids.includes('imsOrgID:BAABAABAA@AdobeOrg')
          && ids.includes('imsOrgID/groupID:BAABAABAA@AdobeOrg/12345678')
          && ids.includes('imsOrgID/groupID:BAABAABAA@AdobeOrg/87654321')
          && ids.includes('imsID:1234@5678.e')) {
          return mockRoleMembers;
        }
      }
      return null;
    };
    const mockDA = {
      RoleMember: {
        allRoleMembershipByIdentities: mockRoleMembersFn,
      },
    };
    const mockCDA = async (config) => {
      if (config.aclCtx.aclEntities.exclude.length === 2
        && config.aclCtx.aclEntities.exclude.includes('role')
        && config.aclCtx.aclEntities.exclude.includes('roleMember')) {
        return mockDA;
      }
      return null;
    };
    const getAcls = await esmock('../../../src/auth/rbac/acls.js', {
      '@adobe/spacecat-shared-data-access': {
        createDataAccess: mockCDA,
      },
    });

    const log = { debug: () => { } };
    const imsUserId = '1234@5678.e';
    const imsOrgs = ['BAABAABAA@AdobeOrg'];
    const imsGroups = [{
      orgId: 'BAABAABAA@AdobeOrg',
      groupId: 12345678,
    }, {
      orgId: 'F00F00@AdobeOrg',
      groupId: 99999999,
    }, {
      orgId: 'BAABAABAA@AdobeOrg',
      groupId: 87654321,
    }];

    const acls = await getAcls({ imsUserId, imsOrgs, imsGroups }, log);

    const expectedAcls = [{
      role: 'role1',
      acl: [{
        actions: ['C', 'R', 'U', 'D'],
        path: '/a/b/c/d',
      }, {
        actions: ['R'],
        path: '/a/b/c/**',
      }],
    }, {
      role: 'role2',
      acl: [{
        actions: ['C'],
        path: '/x/y/z',
      }],
    }];
    expect(acls.acls).to.deep.equal(expectedAcls);
    expect(acls.aclEntities.exclude.length).to.be.greaterThan(0);
  });

  it('test getAcls for API Key', async () => {
    const acl = [
      { actions: ['R'], path: '/a' },
      { actions: ['C'], path: '/aaa' },
      { actions: ['D'], path: '/' },
      { actions: ['U'], path: '/aa' },
    ];
    const mockRole = {
      getName: () => 'myRole',
      getAcl: () => acl,
    };
    const mockRoleMembers = [{ getRole: () => mockRole }];
    const mockRoleMembersFn = (oid, ids) => {
      if (oid === 'DAB0@AdobeOrg') {
        if (ids.length === 2
          && ids.includes('imsOrgID:DAB0@AdobeOrg')
          && ids.includes('apiKeyID:BHEUAARK!')) {
          return mockRoleMembers;
        }
      }
      return null;
    };
    const mockDA = {
      RoleMember: {
        allRoleMembershipByIdentities: mockRoleMembersFn,
      },
    };
    const mockCDA = async (config) => {
      if (config.aclCtx.aclEntities.exclude.length === 2
        && config.aclCtx.aclEntities.exclude.includes('role')
        && config.aclCtx.aclEntities.exclude.includes('roleMember')) {
        return mockDA;
      }
      return null;
    };
    const getAcls = await esmock('../../../src/auth/rbac/acls.js', {
      '@adobe/spacecat-shared-data-access': {
        createDataAccess: mockCDA,
      },
    });

    const log = { debug: () => { } };
    const imsOrgs = ['DAB0@AdobeOrg'];
    const apiKey = 'BHEUAARK!';
    const acls = await getAcls({ imsOrgs, apiKey }, log);

    const expectedAcls = [{
      role: 'myRole',
      acl: [
        { actions: ['C'], path: '/aaa' },
        { actions: ['U'], path: '/aa' },
        { actions: ['R'], path: '/a' },
        { actions: ['D'], path: '/' },
      ],
    }];
    expect(acls.acls).to.deep.equal(expectedAcls);
    expect(acls.aclEntities.exclude.length).to.be.greaterThan(0);
  });
});
