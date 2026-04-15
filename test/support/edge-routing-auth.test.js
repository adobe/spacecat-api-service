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

import path from 'path';
import { fileURLToPath } from 'url';
import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';
import {
  authorizeEdgeCdnRouting,
  hasPaidLlmoProductContext,
} from '../../src/support/edge-routing-auth.js';

use(chaiAsPromised);
use(sinonChai);

const testDir = path.dirname(fileURLToPath(import.meta.url));
const utilsModulePath = path.join(testDir, '../../src/support/utils.js');

describe('edge-routing-auth', () => {
  let sandbox;
  let log;
  let getCookieValueStub;
  let exchangePromiseTokenStub;
  let getImsTokenFromCookie;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    log = { info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub() };
    getCookieValueStub = sandbox.stub();
    exchangePromiseTokenStub = sandbox.stub();

    const authMocked = await esmock('../../src/support/edge-routing-auth.js', {
      [utilsModulePath]: {
        getCookieValue: (...args) => getCookieValueStub(...args),
        exchangePromiseToken: (...args) => exchangePromiseTokenStub(...args),
      },
      '@adobe/spacecat-shared-utils': {
        hasText: (str) => typeof str === 'string' && str.trim().length > 0,
      },
      '@adobe/spacecat-shared-data-access': {
        Entitlement: {
          PRODUCT_CODES: { LLMO: 'LLMO' },
          TIERS: { PAID: 'PAID', FREE_TRIAL: 'FREE_TRIAL', PLG: 'PLG' },
        },
      },
    });
    getImsTokenFromCookie = authMocked.getImsTokenFromCookie;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getImsTokenFromCookie', () => {
    it('throws 400 when promiseToken cookie is missing', async () => {
      getCookieValueStub.returns(null);
      try {
        await getImsTokenFromCookie({ pathInfo: { headers: {} } });
        expect.fail('expected throw');
      } catch (e) {
        expect(e.status).to.equal(400);
        expect(e.message).to.include('promiseToken cookie is required');
      }
    });

    it('throws 401 when token exchange fails', async () => {
      getCookieValueStub.returns('ptok');
      exchangePromiseTokenStub.rejects(new Error('ims down'));
      const ctxLog = { error: sandbox.stub() };
      try {
        await getImsTokenFromCookie({
          pathInfo: { headers: { cookie: 'promiseToken=ptok' } },
          log: ctxLog,
        });
        expect.fail('expected throw');
      } catch (e) {
        expect(e.status).to.equal(401);
        expect(e.message).to.equal('Authentication failed with upstream IMS service');
        expect(ctxLog.error).to.have.been.calledWith(
          'Authentication failed with upstream IMS service',
          sinon.match.instanceOf(Error),
        );
      }
    });

    it('returns access token when exchange succeeds', async () => {
      getCookieValueStub.returns('ptok');
      exchangePromiseTokenStub.resolves('user-token');
      const token = await getImsTokenFromCookie({});
      expect(token).to.equal('user-token');
    });
  });

  describe('hasPaidLlmoProductContext', () => {
    it('returns false when projectedProductContext missing or empty', () => {
      expect(hasPaidLlmoProductContext({})).to.equal(false);
      expect(hasPaidLlmoProductContext({ projectedProductContext: [] })).to.equal(false);
    });

    it('returns true when dx_llmo service code is present', () => {
      expect(hasPaidLlmoProductContext({
        projectedProductContext: [{ prodCtx: { serviceCode: 'dx_llmo' } }],
      })).to.equal(true);
    });

    it('returns false when service code does not match', () => {
      expect(hasPaidLlmoProductContext({
        projectedProductContext: [{ prodCtx: { serviceCode: 'other' } }],
      })).to.equal(false);
    });
  });

  describe('authorizeEdgeCdnRouting', () => {
    const org = { getId: () => 'org-1' };
    const baseCtx = () => ({
      dataAccess: {
        Entitlement: {
          findByOrganizationIdAndProductCode: sandbox.stub().resolves({
            getTier: () => 'PAID',
          }),
        },
      },
      imsClient: {
        getImsUserProfile: sandbox.stub().resolves({
          projectedProductContext: [{ prodCtx: { serviceCode: 'dx_llmo' } }],
        }),
        getImsUserOrganizations: sandbox.stub().resolves([]),
      },
    });

    it('allows paid users with LLMO product context', async () => {
      await expect(
        authorizeEdgeCdnRouting(baseCtx(), {
          org, imsOrgId: 'x@AdobeOrg', imsUserToken: 't', siteId: 's1',
        }, log),
      ).to.be.fulfilled;
    });

    it('rejects when entitlement lookup throws (treated as no tier)', async () => {
      const ctx = baseCtx();
      ctx.dataAccess.Entitlement.findByOrganizationIdAndProductCode.rejects(new Error('db'));
      await expect(
        authorizeEdgeCdnRouting(ctx, {
          org, imsOrgId: 'x@AdobeOrg', imsUserToken: 't', siteId: 's1',
        }, log),
      ).to.be.rejectedWith('Site does not have an LLMO entitlement');
    });

    it('rejects paid users when IMS profile fetch fails', async () => {
      const ctx = baseCtx();
      ctx.imsClient.getImsUserProfile.rejects(new Error('ims'));
      await expect(
        authorizeEdgeCdnRouting(ctx, {
          org, imsOrgId: 'x@AdobeOrg', imsUserToken: 't', siteId: 's1',
        }, log),
      ).to.be.rejectedWith('Failed to validate user permissions');
    });

    it('rejects paid users without LLMO product context', async () => {
      const ctx = baseCtx();
      ctx.imsClient.getImsUserProfile.resolves({
        projectedProductContext: [{ prodCtx: { serviceCode: 'other' } }],
      });
      await expect(
        authorizeEdgeCdnRouting(ctx, {
          org, imsOrgId: 'x@AdobeOrg', imsUserToken: 't', siteId: 's1',
        }, log),
      ).to.be.rejectedWith('User does not have LLMO product access');
    });

    it('rejects trial when ims org id is missing', async () => {
      const ctx = baseCtx();
      ctx.dataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves({
        getTier: () => 'FREE_TRIAL',
      });
      await expect(
        authorizeEdgeCdnRouting(ctx, {
          org, imsOrgId: '', imsUserToken: 't', siteId: 's1',
        }, log),
      ).to.be.rejectedWith('Only LLMO administrators or LLMO Admin group members');
    });

    it('rejects trial when user is not in LLMO Admin group', async () => {
      const ctx = baseCtx();
      ctx.dataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves({
        getTier: () => 'FREE_TRIAL',
      });
      ctx.imsClient.getImsUserOrganizations.resolves([{
        orgRef: { ident: '12345', authSrc: 'AdobeOrg' },
        groups: [{ groupName: 'Other' }],
      }]);
      await expect(
        authorizeEdgeCdnRouting(ctx, {
          org, imsOrgId: '12345@AdobeOrg', imsUserToken: 't', siteId: 's1',
        }, log),
      ).to.be.rejectedWith('Only LLMO Admin group members can configure CDN routing');
    });

    it('rejects trial when matching org has no groups array', async () => {
      const ctx = baseCtx();
      ctx.dataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves({
        getTier: () => 'FREE_TRIAL',
      });
      ctx.imsClient.getImsUserOrganizations.resolves([{
        orgRef: { ident: '12345', authSrc: 'AdobeOrg' },
      }]);
      await expect(
        authorizeEdgeCdnRouting(ctx, {
          org, imsOrgId: '12345@AdobeOrg', imsUserToken: 't', siteId: 's1',
        }, log),
      ).to.be.rejectedWith('Only LLMO Admin group members can configure CDN routing');
    });

    it('allows trial users in LLMO Admin group for matching org', async () => {
      const ctx = baseCtx();
      ctx.dataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves({
        getTier: () => 'FREE_TRIAL',
      });
      ctx.imsClient.getImsUserOrganizations.resolves([{
        orgRef: { ident: '12345', authSrc: 'AdobeOrg' },
        groups: [{ groupName: 'LLMO Admin' }],
      }]);
      await expect(
        authorizeEdgeCdnRouting(ctx, {
          org, imsOrgId: '12345@AdobeOrg', imsUserToken: 't', siteId: 's1',
        }, log),
      ).to.be.fulfilled;
    });

    it('rejects trial when getImsUserOrganizations throws', async () => {
      const ctx = baseCtx();
      ctx.dataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves({
        getTier: () => 'FREE_TRIAL',
      });
      ctx.imsClient.getImsUserOrganizations.rejects(new Error('ims'));
      await expect(
        authorizeEdgeCdnRouting(ctx, {
          org, imsOrgId: '12345@AdobeOrg', imsUserToken: 't', siteId: 's1',
        }, log),
      ).to.be.rejectedWith('Only LLMO Admin group members can configure CDN routing');
    });

    it('rejects unknown entitlement tier', async () => {
      const ctx = baseCtx();
      ctx.dataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves({
        getTier: () => 'PLG',
      });
      await expect(
        authorizeEdgeCdnRouting(ctx, {
          org, imsOrgId: 'x@AdobeOrg', imsUserToken: 't', siteId: 's1',
        }, log),
      ).to.be.rejectedWith('Site does not have an LLMO entitlement');
    });
  });
});
