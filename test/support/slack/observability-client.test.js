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

import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('observability-client', () => {
  let sandbox;
  let log;
  let postMessageStub;
  let createObservabilitySlackClient;

  async function load() {
    return esmock('../../../src/support/slack/observability-client.js', {
      '@slack/web-api': {
        WebClient: class {
          constructor() {
            this.chat = { postMessage: postMessageStub };
          }
        },
      },
    });
  }

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    log = { info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub() };
    postMessageStub = sandbox.stub().resolves({ ok: true, ts: '1716200000.000300' });
    ({ createObservabilitySlackClient } = await load());
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('is disabled when no token is provided', () => {
    const client = createObservabilitySlackClient({ token: undefined, log });
    expect(client.enabled).to.be.false;
  });

  it('is enabled when a token is provided', () => {
    const client = createObservabilitySlackClient({ token: 'xoxb-test', log });
    expect(client.enabled).to.be.true;
  });

  it('returns the message ts on a successful post', async () => {
    const client = createObservabilitySlackClient({ token: 'xoxb-test', log });
    const ts = await client.postMessage({ channel: 'C123', text: 'hello' });
    expect(ts).to.equal('1716200000.000300');
    expect(postMessageStub.calledOnceWithExactly({ channel: 'C123', text: 'hello', attachments: undefined })).to.be.true;
  });

  it('returns null and logs a warning when the post throws (never raises)', async () => {
    postMessageStub.rejects(new Error('slack down'));
    const client = createObservabilitySlackClient({ token: 'xoxb-test', log });
    const ts = await client.postMessage({ channel: 'C123', text: 'hello' });
    expect(ts).to.be.null;
    expect(log.warn.calledOnce).to.be.true;
  });

  it('returns null when the post succeeds but ts is absent', async () => {
    postMessageStub.resolves({ ok: true }); // no ts field
    const client = createObservabilitySlackClient({ token: 'xoxb-test', log });
    const ts = await client.postMessage({ channel: 'C123', text: 'hello' });
    expect(ts).to.be.null;
    expect(log.warn.called).to.be.false;
  });

  it('returns null without calling Slack when channel is missing', async () => {
    const client = createObservabilitySlackClient({ token: 'xoxb-test', log });
    const ts = await client.postMessage({ channel: undefined, text: 'hello' });
    expect(ts).to.be.null;
    expect(postMessageStub.called).to.be.false;
  });

  it('returns null without calling Slack when disabled (no token)', async () => {
    const client = createObservabilitySlackClient({ token: undefined, log });
    const ts = await client.postMessage({ channel: 'C123', text: 'hello' });
    expect(ts).to.be.null;
    expect(postMessageStub.called).to.be.false;
  });
});
