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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('PLG onboarding helper dependency fallbacks', () => {
  let sandbox;
  let log;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    log = {
      debug: sandbox.stub(),
      error: sandbox.stub(),
      info: sandbox.stub(),
      warn: sandbox.stub(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('ensureAsoEntitlement falls back to the imported TierClient', async () => {
    const entitlement = {
      getId: sandbox.stub().returns('entitlement-id'),
      getOrganizationId: sandbox.stub().returns('org-id'),
    };
    const siteEnrollment = {};
    const createEntitlement = sandbox.stub().resolves({ entitlement });
    const checkValidEntitlement = sandbox.stub();
    const createForOrg = sandbox.stub().returns({ createEntitlement, checkValidEntitlement });

    const { ensureAsoEntitlement } = await esmock(
      '../../../src/controllers/plg/plg-onboarding/entitlement.js',
      {
        '@adobe/spacecat-shared-tier-client': {
          default: { createForOrg },
        },
      },
    );

    const site = { getId: sandbox.stub().returns('site-id') };
    const organization = { getId: sandbox.stub().returns('org-id') };
    const SiteEnrollment = {
      allBySiteId: sandbox.stub().resolves([]),
      create: sandbox.stub().resolves(siteEnrollment),
    };
    const context = {
      dataAccess: { SiteEnrollment },
      log,
    };

    const result = await ensureAsoEntitlement(site, organization, context);

    expect(createForOrg).to.have.been.calledOnceWithExactly(context, organization, 'ASO');
    expect(createEntitlement).to.have.been.calledOnceWithExactly('PLG');
    expect(checkValidEntitlement).not.to.have.been.called;
    expect(SiteEnrollment.create).to.have.been.calledOnceWithExactly({
      entitlementId: 'entitlement-id',
      siteId: 'site-id',
    });
    expect(result).to.deep.equal({ entitlement, siteEnrollment });
  });

  it('updateLaunchDarklyFlags falls back to the imported LaunchDarklyClient', async () => {
    const ldClient = {
      getFeatureFlag: sandbox.stub().resolves({ variations: [{ value: {} }] }),
      updateVariationValue: sandbox.stub().resolves(),
    };
    const constructorSpy = sandbox.spy();
    function MockLaunchDarklyClient(...args) {
      constructorSpy(...args);
      return ldClient;
    }

    const { updateLaunchDarklyFlags, LD_AUTO_FIX_FLAGS } = await esmock(
      '../../../src/controllers/plg/plg-onboarding/launchdarkly.js',
      {
        '@adobe/spacecat-shared-launchdarkly-client': {
          default: MockLaunchDarklyClient,
        },
      },
    );

    const site = { getId: sandbox.stub().returns('site-id') };
    const organization = { getImsOrgId: sandbox.stub().returns('ABC123@AdobeOrg') };
    const context = {
      env: { LD_EXPERIENCE_SUCCESS_API_TOKEN: 'ld-token' },
      log,
    };

    await updateLaunchDarklyFlags(site, organization, context);

    expect(constructorSpy).to.have.been.calledOnceWithExactly({ apiToken: 'ld-token' }, log);
    expect(ldClient.getFeatureFlag).to.have.callCount(LD_AUTO_FIX_FLAGS.length);
    expect(ldClient.updateVariationValue).to.have.callCount(LD_AUTO_FIX_FLAGS.length);
  });

  it('postPlgOnboardingNotification falls back to the imported postSlackMessage', async () => {
    const postSlackMessage = sandbox.stub().resolves();
    const { postPlgOnboardingNotification } = await esmock(
      '../../../src/controllers/plg/plg-onboarding/notifications.js',
      {
        '../../../src/utils/slack/base.js': {
          postSlackMessage,
        },
      },
    );

    const onboarding = {
      getBotBlocker: sandbox.stub().returns(null),
      getDomain: sandbox.stub().returns('example.com'),
      getError: sandbox.stub().returns(null),
      getImsOrgId: sandbox.stub().returns('ABC123@AdobeOrg'),
      getOrganizationId: sandbox.stub().returns(null),
      getSiteId: sandbox.stub().returns(null),
      getStatus: sandbox.stub().returns('ONBOARDED'),
    };
    const context = {
      dataAccess: {},
      env: {
        SLACK_BOT_TOKEN: 'slack-token',
        SLACK_PLG_ONBOARDING_CHANNEL_ID: 'plg-channel',
      },
      log,
    };

    await postPlgOnboardingNotification(onboarding, context);

    expect(postSlackMessage).to.have.been.calledOnce;
    const [channelId, message, token] = postSlackMessage.firstCall.args;
    expect(channelId).to.equal('plg-channel');
    expect(message).to.include('PLG Onboarding');
    expect(message).to.include('Onboarded');
    expect(token).to.equal('slack-token');
  });

  it('createOrFindProject falls back to the imported deriveProjectName', async () => {
    const deriveProjectName = sandbox.stub().returns('Example Project');
    const { createOrFindProject } = await esmock(
      '../../../src/controllers/plg/plg-onboarding/site-setup.js',
      {
        '../../../src/support/utils.js': {
          deriveProjectName,
        },
      },
    );

    const createdProject = { getId: sandbox.stub().returns('project-id') };
    const Project = {
      allByOrganizationId: sandbox.stub().resolves([]),
      create: sandbox.stub().resolves(createdProject),
    };
    const context = {
      dataAccess: { Project },
      log,
    };

    const project = await createOrFindProject('https://example.com', 'org-id', context);

    expect(deriveProjectName).to.have.been.calledOnceWithExactly('https://example.com');
    expect(Project.create).to.have.been.calledOnceWithExactly({
      organizationId: 'org-id',
      projectName: 'Example Project',
    });
    expect(project).to.equal(createdProject);
  });
});
