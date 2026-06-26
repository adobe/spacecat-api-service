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

/* eslint-env mocha */

import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import { detectBotBlockerMultiClient } from '../../src/support/bot-blocker-multi-client.js';

const log = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};

// Fake fetch Response whose headers iterate like undici's Headers.
const resp = (status, headerPairs = [], html = '') => ({
  status,
  headers: new Map(headerPairs),
  text: async () => html,
});

describe('detectBotBlockerMultiClient', () => {
  it('aggregates crawlable=true when BOTH clients are allowed', async () => {
    const detectBotBlockerFn = sinon.stub().resolves({ crawlable: true, type: 'none', confidence: 1 });
    const fetchFn = sinon.stub().resolves(resp(200));

    const result = await detectBotBlockerMultiClient(
      { baseUrl: 'https://ok.com' },
      { log, detectBotBlockerFn, fetchFn },
    );

    expect(result.crawlable).to.be.true;
    expect(result.perClient['adobe-fetch'].crawlable).to.be.true;
    expect(result.perClient.undici.crawlable).to.be.true;
    expect(result.type).to.equal('none');
  });

  it('aggregates crawlable=FALSE when undici is blocked but @adobe/fetch is allowed', async () => {
    const detectBotBlockerFn = sinon.stub().resolves({
      crawlable: true, type: 'cloudflare-allowed', confidence: 1, userAgent: 'Spacecat/1.0', ipsToAllowlist: ['1.2.3.4'],
    });
    const fetchFn = sinon.stub().resolves(resp(403, [['server', 'cloudflare'], ['cf-ray', 'abc']]));

    const result = await detectBotBlockerMultiClient(
      { baseUrl: 'https://datacom.com' },
      { log, detectBotBlockerFn, fetchFn },
    );

    expect(result.crawlable).to.be.false;
    expect(result.type).to.equal('cloudflare'); // blocking client's type surfaced
    expect(result.perClient['adobe-fetch'].crawlable).to.be.true;
    expect(result.perClient.undici.crawlable).to.be.false;
    // adobe fields preserved for downstream messaging
    expect(result.userAgent).to.equal('Spacecat/1.0');
    expect(result.ipsToAllowlist).to.deep.equal(['1.2.3.4']);
  });

  it('uses the @adobe/fetch block (with reason) when it is the blocker', async () => {
    const detectBotBlockerFn = sinon.stub().resolves({
      crawlable: false, type: 'akamai', confidence: 0.99, reason: 'challenge page',
    });
    const fetchFn = sinon.stub().resolves(resp(200));

    const result = await detectBotBlockerMultiClient(
      { baseUrl: 'https://blocked.com' },
      { log, detectBotBlockerFn, fetchFn },
    );

    expect(result.crawlable).to.be.false;
    expect(result.type).to.equal('akamai');
    expect(result.reason).to.equal('challenge page');
    expect(result.perClient['adobe-fetch'].crawlable).to.be.false;
  });

  it('treats an undici fetch failure as inconclusive (not a block)', async () => {
    const detectBotBlockerFn = sinon.stub().resolves({ crawlable: true, type: 'none', confidence: 1 });
    const fetchFn = sinon.stub().rejects(new Error('ECONNREFUSED'));

    const result = await detectBotBlockerMultiClient(
      { baseUrl: 'https://ok.com' },
      { log, detectBotBlockerFn, fetchFn },
    );

    expect(result.crawlable).to.be.true;
    expect(result.perClient.undici.type).to.equal('unknown');
    expect(result.perClient.undici.confidence).to.equal(0.3);
  });

  it('handles a body read failure gracefully (html defaults to empty)', async () => {
    const detectBotBlockerFn = sinon.stub().resolves({ crawlable: true, type: 'none', confidence: 1 });
    const fetchFn = sinon.stub().resolves({
      status: 200,
      headers: new Map(),
      text: async () => { throw new Error('stream error'); },
    });

    const result = await detectBotBlockerMultiClient(
      { baseUrl: 'https://ok.com' },
      { log, detectBotBlockerFn, fetchFn },
    );

    expect(result.crawlable).to.be.true;
    expect(result.perClient.undici.crawlable).to.be.true;
  });

  it('falls back to default deps when options are omitted', async () => {
    // Cover the default params (log/detectBotBlockerFn/fetchFn) hermetically by
    // esmocking the shared probe and stubbing global fetch.
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(resp(200));
    try {
      const mocked = await esmock('../../src/support/bot-blocker-multi-client.js', {
        '@adobe/spacecat-shared-utils': {
          detectBotBlocker: sinon.stub().resolves({ crawlable: true, type: 'none', confidence: 1 }),
          // keep the real analyzer + UA so classification is genuine
          analyzeBotProtection: (await import('@adobe/spacecat-shared-utils')).analyzeBotProtection,
          SPACECAT_USER_AGENT: 'Spacecat/1.0',
        },
      });
      const result = await mocked.detectBotBlockerMultiClient({ baseUrl: 'https://ok.com' });
      expect(result.crawlable).to.be.true;
      expect(result.perClient).to.have.keys(['adobe-fetch', 'undici']);
    } finally {
      fetchStub.restore();
    }
  });

  it('keeps the @adobe/fetch classification when BOTH clients are blocked', async () => {
    const detectBotBlockerFn = sinon.stub().resolves({ crawlable: false, type: 'akamai', confidence: 0.99 });
    const fetchFn = sinon.stub().resolves(resp(403, [['server', 'cloudflare'], ['cf-ray', 'z']]));

    const result = await detectBotBlockerMultiClient(
      { baseUrl: 'https://both-blocked.com' },
      { log, detectBotBlockerFn, fetchFn },
    );

    expect(result.crawlable).to.be.false;
    expect(result.type).to.equal('akamai'); // @adobe/fetch block preferred when both are blocked
    expect(result.perClient['adobe-fetch'].crawlable).to.be.false;
    expect(result.perClient.undici.crawlable).to.be.false;
  });

  it('treats an @adobe/fetch probe failure as inconclusive (not a block)', async () => {
    const detectBotBlockerFn = sinon.stub().rejects(new Error('DNS failure'));
    const fetchFn = sinon.stub().resolves(resp(200));

    const result = await detectBotBlockerMultiClient(
      { baseUrl: 'https://ok.com' },
      { log, detectBotBlockerFn, fetchFn },
    );

    expect(result.crawlable).to.be.true;
    expect(result.perClient['adobe-fetch'].type).to.equal('unknown');
    expect(result.perClient['adobe-fetch'].confidence).to.equal(0.3);
  });
});
