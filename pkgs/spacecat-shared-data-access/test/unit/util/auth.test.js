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
import { hasPermisson, pathSorter } from '../../../src/util/auth.js';

describe('haspermission', () => {
  it('test haspermission no perms', () => {
    const aclCtx = {
      acls: [{
        role: 'not-much-at-all',
      }],
    };
    expect(hasPermisson('/someapi/123', aclCtx, 'R')).to.be.false;
  });

  it('test haspermission multiple roles', () => {
    const aclCtx = {
      acls: [
        {
          role: 'no-perms-role',
          acl: [],
        },
        {
          role: 'role1',
          acl: [
            { path: '/some/where/out/there', actions: ['D'] },
            { path: '/here/where/out/there', actions: ['D'] },
          ],
        },
        {
          role: 'some-admin',
          acl: [{ path: '/some/**', actions: ['C', 'R', 'U'] }],
        },
      ],
    };

    // Matches both role1 and some-admin so get all CRUD
    expect(hasPermisson('/some/where/out/there', aclCtx, 'C')).to.be.true;
    expect(hasPermisson('/some/where/out/there', aclCtx, 'R')).to.be.true;
    expect(hasPermisson('/some/where/out/there', aclCtx, 'U')).to.be.true;
    expect(hasPermisson('/some/where/out/there', aclCtx, 'D')).to.be.true;

    // Matches only some-admin
    expect(hasPermisson('/some/thing', aclCtx, 'C')).to.be.true;
    expect(hasPermisson('/some/thing', aclCtx, 'R')).to.be.true;
    expect(hasPermisson('/some/thing', aclCtx, 'U')).to.be.true;
    expect(hasPermisson('/some/thing', aclCtx, 'D')).to.be.false;

    // Only matches role1
    expect(hasPermisson('/here/where/out/there', aclCtx, 'C')).to.be.false;
    expect(hasPermisson('/here/where/out/there', aclCtx, 'R')).to.be.false;
    expect(hasPermisson('/here/where/out/there', aclCtx, 'U')).to.be.false;
    expect(hasPermisson('/here/where/out/there', aclCtx, 'D')).to.be.true;

    // Matches nothing
    expect(hasPermisson('/something', aclCtx, 'C')).to.be.false;
    expect(hasPermisson('/something', aclCtx, 'R')).to.be.false;
    expect(hasPermisson('/something', aclCtx, 'U')).to.be.false;
    expect(hasPermisson('/something', aclCtx, 'D')).to.be.false;
  });

  it('test haspermission', () => {
    const aclCtx = {
      acls: [
        {
          role: 'some-role',
          acl: [
            { path: '/someapi', actions: ['R'] },
            { path: '/someapi/**', actions: ['C', 'R', 'U', 'D'] },
            { path: '/someapi/specificid', actions: [] },
            { path: '/someapi/someid/*', actions: ['D'] },
            { path: '/someapi/*/myop', actions: ['R'] },
            { path: '/someapi/test/+**', actions: ['R', 'U'] },
          ],
        },
      ],
    };

    // Ensure the paths are sorted with the longest first
    aclCtx.acls.forEach((a) => a.acl.sort(pathSorter));

    // matching rule: /someapi/test/+**
    expect(hasPermisson('/someapi/test', aclCtx, 'R')).to.be.true;
    expect(hasPermisson('/someapi/test', aclCtx, 'U')).to.be.true;
    expect(hasPermisson('/someapi/test', aclCtx, 'C')).to.be.false;
    expect(hasPermisson('/someapi/test', aclCtx, 'D')).to.be.false;
    expect(hasPermisson('/someapi/test/123', aclCtx, 'R')).to.be.true;
    expect(hasPermisson('/someapi/test/123', aclCtx, 'U')).to.be.true;
    expect(hasPermisson('/someapi/test/123', aclCtx, 'C')).to.be.false;
    expect(hasPermisson('/someapi/test/123', aclCtx, 'D')).to.be.false;
    expect(hasPermisson('/someapi/test/123/foo', aclCtx, 'R')).to.be.true;
    expect(hasPermisson('/someapi/test/123/foo', aclCtx, 'U')).to.be.true;
    expect(hasPermisson('/someapi/test/123/foo', aclCtx, 'C')).to.be.false;
    expect(hasPermisson('/someapi/test/123/foo', aclCtx, 'D')).to.be.false;

    // matching rule: /someapi/**
    expect(hasPermisson('/someapi/xyz123', aclCtx, 'C')).to.be.true;
    expect(hasPermisson('/someapi/xyz123', aclCtx, 'R')).to.be.true;
    expect(hasPermisson('/someapi/xyz123', aclCtx, 'U')).to.be.true;
    expect(hasPermisson('/someapi/xyz123', aclCtx, 'D')).to.be.true;
    expect(hasPermisson('/someapi/tes', aclCtx, 'R')).to.be.true;
    expect(hasPermisson('/someapi/tes', aclCtx, 'U')).to.be.true;
    expect(hasPermisson('/someapi/tes', aclCtx, 'C')).to.be.true;
    expect(hasPermisson('/someapi/tes', aclCtx, 'D')).to.be.true;

    // matching rule: /someapi/specificid
    expect(hasPermisson('/someapi/specificid', aclCtx, 'C')).to.be.false;
    expect(hasPermisson('/someapi/specificid', aclCtx, 'R')).to.be.false;
    expect(hasPermisson('/someapi/specificid', aclCtx, 'U')).to.be.false;
    expect(hasPermisson('/someapi/specificid', aclCtx, 'D')).to.be.false;

    // matching rule: /someapi
    expect(hasPermisson('/someapi', aclCtx, 'C')).to.be.false;
    expect(hasPermisson('/someapi', aclCtx, 'R')).to.be.true;
    expect(hasPermisson('/someapi', aclCtx, 'U')).to.be.false;
    expect(hasPermisson('/someapi', aclCtx, 'D')).to.be.false;

    // matching rule: /someapi/*/myop
    expect(hasPermisson('/someapi/specificid/myop', aclCtx, 'C')).to.be.false;
    expect(hasPermisson('/someapi/specificid/myop', aclCtx, 'R')).to.be.true;
    expect(hasPermisson('/someapi/specificid/myop', aclCtx, 'U')).to.be.false;
    expect(hasPermisson('/someapi/specificid/myop', aclCtx, 'D')).to.be.false;

    // matching rule: /someapi/*/myop
    expect(hasPermisson('/someapi/999/myop', aclCtx, 'C')).to.be.false;
    expect(hasPermisson('/someapi/999/myop', aclCtx, 'R')).to.be.true;
    expect(hasPermisson('/someapi/999/myop', aclCtx, 'U')).to.be.false;
    expect(hasPermisson('/someapi/999/myop', aclCtx, 'D')).to.be.false;

    // matching rule: /someapi/**
    expect(hasPermisson('/someapi/9/9/myop', aclCtx, 'C')).to.be.true;
    expect(hasPermisson('/someapi/9/9/myop', aclCtx, 'R')).to.be.true;
    expect(hasPermisson('/someapi/9/9/myop', aclCtx, 'U')).to.be.true;
    expect(hasPermisson('/someapi/9/9/myop', aclCtx, 'D')).to.be.true;

    // matching rule: /someapi/someid/*
    expect(hasPermisson('/someapi/someid/777', aclCtx, 'C')).to.be.false;
    expect(hasPermisson('/someapi/someid/777', aclCtx, 'R')).to.be.false;
    expect(hasPermisson('/someapi/someid/777', aclCtx, 'U')).to.be.false;
    expect(hasPermisson('/someapi/someid/777', aclCtx, 'D')).to.be.true;

    // matching rule: /someapi/**
    expect(hasPermisson('/someapi/someid/777/someop', aclCtx, 'C')).to.be.true;
    expect(hasPermisson('/someapi/someid/777/someop', aclCtx, 'R')).to.be.true;
    expect(hasPermisson('/someapi/someid/777/someop', aclCtx, 'U')).to.be.true;
    expect(hasPermisson('/someapi/someid/777/someop', aclCtx, 'D')).to.be.true;
  });
});
