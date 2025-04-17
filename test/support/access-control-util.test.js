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

import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import { Site } from '@adobe/spacecat-shared-data-access';

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
// import sinon, { stub } from 'sinon';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('Access Control Util', () => {
  it('should throw an error if context is not provided', () => {
    expect(() => AccessControlUtil.fromContext()).to.throw('Missing context');
  });

  it('should throw an error if authInfo is not provided', () => {
    const context = { test: {} };
    expect(() => AccessControlUtil.fromContext(context)).to.throw('Missing authInfo');
  });

  it('should check if user has admin access', () => {
    const authInfo = new AuthInfo()
      .withType('jwt')
      .withProfile({
        is_admin: true,
      });

    const context = { attributes: { authInfo } };
    const accessControlUtil = AccessControlUtil.fromContext(context);
    expect(accessControlUtil.hasAdminAccess()).to.be.true;
  });

  it('should throw an error if entity is not provided', async () => {
    const context = { attributes: { authInfo: new AuthInfo() } };
    const accessControlUtil = AccessControlUtil.fromContext(context);
    try {
      await accessControlUtil.hasAccess();
    } catch (error) {
      expect(error.message).to.equal('Missing entity');
    }
  });

  xit('should check if user is part of the organization based on the Site entity', async () => {
    const orgId = '12345';

    const site = await Site.create({
      id: 'site1',
      name: 'Test Site',
      organizationId: orgId,
    });
    const authInfo = new AuthInfo()
      .withProfile({
        tenants: [{
          id: orgId,
        }],
      });
    const context = { attributes: { authInfo } };
    const accessControlUtil = AccessControlUtil.fromContext(context);
    const hasAccess = await accessControlUtil.hasAccess(site);
    expect(hasAccess).to.be.true;
  });

  xit('should check if user is part of the organization based on the Organization entity', async () => {
    const orgId = '12345';
    const org = {
      getImsOrgId: () => orgId,
    };
    const authInfo = new AuthInfo()
      .withProfile({
        tenants: [{
          id: orgId,
        }],
      });
    const context = { attributes: { authInfo } };
    const accessControlUtil = AccessControlUtil.fromContext(context);
    const hasAccess = await accessControlUtil.hasAccess(org);
    expect(hasAccess).to.be.true;
  });
});
