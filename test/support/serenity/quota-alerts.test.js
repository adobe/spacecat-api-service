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

const ENABLED_ENV = {
  SERENITY_QUOTA_ALERTS_ENABLED: 'true',
  SERENITY_QUOTA_ALERTS_SLACK_CHANNEL_ID: 'C123',
  SLACK_BOT_TOKEN: 'xoxb-test',
};

describe('serenity quota-alerts', () => {
  let sandbox;
  let postSlackMessage;
  let alerts;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    postSlackMessage = sandbox.stub().resolves({ channel: 'C123', ts: '1' });
    alerts = await esmock('../../../src/support/serenity/quota-alerts.js', {
      '../../../src/utils/slack/base.js': { postSlackMessage },
    });
    alerts.clearQuotaAlertDedup();
  });

  afterEach(() => sandbox.restore());

  describe('alertQuotaRejection', () => {
    it('is a no-op (no Slack call) when the kill-switch is OFF', async () => {
      await alerts.alertQuotaRejection(
        { orgId: 'org-1', brandId: 'brand-1', caseType: 'brandCarveExhausted' },
        {},
      );
      expect(postSlackMessage).to.not.have.been.called;
    });

    it('is a no-op when enabled but channel/token are not configured', async () => {
      await alerts.alertQuotaRejection(
        { orgId: 'org-1', brandId: 'brand-1', caseType: 'brandCarveExhausted' },
        { SERENITY_QUOTA_ALERTS_ENABLED: 'true' },
      );
      expect(postSlackMessage).to.not.have.been.called;
    });

    it('posts to Slack when enabled and configured', async () => {
      await alerts.alertQuotaRejection(
        {
          orgId: 'org-1', brandId: 'brand-1', workspaceId: 'ws-1', market: 'US/en', caseType: 'brandCarveExhausted', dimension: 'prompts', attempted: 5, used: 800, total: 800,
        },
        ENABLED_ENV,
      );
      expect(postSlackMessage).to.have.been.calledOnceWith('C123', sinon.match.string, 'xoxb-test');
      const [, message] = postSlackMessage.firstCall.args;
      expect(message).to.contain('brandCarveExhausted');
      expect(message).to.contain('org-1');
      expect(message).to.contain('brand-1');
      expect(message).to.contain('US/en');
    });

    it('marks a swallowed (best-effort) rejection distinctly in the message', async () => {
      await alerts.alertQuotaRejection(
        {
          orgId: 'org-1', brandId: 'brand-1', caseType: 'brandCarveExhausted', swallowed: true,
        },
        ENABLED_ENV,
      );
      const [, message] = postSlackMessage.firstCall.args;
      expect(message).to.match(/best-effort provisioning swallow/);
    });

    it('dedupes repeated rejections for the same org+brand+case+dimension within the window', async () => {
      const payload = {
        orgId: 'org-1', brandId: 'brand-1', caseType: 'brandCarveExhausted', dimension: 'prompts',
      };
      await alerts.alertQuotaRejection(payload, ENABLED_ENV);
      await alerts.alertQuotaRejection(payload, ENABLED_ENV);
      await alerts.alertQuotaRejection(payload, ENABLED_ENV);
      expect(postSlackMessage).to.have.been.calledOnce;
    });

    it('does NOT dedupe across different orgs/brands/cases/dimensions', async () => {
      await alerts.alertQuotaRejection(
        {
          orgId: 'org-1', brandId: 'brand-1', caseType: 'brandCarveExhausted', dimension: 'prompts',
        },
        ENABLED_ENV,
      );
      await alerts.alertQuotaRejection(
        {
          orgId: 'org-2', brandId: 'brand-1', caseType: 'brandCarveExhausted', dimension: 'prompts',
        },
        ENABLED_ENV,
      );
      await alerts.alertQuotaRejection(
        {
          orgId: 'org-1', brandId: 'brand-2', caseType: 'brandCarveExhausted', dimension: 'prompts',
        },
        ENABLED_ENV,
      );
      await alerts.alertQuotaRejection(
        {
          orgId: 'org-1', brandId: 'brand-1', caseType: 'orgPoolExhausted', dimension: 'prompts',
        },
        ENABLED_ENV,
      );
      await alerts.alertQuotaRejection(
        {
          orgId: 'org-1', brandId: 'brand-1', caseType: 'brandCarveExhausted', dimension: 'projects',
        },
        ENABLED_ENV,
      );
      expect(postSlackMessage.callCount).to.equal(5);
    });

    it('is fire-and-forget: a Slack post failure is swallowed, never thrown', async () => {
      postSlackMessage.rejects(new Error('slack down'));
      const log = { warn: sinon.stub() };
      await alerts.alertQuotaRejection(
        { orgId: 'org-1', brandId: 'brand-1', caseType: 'brandCarveExhausted' },
        ENABLED_ENV,
        log,
      );
      expect(log.warn).to.have.been.called;
    });
  });

  describe('alertPoolFreeThreshold', () => {
    it('is a no-op when the kill-switch is OFF', async () => {
      await alerts.alertPoolFreeThreshold(
        {
          parentWorkspaceId: 'parent-1', dimension: 'prompts', free: 10, total: 1000,
        },
        {},
      );
      expect(postSlackMessage).to.not.have.been.called;
    });

    it('is a no-op when free/total is at or above the threshold', async () => {
      await alerts.alertPoolFreeThreshold(
        {
          parentWorkspaceId: 'parent-1', dimension: 'prompts', free: 500, total: 1000,
        },
        { ...ENABLED_ENV, SERENITY_POOL_FREE_ALERT_THRESHOLD: '0.1' },
      );
      expect(postSlackMessage).to.not.have.been.called;
    });

    it('posts when free/total drops below the configured threshold', async () => {
      await alerts.alertPoolFreeThreshold(
        {
          orgId: 'org-1', parentWorkspaceId: 'parent-1', dimension: 'prompts', free: 50, total: 1000,
        },
        { ...ENABLED_ENV, SERENITY_POOL_FREE_ALERT_THRESHOLD: '0.1' },
      );
      expect(postSlackMessage).to.have.been.calledOnce;
      const [, message] = postSlackMessage.firstCall.args;
      expect(message).to.contain('parent-1');
      expect(message).to.contain('below threshold');
    });

    it('defaults the threshold to 0.1 when not configured', async () => {
      await alerts.alertPoolFreeThreshold(
        {
          parentWorkspaceId: 'parent-1', dimension: 'prompts', free: 50, total: 1000,
        },
        ENABLED_ENV,
      );
      expect(postSlackMessage).to.have.been.calledOnce;
    });

    it('dedupes repeated threshold alerts for the same parent+dimension within the window', async () => {
      const payload = {
        parentWorkspaceId: 'parent-1', dimension: 'prompts', free: 50, total: 1000,
      };
      await alerts.alertPoolFreeThreshold(payload, ENABLED_ENV);
      await alerts.alertPoolFreeThreshold(payload, ENABLED_ENV);
      expect(postSlackMessage).to.have.been.calledOnce;
    });
  });
});
