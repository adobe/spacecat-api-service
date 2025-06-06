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
import { Site, Organization } from '@adobe/spacecat-shared-data-access';

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
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

  const sandbox = sinon.createSandbox();
  let context;
  let logSpy;

  beforeEach(() => {
    logSpy = sandbox.spy();
    context = {
      log: { info: logSpy },
      attributes: {
        authInfo: {
          getType: () => 'jwt',
          isAdmin: () => false,
          hasOrganization: () => true,
          hasScope: () => true,
        },
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  // Test anonymous endpoints
  it('handles anonymous Slack endpoints', () => {
    const slackContext = {
      log: { info: logSpy },
      pathInfo: {
        method: 'GET',
        suffix: '/slack/events',
      },
    };

    const util = AccessControlUtil.fromContext(slackContext);
    expect(logSpy).to.have.been.calledWith('Anonymous endpoint, skipping authorization: GET /slack/events');
    expect(util.authInfo).to.exist;
    expect(util.authInfo.getProfile().user_id).to.equal('anonymous');
  });

  it('handles anonymous site detection endpoints', () => {
    const slackContext = {
      log: { info: logSpy },
      pathInfo: {
        method: 'POST',
        suffix: '/hooks/site-detection/cdn/some-secret',
      },
    };

    const util = AccessControlUtil.fromContext(slackContext);
    expect(logSpy).to.have.been.calledWith('Anonymous endpoint, skipping authorization: POST /hooks/site-detection/cdn/***********');
    expect(util.authInfo).to.exist;
    expect(util.authInfo.getProfile().user_id).to.equal('anonymous');
  });

  it('handles POST slack endpoints', () => {
    const slackContext = {
      log: { info: logSpy },
      pathInfo: {
        method: 'POST',
        suffix: '/slack/events',
      },
    };

    const util = AccessControlUtil.fromContext(slackContext);
    expect(logSpy).to.have.been.calledWith('Anonymous endpoint, skipping authorization: POST /slack/events');
    expect(util.authInfo).to.exist;
    expect(util.authInfo.getProfile().user_id).to.equal('anonymous');
  });

  // Test error cases in hasAccess
  it('throws error when entity is missing in hasAccess', async () => {
    const util = AccessControlUtil.fromContext(context);
    await expect(util.hasAccess(null)).to.be.rejectedWith('Missing entity');
    await expect(util.hasAccess(undefined)).to.be.rejectedWith('Missing entity');
    await expect(util.hasAccess({})).to.be.rejectedWith('Missing entity');
  });

  // Test organization related checks
  it('throws error when site has no organization', async () => {
    const util = AccessControlUtil.fromContext(context);
    const site = {
      getOrganization: async () => null,
    };
    // Make site instanceof Site return true
    Object.setPrototypeOf(site, Site.prototype);

    await expect(util.hasAccess(site)).to.be.rejectedWith('Missing organization for site');
  });

  it('handles different entity types correctly', async () => {
    const util = AccessControlUtil.fromContext(context);

    // Test with Site entity
    const site = {
      getOrganization: async () => ({
        getImsOrgId: () => 'test-org-id',
      }),
    };
    Object.setPrototypeOf(site, Site.prototype);

    // Test with Organization entity
    const org = {
      getImsOrgId: () => 'test-org-id',
    };
    Object.setPrototypeOf(org, Organization.prototype);

    const siteResult = await util.hasAccess(site);
    const orgResult = await util.hasAccess(org);

    expect(siteResult).to.be.true;
    expect(orgResult).to.be.true;
  });

  // Test constructor error cases
  it('throws error when context is missing', () => {
    expect(() => AccessControlUtil.fromContext()).to.throw('Missing context');
    expect(() => AccessControlUtil.fromContext(null)).to.throw('Missing context');

    // Test for missing authInfo with valid context but no attributes
    expect(() => AccessControlUtil.fromContext({
      log: { info: () => {} },
      pathInfo: {},
    })).to.throw('Missing authInfo');
  });

  describe('hasAccess with subService', () => {
    let util;
    let mockAuthInfo;

    beforeEach(() => {
      mockAuthInfo = {
        getType: () => 'jwt',
        isAdmin: () => false,
        hasOrganization: sinon.stub(),
        hasScope: sinon.stub(),
      };

      const testContext = {
        log: { info: () => {} },
        attributes: {
          authInfo: mockAuthInfo,
        },
      };

      util = AccessControlUtil.fromContext(testContext);
    });

    it('checks scope for auto_fix subService', async () => {
      const site = {
        getOrganization: async () => ({
          getImsOrgId: () => 'test-org-id',
        }),
      };
      Object.setPrototypeOf(site, Site.prototype);

      mockAuthInfo.hasOrganization.returns(true);
      mockAuthInfo.hasScope.returns(true);

      const result = await util.hasAccess(site, 'auto_fix');

      expect(mockAuthInfo.hasOrganization).to.have.been.calledWith('test-org-id');
      expect(mockAuthInfo.hasScope).to.have.been.calledWith('user', 'dx_aem_perf_auto_fix');
      expect(result).to.be.true;
    });

    it('checks scope for auto_suggest subService', async () => {
      const site = {
        getOrganization: async () => ({
          getImsOrgId: () => 'test-org-id',
        }),
      };
      Object.setPrototypeOf(site, Site.prototype);

      mockAuthInfo.hasOrganization.returns(true);
      mockAuthInfo.hasScope.returns(true);

      const result = await util.hasAccess(site, 'auto_suggest');

      expect(mockAuthInfo.hasOrganization).to.have.been.calledWith('test-org-id');
      expect(mockAuthInfo.hasScope).to.have.been.calledWith('user', 'dx_aem_perf_auto_suggest');
      expect(result).to.be.true;
    });

    it('returns false when org access is true but scope check fails', async () => {
      const site = {
        getOrganization: async () => ({
          getImsOrgId: () => 'test-org-id',
        }),
      };
      Object.setPrototypeOf(site, Site.prototype);

      mockAuthInfo.hasOrganization.returns(true);
      mockAuthInfo.hasScope.returns(false);

      const result = await util.hasAccess(site, 'auto_fix');

      expect(mockAuthInfo.hasOrganization).to.have.been.calledWith('test-org-id');
      expect(mockAuthInfo.hasScope).to.have.been.calledWith('user', 'dx_aem_perf_auto_fix');
      expect(result).to.be.false;
    });

    it('returns false when both org access and scope check fail', async () => {
      const site = {
        getOrganization: async () => ({
          getImsOrgId: () => 'test-org-id',
        }),
      };
      Object.setPrototypeOf(site, Site.prototype);

      mockAuthInfo.hasOrganization.returns(false);
      mockAuthInfo.hasScope.returns(false);

      const result = await util.hasAccess(site, 'auto_fix');

      expect(mockAuthInfo.hasOrganization).to.have.been.calledWith('test-org-id');
      expect(mockAuthInfo.hasScope).to.not.have.been.called;
      expect(result).to.be.false;
    });
  });
});
