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
  it.only('test haspermission', () => {
    const aclCtx = {
      user: { ident: 'AA@BB.e' },
      acls: [
        {
          ident: 'AA@BB.e',
          identType: 'ident',
          acl: [
            { path: '/someapi', actions: ['R'] },
            { path: '/someapi/**', actions: ['C', 'R', 'U', 'D'] },
            { path: '/someapi/specificid', actions: [] },
            { path: '/someapi/someid/*', actions: ['D'] },
            { path: '/someapi/*/myop', actions: ['R'] },
          ],
        },
      ],
    };

    // Ensure the paths are sorted with the longest first
    aclCtx.acls.forEach((a) => a.acl.sort(pathSorter));

    // matching rule: /someapi/**
    expect(hasPermisson('/someapi/xyz123', aclCtx, 'C')).to.be.true;
    expect(hasPermisson('/someapi/xyz123', aclCtx, 'R')).to.be.true;
    expect(hasPermisson('/someapi/xyz123', aclCtx, 'U')).to.be.true;
    expect(hasPermisson('/someapi/xyz123', aclCtx, 'D')).to.be.true;

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
