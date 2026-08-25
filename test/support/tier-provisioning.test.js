/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import TierClient from '@adobe/spacecat-shared-tier-client';
import {
  ensureOrgEntitlement,
  ensureSiteEntitlementAndEnrollment,
  logSiteOrphanedAfterCreate,
  resolveProductCode,
  SITE_ORPHANED_AFTER_CREATE_EVENT,
} from '../../src/support/tier-provisioning.js';

use(chaiAsPromised);
use(sinonChai);

describe('tier-provisioning', () => {
  const sandbox = sinon.createSandbox();
  const log = {
    info: sandbox.stub(),
    error: sandbox.stub(),
  };

  afterEach(() => {
    sandbox.restore();
  });

  describe('resolveProductCode', () => {
    it('returns null product when header is absent', () => {
      const result = resolveProductCode({ pathInfo: { headers: {} } });
      expect(result).to.deep.equal({ error: null, productCode: null });
    });

    it('returns 400-style error for unsupported product codes', () => {
      const result = resolveProductCode({
        pathInfo: { headers: { 'x-product': 'INVALID' } },
      });
      expect(result.productCode).to.be.undefined;
      expect(result.error).to.match(/Unsupported product code/);
      expect(result.error).to.include('ASO');
    });

    it('trims and accepts valid product codes', () => {
      const result = resolveProductCode({
        pathInfo: { headers: { 'x-product': '  ASO  ' } },
      });
      expect(result).to.deep.equal({ error: null, productCode: 'ASO' });
    });
  });

  describe('ensureOrgEntitlement', () => {
    it('calls createEntitlement with existing tier when org already has PAID', async () => {
      const tierClient = {
        checkValidEntitlement: sandbox.stub().resolves({
          entitlement: { getId: () => 'ent-1', getTier: () => 'PAID' },
        }),
        createEntitlement: sandbox.stub().resolves({
          entitlement: { getId: () => 'ent-1', getTier: () => 'PAID' },
        }),
      };
      sandbox.stub(TierClient, 'createForOrg').returns(tierClient);
      const organization = { getId: () => 'org-1' };

      await ensureOrgEntitlement({}, organization, 'ASO', log);

      expect(tierClient.createEntitlement).to.have.been.calledOnceWith('PAID');
    });

    it('calls createEntitlement with FREE_TRIAL when no entitlement exists', async () => {
      const tierClient = {
        checkValidEntitlement: sandbox.stub().resolves({ entitlement: null }),
        createEntitlement: sandbox.stub().resolves({
          entitlement: { getId: () => 'ent-new', getTier: () => 'FREE_TRIAL' },
        }),
      };
      sandbox.stub(TierClient, 'createForOrg').returns(tierClient);
      const organization = { getId: () => 'org-1' };

      await ensureOrgEntitlement({}, organization, 'ASO', log);

      expect(tierClient.createEntitlement).to.have.been.calledOnceWith('FREE_TRIAL');
    });
  });

  describe('ensureSiteEntitlementAndEnrollment', () => {
    it('calls createEntitlement with existing tier when entitlement is PRE_ONBOARD', async () => {
      const tierClient = {
        checkValidEntitlement: sandbox.stub().resolves({
          entitlement: { getId: () => 'ent-1', getTier: () => 'PRE_ONBOARD' },
          siteEnrollment: { getId: () => 'enr-1' },
        }),
        createEntitlement: sandbox.stub().resolves({
          entitlement: { getId: () => 'ent-1' },
          siteEnrollment: { getId: () => 'enr-1' },
        }),
      };
      sandbox.stub(TierClient, 'createForSite').resolves(tierClient);
      const site = {
        getId: () => 'site-1',
        getOrganizationId: sandbox.stub().resolves('org-1'),
      };

      await ensureSiteEntitlementAndEnrollment({}, site, 'ASO', log);

      expect(tierClient.createEntitlement).to.have.been.calledOnceWith('PRE_ONBOARD');
    });

    it('calls createEntitlement with FREE_TRIAL when no entitlement exists', async () => {
      const tierClient = {
        checkValidEntitlement: sandbox.stub().resolves({
          entitlement: null,
          siteEnrollment: null,
        }),
        createEntitlement: sandbox.stub().resolves({
          entitlement: { getId: () => 'ent-new' },
          siteEnrollment: null,
        }),
      };
      sandbox.stub(TierClient, 'createForSite').resolves(tierClient);
      const site = {
        getId: () => 'site-1',
        getOrganizationId: sandbox.stub().resolves('org-1'),
      };

      await ensureSiteEntitlementAndEnrollment({}, site, 'ASO', log);

      expect(tierClient.createEntitlement).to.have.been.calledOnceWith('FREE_TRIAL');
      expect(log.info).to.have.been.calledWithMatch(/Ensured ASO entitlement ent-new for site site-1/);
    });

    it('logs enrollment id when createEntitlement returns a site enrollment', async () => {
      const tierClient = {
        checkValidEntitlement: sandbox.stub().resolves({
          entitlement: null,
          siteEnrollment: null,
        }),
        createEntitlement: sandbox.stub().resolves({
          entitlement: { getId: () => 'ent-new' },
          siteEnrollment: { getId: () => 'enr-new' },
        }),
      };
      sandbox.stub(TierClient, 'createForSite').resolves(tierClient);
      const site = {
        getId: () => 'site-1',
        getOrganizationId: sandbox.stub().resolves('org-1'),
      };

      await ensureSiteEntitlementAndEnrollment({}, site, 'ASO', log);

      expect(log.info).to.have.been.calledWithMatch(/and enrollment enr-new/);
    });
  });

  describe('logSiteOrphanedAfterCreate', () => {
    it('logs structured orphan event', () => {
      const site = { getId: () => 'site-1' };
      const error = new Error('tier failure');

      logSiteOrphanedAfterCreate(log, site, 'ASO', error);

      expect(log.error).to.have.been.calledOnce;
      expect(log.error.firstCall.args[0]).to.include(`event=${SITE_ORPHANED_AFTER_CREATE_EVENT}`);
      expect(log.error.firstCall.args[0]).to.include('siteId=site-1');
      expect(log.error.firstCall.args[1]).to.equal(error);
    });
  });
});
