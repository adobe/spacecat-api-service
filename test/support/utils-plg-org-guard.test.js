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
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);

/**
 * Unit tests for the PLG-tier org guard in onboardSingleSite (utils.js).
 *
 * A PLG ASO entitlement supports exactly one enrolled domain per org — it's an
 * org-level record, not per-site. The RESTRICTED_TIERS check elsewhere in this
 * function only blocks *requesting* tier=PLG; it does nothing to stop this command
 * from onboarding a brand-new domain (tier FREE_TRIAL or PAID) into an org that
 * already holds a PLG entitlement bound to a different site. SITES-49886 (#3074)
 * stopped that from silently retiering the shared entitlement, but still let the new
 * domain's Site row get created and its audits/opportunities run once. This guard
 * blocks it outright instead. Re-onboarding the *same* site that already holds the
 * enrollment is unaffected, and additionalParams.forceTierUpdate (the same escape
 * hatch #3074 introduced) can override.
 *
 * PRE_ONBOARD is deliberately out of scope — it's an internal staging tier without
 * PLG's "single customer-facing domain" constraint.
 *
 * Org resolution: when the site already exists, the guard reads the org straight off
 * `prefetchedSite.getOrganizationId()` instead of resolving `Organization.findByImsOrgId
 * (imsOrgID)` — mirroring createSiteAndOrganization, which does the same and ignores
 * imsOrgID entirely for an existing site. imsOrgID can legitimately point elsewhere (it
 * defaults to env.DEMO_IMS_ORG when the caller omits it on a re-onboard); resolving by
 * imsOrgID in that case would check the wrong org's entitlement and silently let a
 * re-onboard that should be blocked run its full pipeline for nothing.
 */
describe('onboardSingleSite — PLG-tier org guard', () => {
  const SITE_URL = 'https://example.com';
  const IMS_ORG_ID = 'ABCDEF1234567890ABCDEF12@AdobeOrg';
  const GUARD_WARNING_PATTERN = /already has a \*PLG\* ASO entitlement/;

  let sandbox;
  let onboardSingleSite;
  let sayStub;

  before(async function beforeHook() {
    // esmock's cold load of utils.js can exceed the 2s default hook timeout.
    this.timeout(15000);
    ({ onboardSingleSite } = await esmock('../../src/support/utils.js', {
      '@aws-sdk/client-sfn': {
        // eslint-disable-next-line func-style
        SFNClient: function SFNClient() { this.send = () => Promise.resolve({ executionArn: 'arn:test' }); },
        // eslint-disable-next-line func-style
        StartExecutionCommand: function StartExecutionCommand() {},
      },
      '@adobe/spacecat-shared-utils': {
        isValidUrl: () => true,
        isValidIMSOrgId: () => true,
        hasText: (s) => !!(s && s.trim && s.trim().length > 0),
        isObject: (o) => o !== null && typeof o === 'object',
        isNonEmptyObject: (o) => o !== null && typeof o === 'object' && Object.keys(o).length > 0,
        resolveCanonicalUrl: sinon.stub().resolves(SITE_URL),
        detectLocale: sinon.stub().resolves({ language: 'en', region: 'US' }),
        detectAEMVersion: sinon.stub().resolves(null),
        tracingFetch: sinon.stub().resolves({ ok: false }),
        wwwUrlResolver: sinon.stub().returns(SITE_URL),
        getLastNumberOfWeeks: sinon.stub().returns([]),
      },
      '@adobe/spacecat-shared-tier-client': {
        // eslint-disable-next-line func-style
        default: {
          createForSite: async () => ({
            createEntitlement: async () => ({
              entitlement: { getId: () => 'ent-test' },
              siteEnrollment: { getId: () => 'enr-test' },
            }),
          }),
        },
      },
    }));
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sayStub = sandbox.stub().resolves();
  });

  afterEach(() => {
    sandbox.restore();
  });

  const demoProfile = { audits: { cwv: {} }, imports: {}, config: {} };

  const slackContext = () => ({
    say: sayStub,
    channelId: 'C123',
    threadTs: '123.456',
  });

  const makeOrg = () => ({ getId: () => 'org-plg-1' });

  const makeEntitlement = (tier) => ({
    getId: () => `ent-${tier}`,
    getTier: () => tier,
  });

  // Minimal config satisfying the paid-profile guard that runs earlier in the
  // function — no paid signals, so it falls through to the single-domain tier guard.
  const nonPaidConfig = () => ({
    getImports: () => [],
    getOnboardConfig: () => undefined,
  });

  // Site not yet enrolled under the entitlement — a genuinely different domain.
  const makeUnrelatedSite = () => ({
    getConfig: nonPaidConfig,
    getOrganizationId: () => 'org-plg-1',
    getSiteEnrollments: sandbox.stub().resolves([]),
  });

  // Site already enrolled under the same entitlement — safe to re-onboard.
  const makeSameEnrolledSite = (entitlementId) => ({
    getConfig: nonPaidConfig,
    getOrganizationId: () => 'org-plg-1',
    getSiteEnrollments: sandbox.stub().resolves([
      { getEntitlementId: () => entitlementId },
    ]),
  });

  /**
   * Builds a minimal context for testing the guard.
   * @param {object} [opts]
   * @param {object|null} [opts.org] - Organization.findByImsOrgId resolution.
   * @param {object|null} [opts.entitlement] - Entitlement.findByOrganizationIdAndProductCode
   *   resolution.
   * @param {object|null} [opts.guardSite] - Site.findByBaseURL resolution.
   */
  const makeContext = ({ org = null, entitlement = null, guardSite = null } = {}) => ({
    log: {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
      debug: sandbox.stub(),
    },
    env: {
      DEMO_IMS_ORG: IMS_ORG_ID,
      WORKFLOW_WAIT_TIME_IN_SECONDS: 300,
      ONBOARD_WORKFLOW_STATE_MACHINE_ARN: 'arn:aws:states:us-east-1:123:stateMachine:test',
    },
    dataAccess: {
      Site: {
        findByBaseURL: sandbox.stub().resolves(guardSite),
        create: sandbox.stub().rejects(new Error('not needed in guard tests')),
      },
      Configuration: {
        findLatest: sandbox.stub().rejects(new Error('not needed in guard tests')),
      },
      Organization: {
        findByImsOrgId: sandbox.stub().resolves(org),
      },
      Entitlement: {
        findByOrganizationIdAndProductCode: sandbox.stub().resolves(entitlement),
      },
      Project: {
        allByOrganizationId: sandbox.stub().resolves([]),
        create: sandbox.stub().resolves({
          getId: () => 'proj-test',
          getProjectName: () => 'example-com',
        }),
      },
    },
    imsClient: { getImsOrganizationDetails: sandbox.stub() },
    sqs: { sendMessage: sandbox.stub().resolves() },
  });

  describe('blocking scenarios', () => {
    it('blocks onboarding a new domain into an org whose ASO entitlement is PLG', async () => {
      const result = await onboardSingleSite(
        SITE_URL,
        IMS_ORG_ID,
        {},
        demoProfile,
        300,
        slackContext(),
        makeContext({ org: makeOrg(), entitlement: makeEntitlement('PLG'), guardSite: null }),
        {},
        { profileName: 'demo' },
      );

      expect(result.status).to.equal('Failed');
      expect(result.errors).to.match(/Blocked.*PLG-tier ASO entitlement/);
      expect(sayStub).to.have.been.calledWith(sinon.match(GUARD_WARNING_PATTERN));
    });

    it('blocks onboarding an existing (but unrelated) site into a PLG-tier org', async () => {
      const result = await onboardSingleSite(
        SITE_URL,
        IMS_ORG_ID,
        {},
        demoProfile,
        300,
        slackContext(),
        makeContext({
          org: makeOrg(),
          entitlement: makeEntitlement('PLG'),
          guardSite: makeUnrelatedSite(),
        }),
        {},
        { profileName: 'demo' },
      );

      expect(result.status).to.equal('Failed');
      expect(result.errors).to.match(/Blocked.*PLG-tier ASO entitlement/);
      expect(sayStub).to.have.been.calledWith(sinon.match(GUARD_WARNING_PATTERN));
    });

    it('resolves the org from the existing site itself, ignoring a mismatched imsOrgID (regression: DEMO_IMS_ORG default)', async () => {
      const REAL_ORG_ID = 'org-real-plg';
      const IMS_LOOKUP_ORG_ID = 'org-demo-unrelated';

      const guardSite = {
        getConfig: nonPaidConfig,
        getOrganizationId: () => REAL_ORG_ID,
        // Unrelated to the entitlement bound to the site's real org — no matching enrollment.
        getSiteEnrollments: sandbox.stub().resolves([]),
      };

      const ctx = makeContext({
        org: { getId: () => IMS_LOOKUP_ORG_ID },
        guardSite,
      });
      // The site's real org holds the PLG entitlement; the org imsOrgID/DEMO_IMS_ORG
      // resolves to has none — proving the guard must not use the latter.
      ctx.dataAccess.Entitlement.findByOrganizationIdAndProductCode = sandbox.stub();
      ctx.dataAccess.Entitlement.findByOrganizationIdAndProductCode
        .withArgs(REAL_ORG_ID, sinon.match.any).resolves(makeEntitlement('PLG'));
      ctx.dataAccess.Entitlement.findByOrganizationIdAndProductCode
        .withArgs(IMS_LOOKUP_ORG_ID, sinon.match.any).resolves(null);

      const result = await onboardSingleSite(
        SITE_URL,
        IMS_ORG_ID,
        {},
        demoProfile,
        300,
        slackContext(),
        ctx,
        {},
        { profileName: 'demo' },
      );

      expect(result.status).to.equal('Failed');
      expect(result.errors).to.match(/Blocked.*PLG-tier ASO entitlement/);
      // Site already exists — imsOrgID must never even be resolved to an org.
      expect(ctx.dataAccess.Organization.findByImsOrgId).to.not.have.been.called;
    });
  });

  describe('allowed scenarios', () => {
    const assertGuardNotTriggered = async (ctxOpts, additionalParams = {}) => {
      let result;
      try {
        result = await onboardSingleSite(
          SITE_URL,
          IMS_ORG_ID,
          {},
          demoProfile,
          300,
          slackContext(),
          makeContext(ctxOpts),
          additionalParams,
          { profileName: 'demo' },
        );
      } catch {
        // Expected — downstream deps (Configuration, Project, entitlement creation)
        // are not fully mocked. The single-domain tier guard is what we're testing.
      }
      const guardBlocked = sayStub.getCalls().some(
        (call) => /Blocked.*-tier ASO entitlement/.test(call.args[0])
          || (GUARD_WARNING_PATTERN.test(call.args[0]) && !/Proceeding anyway/.test(call.args[0])),
      );
      expect(guardBlocked).to.be.false;
      if (result) {
        expect(result.errors).to.not.match(/-tier ASO entitlement/);
      }
    };

    it('allows onboarding when the org has no ASO entitlement', async () => {
      await assertGuardNotTriggered({ org: makeOrg(), entitlement: null, guardSite: null });
    });

    it('allows onboarding when the org has a non-restricted ASO entitlement', async () => {
      await assertGuardNotTriggered({
        org: makeOrg(),
        entitlement: makeEntitlement('FREE_TRIAL'),
        guardSite: null,
      });
    });

    it('allows onboarding a new domain into a PRE_ONBOARD-tier org (out of scope for this guard)', async () => {
      await assertGuardNotTriggered({
        org: makeOrg(),
        entitlement: makeEntitlement('PRE_ONBOARD'),
        guardSite: null,
      });
    });

    it('allows re-onboarding the same site already enrolled under the PLG entitlement', async () => {
      const entitlement = makeEntitlement('PLG');
      await assertGuardNotTriggered({
        org: makeOrg(),
        entitlement,
        guardSite: makeSameEnrolledSite(entitlement.getId()),
      });
    });

    it('allows onboarding when the IMS org does not resolve to an existing organization', async () => {
      await assertGuardNotTriggered({ org: null, entitlement: null, guardSite: null });
    });

    it('allows onboarding with forceTierUpdate=true despite a PLG entitlement bound to a different site', async () => {
      let result;
      try {
        result = await onboardSingleSite(
          SITE_URL,
          IMS_ORG_ID,
          {},
          demoProfile,
          300,
          slackContext(),
          makeContext({ org: makeOrg(), entitlement: makeEntitlement('PLG'), guardSite: null }),
          { forceTierUpdate: true },
          { profileName: 'demo' },
        );
      } catch {
        // Expected — downstream deps not fully mocked.
      }
      expect(sayStub).to.have.been.calledWith(sinon.match(/Proceeding anyway \(Force Tier Update\)/));
      if (result) {
        expect(result.errors).to.not.match(/-tier ASO entitlement/);
      }
    });

    it('fails open when the Organization/Entitlement lookup throws', async () => {
      const ctx = makeContext({ org: makeOrg(), entitlement: null, guardSite: null });
      ctx.dataAccess.Organization.findByImsOrgId = sandbox.stub().rejects(new Error('db down'));

      let result;
      try {
        result = await onboardSingleSite(
          SITE_URL,
          IMS_ORG_ID,
          {},
          demoProfile,
          300,
          slackContext(),
          ctx,
          {},
          { profileName: 'demo' },
        );
      } catch {
        // Expected — downstream deps not fully mocked.
      }
      const guardBlocked = sayStub.getCalls().some(
        (call) => /Blocked.*-tier ASO entitlement/.test(call.args[0]),
      );
      expect(guardBlocked).to.be.false;
      expect(ctx.log.warn).to.have.been.calledWith(
        sinon.match(/Single-domain tier guard check failed/),
      );
      if (result) {
        expect(result.errors).to.not.match(/-tier ASO entitlement/);
      }
    });
  });
});
