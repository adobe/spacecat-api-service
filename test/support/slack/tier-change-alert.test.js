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

const CONFIGURED_ENV = {
  SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C_PLG',
  SLACK_BOT_TOKEN: 'xoxb-test',
};

const BASE_PAYLOAD = {
  baseURL: 'https://example.com',
  organizationId: 'org-123',
  imsOrgID: 'AB12@AdobeOrg',
  siteId: 'site-456',
  entitlementId: 'ent-789',
  fromTier: 'PLG',
  toTier: 'FREE_TRIAL',
  profileName: 'default',
  sourceChannelId: 'C_SRC',
  sourceThreadTs: '1700000000.000100',
};

describe('slack tier-change-alert', () => {
  let sandbox;
  let postSlackMessage;
  let alert;
  let log;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    postSlackMessage = sandbox.stub().resolves({ channel: 'C_PLG', ts: '1' });
    log = { warn: sandbox.stub(), info: sandbox.stub(), error: sandbox.stub() };
    alert = await esmock('../../../src/support/slack/tier-change-alert.js', {
      '../../../src/utils/slack/base.js': { postSlackMessage },
    });
  });

  afterEach(() => sandbox.restore());

  it('posts to the PLG onboarding channel with the bot token when configured', async () => {
    await alert.notifyForcedTierDowngrade(BASE_PAYLOAD, CONFIGURED_ENV, log);
    expect(postSlackMessage).to.have.been.calledOnceWith('C_PLG', sinon.match.string, 'xoxb-test');
  });

  it('includes the tier transition and all key identifiers in the message', async () => {
    await alert.notifyForcedTierDowngrade(BASE_PAYLOAD, CONFIGURED_ENV, log);
    const [, message] = postSlackMessage.firstCall.args;
    expect(message).to.match(/Force Tier Update/i);
    expect(message).to.contain('PLG');
    expect(message).to.contain('FREE_TRIAL');
    expect(message).to.contain('https://example.com');
    expect(message).to.contain('org-123');
    expect(message).to.contain('AB12@AdobeOrg');
    expect(message).to.contain('site-456');
    expect(message).to.contain('ent-789');
    expect(message).to.contain('default');
  });

  it('references the source thread when channel/thread are provided', async () => {
    await alert.notifyForcedTierDowngrade(BASE_PAYLOAD, CONFIGURED_ENV, log);
    const [, message] = postSlackMessage.firstCall.args;
    expect(message).to.contain('<#C_SRC>');
    expect(message).to.contain('1700000000.000100');
  });

  it('references the source channel without a thread_ts when only the channel is known', async () => {
    await alert.notifyForcedTierDowngrade(
      { ...BASE_PAYLOAD, sourceThreadTs: undefined },
      CONFIGURED_ENV,
      log,
    );
    const [, message] = postSlackMessage.firstCall.args;
    expect(message).to.contain('<#C_SRC>');
    expect(message).to.not.contain('thread_ts');
  });

  it('omits the source-thread line when no source channel is provided (e.g. scheduled run)', async () => {
    await alert.notifyForcedTierDowngrade(
      { ...BASE_PAYLOAD, sourceChannelId: undefined, sourceThreadTs: undefined },
      CONFIGURED_ENV,
      log,
    );
    const [, message] = postSlackMessage.firstCall.args;
    expect(message).to.not.contain('<#');
    expect(message).to.not.match(/Source:/i);
  });

  it("renders 'unknown' placeholders when optional identifiers are missing", async () => {
    await alert.notifyForcedTierDowngrade(
      {
        baseURL: 'https://example.com', fromTier: 'PLG', toTier: 'FREE_TRIAL',
      },
      CONFIGURED_ENV,
      log,
    );
    const [, message] = postSlackMessage.firstCall.args;
    expect(message).to.contain('unknown');
    // The transition and site are still present even with everything else missing.
    expect(message).to.contain('PLG');
    expect(message).to.contain('https://example.com');
  });

  it('reflects a PRE_ONBOARD origin tier in the message', async () => {
    await alert.notifyForcedTierDowngrade(
      { ...BASE_PAYLOAD, fromTier: 'PRE_ONBOARD' },
      CONFIGURED_ENV,
      log,
    );
    const [, message] = postSlackMessage.firstCall.args;
    expect(message).to.contain('PRE_ONBOARD');
    expect(message).to.contain('FREE_TRIAL');
  });

  it('is a no-op (no Slack post, no throw) when the channel is not configured', async () => {
    await alert.notifyForcedTierDowngrade(BASE_PAYLOAD, { SLACK_BOT_TOKEN: 'xoxb-test' }, log);
    expect(postSlackMessage).to.not.have.been.called;
  });

  it('is a no-op when the bot token is not configured', async () => {
    await alert.notifyForcedTierDowngrade(BASE_PAYLOAD, { SLACK_PLG_ONBOARDING_CHANNEL_ID: 'C_PLG' }, log);
    expect(postSlackMessage).to.not.have.been.called;
  });

  it('is a no-op when env is missing entirely', async () => {
    await alert.notifyForcedTierDowngrade(BASE_PAYLOAD, undefined, log);
    expect(postSlackMessage).to.not.have.been.called;
  });

  it('swallows Slack failures (best-effort) — never throws, logs a warning', async () => {
    postSlackMessage.rejects(new Error('slack down'));
    await alert.notifyForcedTierDowngrade(BASE_PAYLOAD, CONFIGURED_ENV, log);
    expect(log.warn).to.have.been.called;
  });

  it('does not throw when no logger is provided and Slack fails', async () => {
    postSlackMessage.rejects(new Error('slack down'));
    // Must resolve, not reject.
    await alert.notifyForcedTierDowngrade(BASE_PAYLOAD, CONFIGURED_ENV);
    expect(postSlackMessage).to.have.been.calledOnce;
  });
});
