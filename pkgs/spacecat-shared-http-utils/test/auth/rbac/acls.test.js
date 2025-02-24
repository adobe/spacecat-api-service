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

import { getDBAcls, getDBRoles } from '../../../src/auth/rbac/acls.js';

describe('Get Roles', () => {
  it('get roles from DB', async () => {
    const commands = [];
    const client = {
      send(c) {
        commands.push(c);
        return {
          Items: [
            {
              roles: {
                SS: ['MY_ROLE1'],
              },
            },
            {
              roles: {
                SS: ['MY_ROLE2', 'MY_ROLE3'],
              },
            },
          ],
        };
      },
    };

    const imsUserId = 'abc@def.g';
    const imsOrgId = 'F00FEEFAA123';
    const imsGroups = {
      'F00FEEFAA123@AdobeOrg': {
        groups: [{
          groupid: '348994793',
          user_visible_name: 'MY_ROLE_PROFILE',
        }, {
          groupid: '348994794',
          user_visible_name: 'YOUR_ROLE_PROFILE',
        }],
      },
      'BAAD11BAA@AdobeOrg': {
        groups: [{
          groupid: '348994795',
          user_visible_name: 'MY_ROLE_PROFILE',
        }],
      },
    };

    const roles = await getDBRoles(client, { imsUserId, imsOrgId, imsGroups });
    expect(roles).to.deep.equal(new Set(['MY_ROLE1', 'MY_ROLE2', 'MY_ROLE3']));

    expect(commands).to.have.length(1);
    expect(commands[0].constructor.name).to.equal('QueryCommand');

    const eav = {
      ':userident': {
        S: 'imsID:abc@def.g',
      },
      ':orgid': {
        S: 'F00FEEFAA123',
      },
      ':orgident': {
        S: 'imsOrgID:F00FEEFAA123',
      },
      ':grp0': {
        S: 'imsOrgID/groupID:F00FEEFAA123/348994793',
      },
      ':grp1': {
        S: 'imsOrgID/groupID:F00FEEFAA123/348994794',
      },
    };
    expect(commands[0].input.ExpressionAttributeValues).to.deep.equal(eav);
    expect(commands[0].input.KeyConditionExpression).to.equal('orgid = :orgid');
    expect(commands[0].input.FilterExpression).to.equal(
      'identifier IN (:userident, :orgident, :grp0, :grp1)',
    );
    expect(commands[0].input.ProjectionExpression).to.equal('#roles');
    expect(commands[0].input.ExpressionAttributeNames).to.deep.equal(
      { '#roles': 'roles' },
    );
  });
});

describe('Get ACLs', async () => {
  it('get acls from DB', async () => {
    const commands = [];
    const client = {
      send(c) {
        commands.push(c);
        return {
          Items: [
            {
              role: {
                S: 'role1',
              },
              acl: {
                L: [{
                  M: {
                    actions: { SS: ['C', 'R', 'U', 'D'] },
                    path: { S: '/**' },
                  },
                }, {
                  M: {
                    actions: { SS: ['R'] },
                    path: { S: '/a' },
                  },
                }, {
                  M: {
                    actions: { SS: ['D'] },
                    path: { S: '/some/*/long/path/*' },
                  },
                }],
              },
            },
          ],
        };
      },
    };

    const orgId = 'FEEFAAF00';
    const roles = ['role1', 'role2'];
    const acls = await getDBAcls(client, orgId, roles);
    expect(acls).to.have.length(1);
    expect(acls[0].role).to.equal('role1');
    expect(acls[0].acl).to.have.length(3);
    expect(acls[0].acl[0].path).to.equal('/some/*/long/path/*');
    expect(acls[0].acl[0].actions).to.deep.equal(['D']);
    expect(acls[0].acl[1].path).to.equal('/a');
    expect(acls[0].acl[1].actions).to.deep.equal(['R']);
    expect(acls[0].acl[2].path).to.equal('/**');
    expect(acls[0].acl[2].actions).to.deep.equal(['C', 'R', 'U', 'D']);

    expect(commands).to.have.length(1);
    const { input } = commands[0];
    expect(input.KeyConditionExpression).to.equal('imsorgid = :orgid');
    expect(input.ExpressionAttributeValues).to.deep.equal({
      ':orgid': { S: orgId },
      ':role0': { S: 'role1' },
      ':role1': { S: 'role2' },
    });
    expect(input.FilterExpression).to.equal('#role IN (:role0, :role1)');
    expect(input.ProjectionExpression).to.equal('acl, #role');
    expect(input.ExpressionAttributeNames).to.deep.equal({ '#role': 'role' });
  });
});
