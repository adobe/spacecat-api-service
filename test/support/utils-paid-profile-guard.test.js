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
import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);

/**
 * Unit tests for the paid-profile guard in onboardSingleSite (utils.js).
 *
 * The guard blocks re-onboarding a site that was previously onboarded with a
 * paid profile using a lower-tier profile (e.g. demo/test),
 * unless additionalParams.force === true.
 */
describe('onboardSingleSite — paid profile guard', () => {
  const SITE_URL = 'https://example.com';
  const IMS_ORG_ID = 'ABCDEF1234567890ABCDEF12@AdobeOrg';
  const GUARD_WARNING_PATTERN = /previously onboarded with the \*paid\* profile/;

  let sandbox;
  let onboardSingleSite;
  let sayStub;
  let makeSiteWithProfile;

  before(async () => {
    // Esmock heavy/AWS dependencies so the module loads cleanly in test.
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
    }));
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sayStub = sandbox.stub().resolves();

    // lastOnboardProfile is stored in handlers.lastOnboardProfile (inside the serialized
    // handlers field) so it survives DB round-trips.
    makeSiteWithProfile = (profileName) => ({
      getConfig: () => ({ getHandlers: () => ({ lastOnboardProfile: profileName }) }),
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  /**
   * Builds a minimal context for testing the guard.
   * Site.findByBaseURL is the hook point: first call is the guard lookup.
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
    },
    imsClient: { getImsOrganizationDetails: sandbox.stub() },
    sqs: { sendMessage: sandbox.stub().resolves() },
  });

  const minimalProfile = {
    audits: { cwv: {} },
    imports: {},
    config: {},
  };

  const slackContext = () => ({
    say: sayStub,
    channelId: 'C123',
    threadTs: '123.456',
  });

  describe('blocking scenarios', () => {
    it('blocks re-onboarding a paid site with demo profile', async () => {
      const context = makeContext(makeSiteWithProfile('paid'));

      const result = await onboardSingleSite(
        SITE_URL,
        IMS_ORG_ID,
        {},
        minimalProfile,
        300,
        slackContext(),
        context,
        {},
        { profileName: 'demo' },
      );

      expect(result.status).to.equal('Failed');
      expect(result.errors).to.match(/Blocked.*paid/);
      expect(sayStub).to.have.been.calledWith(sinon.match(GUARD_WARNING_PATTERN));
    });
  });

  describe('allowed scenarios', () => {
    // For tests where the guard should NOT block, the function will proceed into
    // createSiteAndOrganization which is not fully mocked — it may throw.
    // We catch that and only assert that the guard warning was NOT sent.

    const assertGuardNotTriggered = async (guardSite, profileName, additionalParams = {}) => {
      const context = makeContext(guardSite);
      try {
        await onboardSingleSite(
          SITE_URL,
          IMS_ORG_ID,
          {},
          minimalProfile,
          300,
          slackContext(),
          context,
          additionalParams,
          { profileName },
        );
      } catch {
        // Expected — downstream deps are not fully mocked. Guard is what we're testing.
      }
      const guardWarningSent = sayStub.getCalls().some(
        (call) => GUARD_WARNING_PATTERN.test(call.args[0]),
      );
      expect(guardWarningSent).to.be.false;
    };

    it('allows re-onboarding when force=true even if previous profile is paid', async () => {
      await assertGuardNotTriggered(makeSiteWithProfile('paid'), 'demo', { force: true });
    });

    it('allows onboarding when site has no previous profile', async () => {
      await assertGuardNotTriggered(null, 'demo');
    });

    it('allows onboarding when previous profile is not a paid profile', async () => {
      await assertGuardNotTriggered(makeSiteWithProfile('demo'), 'demo');
    });

    it('allows re-onboarding with paid profile regardless of previous profile', async () => {
      await assertGuardNotTriggered(makeSiteWithProfile('paid'), 'paid');
    });
  });
});
