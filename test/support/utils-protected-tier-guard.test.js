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

/**
 * Unit tests for the protected-tier preservation guard in onboardSingleSite (utils.js),
 * added for SITES-49886.
 *
 * ASO entitlements are org-level. When an org already holds a PLG or PRE_ONBOARD ASO
 * entitlement, the onboard command must NOT change the tier/entitlement/enrollment and
 * must NOT alter audit scheduling config — it should only run audits/opportunities once.
 * An explicit additionalParams.forceTierUpdate is the sole escape hatch.
 */
describe('onboardSingleSite — protected-tier preservation (SITES-49886)', function protectedTierSuite() {
  // Each test esmocks utils.js fresh; the cold load can exceed the 2s default.
  this.timeout(15000);

  const SITE_URL = 'https://example.com';
  const IMS_ORG_ID = 'ABCDEF1234567890ABCDEF12@AdobeOrg';
  const ORG_ID = 'org-happy';

  let sandbox;
  let sayStub;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sayStub = sandbox.stub().resolves();
  });

  afterEach(() => {
    sandbox.restore();
  });

  // Existing site returned by findByBaseURL, so createSiteAndOrganization takes the
  // site-exists branch and never needs the Organization/imsClient path.
  const makeHappyPathSite = () => {
    const siteConfig = {
      getImports: () => [],
      getOnboardConfig: () => undefined,
      updateOnboardConfig: sandbox.stub(),
      updateFetchConfig: sandbox.stub(),
      getFetchConfig: () => undefined,
      updateRumConfig: sandbox.stub(),
      enableImport: sandbox.stub(),
    };
    return {
      getId: () => 'site-happy',
      getBaseURL: () => SITE_URL,
      getOrganizationId: () => ORG_ID,
      getProjectId: () => undefined,
      getLanguage: () => undefined,
      getRegion: () => undefined,
      getCode: () => undefined,
      getAuthoringType: () => undefined,
      getDeliveryType: () => undefined,
      getDeliveryConfig: () => ({}),
      getConfig: () => siteConfig,
      setConfig: sandbox.stub(),
      setProjectId: sandbox.stub(),
      setLanguage: sandbox.stub(),
      setRegion: sandbox.stub(),
      save: sandbox.stub().resolves(),
    };
  };

  const loadOnboard = async () => {
    const sfnSendStub = sandbox.stub().resolves({ executionArn: 'arn:test' });
    const createEntitlementStub = sandbox.stub().resolves({
      entitlement: { getId: () => 'ent-test' },
      siteEnrollment: { getId: () => 'enr-test' },
    });
    const tierCreateForSiteStub = sandbox.stub().resolves({
      createEntitlement: createEntitlementStub,
    });
    const { onboardSingleSite } = await esmock('../../src/support/utils.js', {
      '@aws-sdk/client-sfn': {
        // eslint-disable-next-line func-style
        SFNClient: function SFNClient() { this.send = sfnSendStub; },
        // eslint-disable-next-line func-style
        StartExecutionCommand: function StartExecutionCommand(params) {
          Object.assign(this, params || {});
        },
      },
      '@adobe/spacecat-shared-utils': {
        isValidUrl: () => true,
        isValidIMSOrgId: () => true,
        hasText: (s) => !!(s && s.trim && s.trim().length > 0),
        isObject: (o) => o !== null && typeof o === 'object',
        isNonEmptyObject: (o) => o !== null && typeof o === 'object' && Object.keys(o).length > 0,
        resolveCanonicalUrl: sandbox.stub().resolves(SITE_URL),
        detectLocale: sandbox.stub().resolves({ language: 'en', region: 'US' }),
        detectAEMVersion: sandbox.stub().resolves(null),
        tracingFetch: sandbox.stub().resolves({ ok: false }),
        wwwUrlResolver: sandbox.stub().returns(SITE_URL),
        getLastNumberOfWeeks: sandbox.stub().returns([]),
      },
      '@adobe/spacecat-shared-tier-client': {
        default: { createForSite: tierCreateForSiteStub },
      },
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: { toDynamoItem: () => ({}) },
      },
      '../../src/support/rum-config-service.js': {
        updateRumConfig: sandbox.stub().resolves(true),
      },
    });
    return {
      onboardSingleSite, sfnSendStub, tierCreateForSiteStub, createEntitlementStub,
    };
  };

  // existingEntitlement: null (no entitlement) or an object with getTier().
  const makeContext = (site, existingEntitlement) => {
    const configurationFindLatest = sandbox.stub().resolves({
      isHandlerEnabledForSite: sandbox.stub().returns(false),
      enableHandlerForSite: sandbox.stub(),
      disableHandlerForSite: sandbox.stub(),
      save: sandbox.stub().resolves(),
    });
    const context = {
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
        Configuration: { findLatest: configurationFindLatest },
        Organization: { findByImsOrgId: sandbox.stub().rejects(new Error('not needed')) },
        Project: {
          allByOrganizationId: sandbox.stub().resolves([]),
          create: sandbox.stub().resolves({ getId: () => 'proj-test', getProjectName: () => 'test-proj' }),
        },
        Entitlement: {
          findByOrganizationIdAndProductCode: sandbox.stub().resolves(existingEntitlement),
        },
      },
      imsClient: { getImsOrganizationDetails: sandbox.stub() },
      sqs: { sendMessage: sandbox.stub().resolves() },
    };
    return { context, configurationFindLatest };
  };

  const profile = { audits: { cwv: {} }, imports: {}, config: {} };
  const slackContext = () => ({ say: sayStub, channelId: 'C1', threadTs: '1.0' });

  const run = async (onboardSingleSite, context, additionalParams = {}) => onboardSingleSite(
    SITE_URL,
    IMS_ORG_ID,
    {},
    profile,
    300,
    slackContext(),
    context,
    additionalParams,
    { profileName: 'demo' },
  );

  ['PLG', 'PRE_ONBOARD'].forEach((protectedTier) => {
    it(`preserves an existing ${protectedTier} tier: no entitlement/enrollment write, no audit-config change, still runs audits + opportunities once`, async () => {
      const { onboardSingleSite, sfnSendStub, tierCreateForSiteStub } = await loadOnboard();
      const site = makeHappyPathSite();
      const existingEntitlement = { getTier: () => protectedTier };
      const { context, configurationFindLatest } = makeContext(site, existingEntitlement);

      const result = await run(onboardSingleSite, context);

      // Tier / entitlement / enrollment untouched — TierClient never engaged.
      expect(tierCreateForSiteStub).to.not.have.been.called;
      // Audit scheduling config left as-is — findLatest lives inside the skipped branch.
      expect(configurationFindLatest).to.not.have.been.called;
      // Audits still triggered once ...
      expect(context.sqs.sendMessage).to.have.been.calledWith(
        context.env.AUDIT_JOBS_QUEUE_URL,
        sinon.match({ type: 'cwv', siteId: 'site-happy' }),
      );
      // ... and the opportunity workflow still starts once.
      expect(sfnSendStub).to.have.been.calledOnce;
      // The report reflects the true, unchanged tier and the run succeeds.
      expect(result.tier).to.equal(protectedTier);
      expect(result.status).to.equal('Success');
      // Operator is told the tier was preserved.
      expect(sayStub).to.have.been.calledWith(
        sinon.match(new RegExp(`on the \\*${protectedTier}\\* tier`)),
      );
    });
  });

  it('creates an entitlement normally when the org has NO existing ASO entitlement (ims2 → s3 happy path)', async () => {
    const { onboardSingleSite, tierCreateForSiteStub } = await loadOnboard();
    const site = makeHappyPathSite();
    const { context } = makeContext(site, null);

    const result = await run(onboardSingleSite, context);

    expect(tierCreateForSiteStub).to.have.been.calledOnce;
    // Default requested tier is FREE_TRIAL.
    const createEntitlement = await tierCreateForSiteStub.firstCall.returnValue;
    expect(createEntitlement.createEntitlement).to.have.been.calledWith('FREE_TRIAL');
    expect(result.status).to.equal('Success');
  });

  it('creates an entitlement normally when the org already holds a FREE_TRIAL tier (not protected)', async () => {
    const { onboardSingleSite, tierCreateForSiteStub } = await loadOnboard();
    const site = makeHappyPathSite();
    const { context } = makeContext(site, { getTier: () => 'FREE_TRIAL' });

    const result = await run(onboardSingleSite, context);

    expect(tierCreateForSiteStub).to.have.been.calledOnce;
    expect(result.status).to.equal('Success');
  });

  it('allows overriding a protected tier when forceTierUpdate=true (escape hatch)', async () => {
    const { onboardSingleSite, tierCreateForSiteStub } = await loadOnboard();
    const site = makeHappyPathSite();
    const { context, configurationFindLatest } = makeContext(site, { getTier: () => 'PLG' });

    const result = await run(onboardSingleSite, context, { forceTierUpdate: true });

    // Escape hatch engaged — normal entitlement write + audit-config path run.
    expect(tierCreateForSiteStub).to.have.been.calledOnce;
    expect(configurationFindLatest).to.have.been.calledOnce;
    expect(result.status).to.equal('Success');
  });
});
