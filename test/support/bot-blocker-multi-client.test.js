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
      headers: new Map([['content-length', '100']]),
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
      expect(result.perClient).to.have.keys(['adobe-fetch', 'undici', 'undici-browser']);
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

  it('skips the body read when Content-Length exceeds the cap', async () => {
    const detectBotBlockerFn = sinon.stub().resolves({ crawlable: true, type: 'none', confidence: 1 });
    const textStub = sinon.stub().rejects(new Error('body should not be read'));
    const fetchFn = sinon.stub().resolves({
      status: 200,
      headers: new Map([['content-length', '70000']]),
      text: textStub,
    });

    const result = await detectBotBlockerMultiClient(
      { baseUrl: 'https://big.com' },
      { log, detectBotBlockerFn, fetchFn },
    );

    expect(textStub.called).to.be.false; // oversized body never read
    expect(result.perClient.undici.crawlable).to.be.true;
  });

  it('bounds a hanging body read via timeout (verdict still resolves)', async () => {
    const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const detectBotBlockerFn = sinon.stub().resolves({ crawlable: true, type: 'none', confidence: 1 });
      const fetchFn = sinon.stub().resolves({
        status: 200,
        headers: new Map([['content-length', '100']]),
        text: () => new Promise(() => {}), // never resolves
      });

      const promise = detectBotBlockerMultiClient(
        { baseUrl: 'https://slow.com' },
        { log, detectBotBlockerFn, fetchFn },
      );
      await clock.tickAsync(3001); // fire the body-read-timeout
      const result = await promise;

      expect(result.crawlable).to.be.true;
      expect(result.perClient.undici.crawlable).to.be.true;
    } finally {
      clock.restore();
    }
  });

  it('skips the body read for chunked responses (no Content-Length)', async () => {
    const detectBotBlockerFn = sinon.stub().resolves({ crawlable: true, type: 'none', confidence: 1 });
    const textStub = sinon.stub().resolves('<html>');
    const fetchFn = sinon.stub().resolves({ status: 200, headers: new Map(), text: textStub });

    const result = await detectBotBlockerMultiClient(
      { baseUrl: 'https://chunked.com' },
      { log, detectBotBlockerFn, fetchFn },
    );

    expect(textStub.called).to.be.false; // chunked body never read (unbounded-read guard)
    expect(result.perClient.undici.crawlable).to.be.true;
  });

  it('does not leak the @adobe/fetch reason when only undici is the blocker', async () => {
    const detectBotBlockerFn = sinon.stub().resolves({
      crawlable: true, type: 'cloudflare-allowed', confidence: 1, reason: 'infra present',
    });
    const fetchFn = sinon.stub().resolves(resp(403, [['server', 'cloudflare'], ['cf-ray', 'r']]));

    const result = await detectBotBlockerMultiClient(
      { baseUrl: 'https://datacom.com' },
      { log, detectBotBlockerFn, fetchFn },
    );

    expect(result.crawlable).to.be.false;
    expect(result.type).to.equal('cloudflare');
    expect(result.reason).to.equal(undefined); // not 'infra present' from the allowed adobe probe
  });

  it('adds a diagnostic undici-browser probe to perClient (not part of the aggregate)', async () => {
    const detectBotBlockerFn = sinon.stub().resolves({ crawlable: true, type: 'none', confidence: 1 });
    const fetchFn = sinon.stub().resolves(resp(200));

    const result = await detectBotBlockerMultiClient(
      { baseUrl: 'https://ok.com' },
      { log, detectBotBlockerFn, fetchFn },
    );

    expect(result.perClient).to.have.keys(['adobe-fetch', 'undici', 'undici-browser']);
    expect(result.perClient['undici-browser'].crawlable).to.be.true;
    // one undici call for the plain probe, one for the browser probe
    expect(fetchFn.callCount).to.equal(2);
    // the browser probe is the only one carrying Client Hints / Accept-Language
    const browserCall = fetchFn.getCalls().find((c) => c.args[1].headers['sec-ch-ua']);
    expect(browserCall, 'expected a browser-header probe call').to.exist;
    expect(browserCall.args[1].headers['Accept-Language']).to.equal('en-US,en;q=0.9');
    expect(browserCall.args[1].headers['User-Agent']).to.contain('Windows NT'); // desktop Chrome, not the SPACECAT UA
    // the plain undici probe must NOT carry browser headers (real-client fidelity)
    const plainCall = fetchFn.getCalls().find((c) => !c.args[1].headers['sec-ch-ua']);
    expect(plainCall.args[1].headers['Accept-Language']).to.be.undefined;
  });

  it('distinguishes a header/UA-based block: undici blocked but undici-browser passes (aggregate still reflects real undici)', async () => {
    const detectBotBlockerFn = sinon.stub().resolves({ crawlable: true, type: 'cloudflare-allowed', confidence: 1 });
    // Browser-header request (carries Accept-Language) is allowed; the plain bot-UA
    // request (no Accept-Language) is 403'd — i.e. a header/UA-based rule.
    const fetchFn = sinon.stub().callsFake((url, opts) => Promise.resolve(
      opts.headers['Accept-Language']
        ? resp(200)
        : resp(403, [['server', 'cloudflare'], ['cf-ray', 'h']]),
    ));

    const result = await detectBotBlockerMultiClient(
      { baseUrl: 'https://headers-matter.com' },
      { log, detectBotBlockerFn, fetchFn },
    );

    // Aggregate reflects the REAL undici client (bot UA) → blocked.
    expect(result.crawlable).to.be.false;
    expect(result.type).to.equal('cloudflare');
    expect(result.perClient.undici.crawlable).to.be.false;
    // Diagnostic signal: browser headers get through → block is header/UA-based.
    expect(result.perClient['undici-browser'].crawlable).to.be.true;
  });
});
