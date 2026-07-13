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
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import esmock from 'esmock';

use(chaiAsPromised);

const WEBHOOK_URL = 'https://hooks.slack.test/services/T000/B000/xxxx';

describe('notifyOnboarding', () => {
  let sandbox;
  let fetchStub;
  let notifyOnboarding;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    fetchStub = sandbox.stub();
    ({ notifyOnboarding } = await esmock('../../../src/support/onboarding/slack-notifier.js', {
      '@adobe/spacecat-shared-utils': { tracingFetch: fetchStub },
    }));
  });

  afterEach(() => sandbox.restore());

  const payload = {
    email: 'jane@example.com',
    workspaceId: 'ws-123',
    spaceCatId: '11111111-1111-4111-b111-111111111111',
  };

  it('POSTs a JSON message to the configured webhook URL and resolves on 2xx', async () => {
    fetchStub.resolves({ ok: true, status: 200, text: async () => 'ok' });

    await expect(notifyOnboarding({ SLACK_ONBOARDING_WEBHOOK_URL: WEBHOOK_URL }, payload))
      .to.be.fulfilled;

    expect(fetchStub.calledOnce).to.equal(true);
    const [url, opts] = fetchStub.firstCall.args;
    expect(url).to.equal(WEBHOOK_URL);
    expect(opts.method).to.equal('POST');
    expect(opts.headers['content-type']).to.equal('application/json');
    const body = JSON.parse(opts.body);
    expect(body.text).to.contain('jane@example.com');
    expect(body.text).to.contain('ws-123');
  });

  it('includes the org id and marks workspace unavailable when workspaceId is null', async () => {
    fetchStub.resolves({ ok: true, status: 200, text: async () => 'ok' });

    await notifyOnboarding(
      { SLACK_ONBOARDING_WEBHOOK_URL: WEBHOOK_URL },
      { ...payload, workspaceId: null },
    );

    const body = JSON.parse(fetchStub.firstCall.args[1].body);
    expect(body.text).to.contain('11111111-1111-4111-b111-111111111111');
    expect(body.text.toLowerCase()).to.contain('not available');
  });

  it('throws a 500 error when the webhook URL is not configured', async () => {
    await expect(notifyOnboarding({}, payload))
      .to.be.rejectedWith(/not configured/i)
      .and.eventually.have.property('status', 500);
    expect(fetchStub.called).to.equal(false);
  });

  it('throws a 502 error when the webhook responds non-2xx', async () => {
    fetchStub.resolves({ ok: false, status: 500, text: async () => 'boom' });

    await expect(notifyOnboarding({ SLACK_ONBOARDING_WEBHOOK_URL: WEBHOOK_URL }, payload))
      .to.be.rejected
      .and.eventually.have.property('status', 502);
  });

  it('throws a 502 error when the webhook call rejects (network failure)', async () => {
    fetchStub.rejects(new Error('ECONNREFUSED'));

    await expect(notifyOnboarding({ SLACK_ONBOARDING_WEBHOOK_URL: WEBHOOK_URL }, payload))
      .to.be.rejected
      .and.eventually.have.property('status', 502);
  });
});
