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
  resolveWriteTimeProductCode,
  shouldPreserveExistingEntitlementTier,
  SITE_ORPHANED_AFTER_CREATE_EVENT,
  wouldDowngradeExistingTier,
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

  describe('resolveWriteTimeProductCode', () => {
    it('returns null product when header is absent', () => {
      const result = resolveWriteTimeProductCode({ pathInfo: { headers: {} } });
      expect(result).to.deep.equal({ error: null, productCode: null });
    });

    it('returns 400-style error for unsupported product codes', () => {
      const result = resolveWriteTimeProductCode({
        pathInfo: { headers: { 'x-product': 'INVALID' } },
      });
      expect(result.productCode).to.be.undefined;
      expect(result.error).to.match(/Unsupported product code/);
      expect(result.error).to.include('ASO');
    });

    it('trims and accepts valid product codes', () => {
      const result = resolveWriteTimeProductCode({
        pathInfo: { headers: { 'x-product': '  ASO  ' } },
      });
      expect(result).to.deep.equal({ error: null, productCode: 'ASO' });
    });
  });

  describe('wouldDowngradeExistingTier', () => {
    it('flags PLG and PRE_ONBOARD as downgrade risks for FREE_TRIAL', () => {
      expect(wouldDowngradeExistingTier('PLG', 'FREE_TRIAL')).to.equal(true);
      expect(wouldDowngradeExistingTier('PRE_ONBOARD', 'FREE_TRIAL')).to.equal(true);
    });

    it('does not flag PAID or FREE_TRIAL', () => {
      expect(wouldDowngradeExistingTier('PAID', 'FREE_TRIAL')).to.equal(false);
      expect(wouldDowngradeExistingTier('FREE_TRIAL', 'FREE_TRIAL')).to.equal(false);
    });
  });

  describe('shouldPreserveExistingEntitlementTier', () => {
    it('preserves PAID and elevated non-PAID tiers', () => {
      expect(shouldPreserveExistingEntitlementTier('PAID')).to.equal(true);
      expect(shouldPreserveExistingEntitlementTier('PRE_ONBOARD')).to.equal(true);
      expect(shouldPreserveExistingEntitlementTier('FREE_TRIAL')).to.equal(false);
    });
  });

  describe('ensureOrgEntitlement', () => {
    it('skips createEntitlement when org already has PAID tier', async () => {
      const tierClient = {
        checkValidEntitlement: sandbox.stub().resolves({
          entitlement: { getId: () => 'ent-1', getTier: () => 'PAID' },
        }),
        createEntitlement: sandbox.stub(),
      };
      sandbox.stub(TierClient, 'createForOrg').returns(tierClient);
      const organization = { getId: () => 'org-1' };

      const entitlement = await ensureOrgEntitlement({}, organization, 'ASO', log);

      expect(entitlement.getId()).to.equal('ent-1');
      expect(tierClient.createEntitlement).to.not.have.been.called;
    });

    it('calls createEntitlement when no entitlement exists', async () => {
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
    it('does not downgrade PRE_ONBOARD and reuses existing enrollment', async () => {
      const tierClient = {
        checkValidEntitlement: sandbox.stub().resolves({
          entitlement: { getId: () => 'ent-1', getTier: () => 'PRE_ONBOARD' },
          siteEnrollment: { getId: () => 'enr-1' },
        }),
        createEntitlement: sandbox.stub(),
      };
      sandbox.stub(TierClient, 'createForSite').resolves(tierClient);
      const site = {
        getId: () => 'site-1',
        getOrganizationId: sandbox.stub().resolves('org-1'),
      };

      const result = await ensureSiteEntitlementAndEnrollment(
        { dataAccess: { SiteEnrollment: { create: sandbox.stub() } } },
        site,
        'ASO',
        log,
      );

      expect(tierClient.createEntitlement).to.not.have.been.called;
      expect(result.siteEnrollment.getId()).to.equal('enr-1');
    });

    it('calls createEntitlement when no entitlement exists', async () => {
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

      await ensureSiteEntitlementAndEnrollment(
        { dataAccess: { SiteEnrollment: { create: sandbox.stub() } } },
        site,
        'ASO',
        log,
      );

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

      await ensureSiteEntitlementAndEnrollment(
        { dataAccess: { SiteEnrollment: { create: sandbox.stub() } } },
        site,
        'ASO',
        log,
      );

      expect(log.info).to.have.been.calledWithMatch(/and enrollment enr-new/);
    });

    it('creates site enrollment only when tier is preserved and enrollment is missing', async () => {
      const tierClient = {
        checkValidEntitlement: sandbox.stub().resolves({
          entitlement: { getId: () => 'ent-1', getTier: () => 'PRE_ONBOARD' },
          siteEnrollment: null,
        }),
        createEntitlement: sandbox.stub(),
      };
      sandbox.stub(TierClient, 'createForSite').resolves(tierClient);
      const siteEnrollmentCreate = sandbox.stub().resolves({ getId: () => 'enr-new' });
      const site = {
        getId: () => 'site-1',
        getOrganizationId: sandbox.stub().resolves('org-1'),
      };

      await ensureSiteEntitlementAndEnrollment(
        { dataAccess: { SiteEnrollment: { create: siteEnrollmentCreate } } },
        site,
        'ASO',
        log,
      );

      expect(tierClient.createEntitlement).to.not.have.been.called;
      expect(siteEnrollmentCreate).to.have.been.calledOnceWith({
        siteId: 'site-1',
        entitlementId: 'ent-1',
      });
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
