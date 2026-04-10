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

import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);

/**
 * Unit tests for the paid-profile guard in onboardSingleSite (utils.js).
 *
 * The guard blocks re-onboarding a site that has the ahref-paid-pages import
 * (signal for a previously paid-profile site) with a lower-tier profile,
 * unless the incoming profile has protected:true or additionalParams.force===true.
 */
describe('onboardSingleSite — paid profile guard', () => {
  const SITE_URL = 'https://example.com';
  const IMS_ORG_ID = 'ABCDEF1234567890ABCDEF12@AdobeOrg';
  const GUARD_WARNING_PATTERN = /last onboarded with the \*paid\* profile/;

  let sandbox;
  let onboardSingleSite;
  let sayStub;

  before(async () => {
    // Esmock heavy/AWS dependencies so the module loads cleanly in test.
    ({ onboardSingleSite } = await esmock('../../src/support/utils.js', {
      '@aws-sdk/client-sfn': {
        // eslint-disable-next-line func-style
        SFNClient: function SFNClient() { this.send = () => Promise.resolve({ executionArn: 'arn:test' }); },
        // eslint-disable-next-line func-style
        StartExecutionCommand: function StartExecutionCommand() {},
      },
      '@adobe/spacecat-shared-rum-api-client': {
        default: class RUMAPIClientMock {
          static createFrom() {
            return { retrieveDomainkey: async () => 'stub-domain-key' };
          }
        },
        RUM_BUNDLER_API_HOST: 'https://bundles.test',
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

  // A site with ahref-paid-pages import AND onboardConfig.lastProfile='paid' —
  // both signals indicate a previous paid onboarding.
  const makePaidSite = () => ({
    getConfig: () => ({
      getImports: () => [{ type: 'ahref-paid-pages', enabled: true }],
      getOnboardConfig: () => ({ lastProfile: 'paid', lastStartTime: 1000 }),
    }),
  });

  // A site with no paid imports but onboardConfig.lastProfile='paid' —
  // covers the case where imports were not set but onboardConfig was backfilled.
  const makePaidOnboardConfigSite = () => ({
    getConfig: () => ({
      getImports: () => [{ type: 'organic-traffic', enabled: true }],
      getOnboardConfig: () => ({ lastProfile: 'paid', lastStartTime: 1000 }),
    }),
  });

  // A site with no paid imports and no paid onboardConfig — not a paid site.
  const makeNonPaidSite = () => ({
    getConfig: () => ({
      getImports: () => [{ type: 'organic-traffic', enabled: true }],
      getOnboardConfig: () => undefined,
    }),
  });

  // A legacy site that has no onboardConfig (predates tracking) but has the paid import enabled.
  // The guard must fall back to the import check to detect this as a paid site.
  const makeLegacyPaidSite = () => ({
    getConfig: () => ({
      getImports: () => [{ type: 'ahref-paid-pages', enabled: true }],
      getOnboardConfig: () => undefined,
    }),
  });

  // A site with an empty onboardConfig {} (e.g. partial write) and a paid import.
  // The guard must NOT treat {} as truthy proof of lastProfile and must fall through
  // to the import check — otherwise isPaidSite would be false (undefined === 'paid').
  const makePartialOnboardConfigPaidSite = () => ({
    getConfig: () => ({
      getImports: () => [{ type: 'ahref-paid-pages', enabled: true }],
      getOnboardConfig: () => ({}),
    }),
  });

  /**
   * Builds a site mock with a fully-stubbed Config that can survive the happy path,
   * allowing tests to assert on updateOnboardConfig being called.
   */
  const makeHappyPathSite = () => {
    const updateOnboardConfigStub = sinon.stub();
    const site = {
      getId: () => 'site-123',
      getBaseURL: () => SITE_URL,
      getOrganizationId: () => 'org-123',
      getProjectId: () => undefined,
      getLanguage: () => undefined,
      getRegion: () => undefined,
      getCode: () => undefined,
      getAuthoringType: () => undefined,
      getDeliveryType: () => undefined,
      getConfig: () => ({
        getImports: () => [],
        getOnboardConfig: () => undefined,
        updateOnboardConfig: updateOnboardConfigStub,
        updateFetchConfig: sinon.stub(),
        getFetchConfig: () => undefined,
      }),
      setConfig: sinon.stub(),
      setProjectId: sinon.stub(),
      setLanguage: sinon.stub(),
      setRegion: sinon.stub(),
      save: sinon.stub().resolves(),
    };
    return { site, updateOnboardConfigStub };
  };

  /**
   * Builds a minimal context for testing the guard.
   * Site.findByBaseURL resolves to the provided site (or null).
   */
  const makeContext = (guardSite) => ({
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
        findByImsOrgId: sandbox.stub().rejects(new Error('not needed in guard tests')),
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

  // Lower-tier profile — not protected.
  const demoProfile = { audits: { cwv: {} }, imports: {}, config: {} };

  // Paid profile — protected: true skips the guard.
  const paidProfile = {
    protected: true,
    audits: { cwv: {} },
    imports: { 'ahref-paid-pages': {} },
    config: {},
  };

  const slackContext = () => ({
    say: sayStub,
    channelId: 'C123',
    threadTs: '123.456',
  });

  describe('blocking scenarios', () => {
    it('blocks re-onboarding a paid site with demo profile', async () => {
      const result = await onboardSingleSite(
        SITE_URL,
        IMS_ORG_ID,
        {},
        demoProfile,
        300,
        slackContext(),
        makeContext(makePaidSite()),
        {},
        { profileName: 'demo' },
      );

      expect(result.status).to.equal('Failed');
      expect(result.errors).to.match(/Blocked.*paid/);
      expect(sayStub).to.have.been.calledWith(sinon.match(GUARD_WARNING_PATTERN));
    });

    it('blocks re-onboarding a paid site with test profile', async () => {
      const result = await onboardSingleSite(
        SITE_URL,
        IMS_ORG_ID,
        {},
        demoProfile,
        300,
        slackContext(),
        makeContext(makePaidSite()),
        {},
        { profileName: 'test' },
      );

      expect(result.status).to.equal('Failed');
      expect(result.errors).to.match(/Blocked.*paid/);
      expect(sayStub).to.have.been.calledWith(sinon.match(GUARD_WARNING_PATTERN));
    });

    it('blocks re-onboarding when onboardConfig.lastProfile is paid (even without paid import)', async () => {
      const result = await onboardSingleSite(
        SITE_URL,
        IMS_ORG_ID,
        {},
        demoProfile,
        300,
        slackContext(),
        makeContext(makePaidOnboardConfigSite()),
        {},
        { profileName: 'demo' },
      );

      expect(result.status).to.equal('Failed');
      expect(result.errors).to.match(/Blocked.*paid/);
      expect(sayStub).to.have.been.calledWith(sinon.match(GUARD_WARNING_PATTERN));
    });

    it('blocks re-onboarding a legacy paid site (no onboardConfig, import fallback)', async () => {
      // Legacy sites predate onboardConfig tracking — the guard falls back to the
      // ahref-paid-pages import check to detect a prior paid onboarding.
      const result = await onboardSingleSite(
        SITE_URL,
        IMS_ORG_ID,
        {},
        demoProfile,
        300,
        slackContext(),
        makeContext(makeLegacyPaidSite()),
        {},
        { profileName: 'demo' },
      );

      expect(result.status).to.equal('Failed');
      expect(result.errors).to.match(/Blocked.*paid/);
      expect(sayStub).to.have.been.calledWith(sinon.match(GUARD_WARNING_PATTERN));
    });

    it('blocks re-onboarding when onboardConfig is empty ({}) and paid import is enabled', async () => {
      // Guards against a partial write leaving onboardConfig as {} — lastProfile would be
      // undefined, so the ternary must check lastProfile != null (not onboardConfig truthiness)
      // to correctly fall through to the import-based detection.
      const result = await onboardSingleSite(
        SITE_URL,
        IMS_ORG_ID,
        {},
        demoProfile,
        300,
        slackContext(),
        makeContext(makePartialOnboardConfigPaidSite()),
        {},
        { profileName: 'demo' },
      );

      expect(result.status).to.equal('Failed');
      expect(result.errors).to.match(/Blocked.*paid/);
      expect(sayStub).to.have.been.calledWith(sinon.match(GUARD_WARNING_PATTERN));
    });
  });

  describe('allowed scenarios', () => {
    // For tests where the guard should NOT block, the function proceeds into
    // createSiteAndOrganization which is not fully mocked — it may throw.
    // We catch that and only assert that the guard warning was NOT sent.

    const assertGuardNotTriggered = async (guardSite, incomingProfile, additionalParams = {}) => {
      let result;
      try {
        result = await onboardSingleSite(
          SITE_URL,
          IMS_ORG_ID,
          {},
          incomingProfile,
          300,
          slackContext(),
          makeContext(guardSite),
          additionalParams,
          { profileName: incomingProfile.name || 'demo' },
        );
      } catch {
        // Expected — downstream deps are not fully mocked. Guard is what we're testing.
      }
      const guardWarningSent = sayStub.getCalls().some(
        (call) => GUARD_WARNING_PATTERN.test(call.args[0]),
      );
      expect(guardWarningSent).to.be.false;
      if (result) {
        expect(result.status).to.not.equal('Failed');
      }
    };

    it('allows re-onboarding when force=true even if previous site has paid import', async () => {
      await assertGuardNotTriggered(makePaidSite(), demoProfile, { force: true });
      expect(sayStub).to.have.been.calledWith(sinon.match(/Force re-onboarding/));
    });

    it('allows re-onboarding when force=true even if onboardConfig.lastProfile is paid', async () => {
      await assertGuardNotTriggered(makePaidOnboardConfigSite(), demoProfile, { force: true });
      expect(sayStub).to.have.been.calledWith(sinon.match(/Force re-onboarding/));
    });

    it('allows onboarding when site does not exist yet', async () => {
      await assertGuardNotTriggered(null, demoProfile);
    });

    it('allows onboarding when previous site has no paid imports', async () => {
      await assertGuardNotTriggered(makeNonPaidSite(), demoProfile);
    });

    it('allows re-onboarding with paid profile regardless of previous site state', async () => {
      await assertGuardNotTriggered(makePaidSite(), paidProfile);
    });
  });

  describe('updateOnboardConfig', function () {
    this.timeout(10000);

    it('calls updateOnboardConfig with lastProfile and lastStartTime on the happy path', async () => {
      const { site, updateOnboardConfigStub } = makeHappyPathSite();
      const ctx = makeContext(site);
      // Override findByBaseURL to return our fully-stubbed site
      ctx.dataAccess.Site.findByBaseURL = sandbox.stub().resolves(site);

      try {
        await onboardSingleSite(
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
        // Downstream deps (Configuration, Organization) are not fully mocked — expected to throw.
        // We only care that updateOnboardConfig was reached before the failure.
      }

      expect(updateOnboardConfigStub).to.have.been.calledOnce;
      const [payload, options] = updateOnboardConfigStub.firstCall.args;
      expect(payload).to.have.property('lastProfile', 'demo');
      expect(payload).to.have.property('lastStartTime').that.is.a('number');
      expect(payload).to.not.have.property('forcedOverride');
      expect(options).to.deep.equal({ maxHistory: 10 });
    });

    it('includes forcedOverride:true in updateOnboardConfig payload when force=true', async () => {
      const { site, updateOnboardConfigStub } = makeHappyPathSite();
      const ctx = makeContext(site);
      ctx.dataAccess.Site.findByBaseURL = sandbox.stub().resolves(site);

      try {
        await onboardSingleSite(
          SITE_URL,
          IMS_ORG_ID,
          {},
          demoProfile,
          300,
          slackContext(),
          ctx,
          { force: true },
          { profileName: 'demo' },
        );
      } catch {
        // Expected — downstream deps not fully mocked.
      }

      expect(updateOnboardConfigStub).to.have.been.calledOnce;
      const [payload, options] = updateOnboardConfigStub.firstCall.args;
      expect(payload).to.have.property('forcedOverride', true);
      expect(options).to.deep.equal({ maxHistory: 10 });
    });
  });
});
