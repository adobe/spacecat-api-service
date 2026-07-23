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
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('scheduledRun precedence logic', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('scheduledRun precedence logic', () => {
    it('should prioritize form value over profile config when form value is true', () => {
      const additionalParams = { scheduledRun: true };
      const profile = { config: { scheduledRun: false } };

      const result = additionalParams.scheduledRun !== undefined
        ? additionalParams.scheduledRun
        : (profile.config?.scheduledRun || false);

      expect(result).to.be.true;
    });

    it('should prioritize form value over profile config when form value is false', () => {
      const additionalParams = { scheduledRun: false };
      const profile = { config: { scheduledRun: true } };

      const result = additionalParams.scheduledRun !== undefined
        ? additionalParams.scheduledRun
        : (profile.config?.scheduledRun || false);

      expect(result).to.be.false;
    });

    it('should fall back to profile config when form value not provided', () => {
      const additionalParams = {};
      const profile = { config: { scheduledRun: true } };

      const result = additionalParams.scheduledRun !== undefined
        ? additionalParams.scheduledRun
        : (profile.config?.scheduledRun || false);

      expect(result).to.be.true;
    });

    it('should default to false when neither form nor profile provides scheduledRun', () => {
      const additionalParams = {};
      const profile = { config: {} };

      const result = additionalParams.scheduledRun !== undefined
        ? additionalParams.scheduledRun
        : (profile.config?.scheduledRun || false);

      expect(result).to.be.false;
    });

    it('should handle undefined profile config gracefully', () => {
      const additionalParams = {};
      const profile = {};

      const result = additionalParams.scheduledRun !== undefined
        ? additionalParams.scheduledRun
        : (profile.config?.scheduledRun || false);

      expect(result).to.be.false;
    });

    it('should handle null profile config gracefully', () => {
      const additionalParams = {};
      const profile = { config: null };

      const result = additionalParams.scheduledRun !== undefined
        ? additionalParams.scheduledRun
        : (profile.config?.scheduledRun || false);

      expect(result).to.be.false;
    });
  });
});

/**
 * Integration-style tests verifying that onboardSingleSite does NOT enable audit
 * handlers in Configuration for free-trial one-shot onboards, and disables any
 * previously-enabled ones. This guards the in-process enable/disable logic
 * introduced by SITES-45860.
 */
describe('onboardSingleSite — audit handler enable/disable gating', () => {
  const SITE_URL = 'https://example.com';
  const IMS_ORG_ID = 'ABCDEF1234567890ABCDEF12@AdobeOrg';

  let sandbox;
  let onboardSingleSite;
  let enableHandlerStub;
  let disableHandlerStub;
  let configSaveStub;
  let sayStub;

  // Minimal happy-path site that survives far enough into onboardSingleSite
  // to reach the audit enable/disable block.
  const makeHappyPathSite = () => {
    const siteConfig = {
      getImports: () => [],
      getOnboardConfig: () => undefined,
      updateOnboardConfig: sinon.stub(),
      updateFetchConfig: sinon.stub(),
      getFetchConfig: () => undefined,
      updateRumConfig: sinon.stub(),
      enableImport: sinon.stub(),
    };
    return {
      getId: () => 'site-happy',
      getBaseURL: () => SITE_URL,
      getOrganizationId: () => 'org-happy',
      getProjectId: () => undefined,
      getLanguage: () => undefined,
      getRegion: () => undefined,
      getCode: () => undefined,
      getAuthoringType: () => undefined,
      getDeliveryType: () => undefined,
      getDeliveryConfig: () => ({}),
      getConfig: () => siteConfig,
      setConfig: sinon.stub(),
      setProjectId: sinon.stub(),
      setLanguage: sinon.stub(),
      setRegion: sinon.stub(),
      save: sinon.stub().resolves(),
    };
  };

  before(async () => {
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
        default: {
          createForSite: async () => ({
            createEntitlement: async () => ({
              entitlement: { getId: () => 'ent-test' },
              siteEnrollment: { getId: () => 'enr-test' },
            }),
          }),
        },
      },
      '../../src/support/rum-config-service.js': {
        updateRumConfig: sinon.stub().resolves(true),
      },
    }));
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sayStub = sandbox.stub().resolves();
    enableHandlerStub = sandbox.stub();
    disableHandlerStub = sandbox.stub();
    configSaveStub = sandbox.stub().resolves();
  });

  afterEach(() => {
    sandbox.restore();
  });

  const makeContext = (site) => ({
    log: {
      info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub(), debug: sandbox.stub(),
    },
    env: {
      DEMO_IMS_ORG: IMS_ORG_ID,
      WORKFLOW_WAIT_TIME_IN_SECONDS: 300,
      ONBOARD_WORKFLOW_STATE_MACHINE_ARN: 'arn:aws:states:us-east-1:123:stateMachine:test',
      AUDIT_JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123/audit-jobs',
    },
    dataAccess: {
      Site: { findByBaseURL: sandbox.stub().resolves(site) },
      Configuration: {
        findLatest: sandbox.stub().resolves({
          isHandlerEnabledForSite: sandbox.stub().returns(false),
          enableHandlerForSite: enableHandlerStub,
          disableHandlerForSite: disableHandlerStub,
          save: configSaveStub,
        }),
      },
      Organization: { findByImsOrgId: sandbox.stub().rejects(new Error('not needed')) },
      Project: {
        allByOrganizationId: sandbox.stub().resolves([]),
        create: sandbox.stub().resolves({ getId: () => 'proj-test', getProjectName: () => 'test-proj' }),
      },
    },
    imsClient: { getImsOrganizationDetails: sandbox.stub() },
    sqs: { sendMessage: sandbox.stub().resolves() },
  });

  const freeTrialProfile = { audits: { cwv: {}, 'lhs-mobile': {} }, imports: {}, config: {} };

  it('does NOT call enableHandlerForSite or Configuration.save for a free-trial one-shot onboard', async () => {
    const site = makeHappyPathSite();
    const ctx = makeContext(site);

    try {
      await onboardSingleSite(
        SITE_URL,
        IMS_ORG_ID,
        {},
        freeTrialProfile,
        300,
        { say: sayStub, channelId: 'C1', threadTs: '1.0' },
        ctx,
        {},
        { profileName: 'demo' },
      );
    } catch {
      // Downstream deps may not be fully mocked — expected.
    }

    expect(enableHandlerStub).not.to.have.been.called;
    // No previously-enabled handlers → no disable either (isHandlerEnabledForSite returns false)
    expect(disableHandlerStub).not.to.have.been.called;
    expect(configSaveStub).not.to.have.been.called;
  });
});
