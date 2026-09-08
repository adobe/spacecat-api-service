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

import crypto from 'crypto';
import { Request } from '@adobe/fetch';
import bodyData from '@adobe/helix-shared-body-data/src/body-data-wrapper.js';
import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  slackSignatureWrapper,
  computeSlackSignature,
  MAX_BODY_BYTES,
  MAX_TIMESTAMP_SKEW_SECONDS,
} from '../../../src/support/slack/signature-wrapper.js';

use(sinonChai);

const SIGNING_SECRET = 'test-signing-secret';

describe('slackSignatureWrapper', () => {
  let sandbox;
  let log;
  let next;

  const nowSeconds = () => Math.floor(Date.now() / 1000);

  const buildRequest = (body, headers = {}) => new Request('https://spacecat.test/slack/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

  const buildContext = (headers = {}, overrides = {}) => ({
    log,
    env: { SLACK_SIGNING_SECRET: SIGNING_SECRET },
    pathInfo: { method: 'POST', suffix: '/slack/events', headers },
    ...overrides,
  });

  // Mirrors what a genuine Slack delivery looks like: signed body + matching timestamp.
  const signedDelivery = (body, { secret = SIGNING_SECRET, timestamp = `${nowSeconds()}` } = {}) => {
    const headers = {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': computeSlackSignature(secret, timestamp, body),
    };
    return { request: buildRequest(body, headers), context: buildContext(headers) };
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    log = {
      debug: sandbox.stub(),
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };
    next = sandbox.stub().resolves('downstream-called');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('routes it guards', () => {
    it('passes a correctly signed request through to the downstream handler', async () => {
      const body = JSON.stringify({ type: 'event_callback', event: { type: 'app_mention' } });
      const { request, context } = signedDelivery(body);

      const result = await slackSignatureWrapper(next)(request, context);

      expect(result).to.equal('downstream-called');
      expect(next).to.have.been.calledOnce;
    });

    it('verifies a form-urlencoded interactive payload byte-exactly', async () => {
      // Slack posts interactive payloads as application/x-www-form-urlencoded and signs the
      // encoded body, not the decoded JSON.
      const body = `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions', actions: [{ action_id: 'approveOrg' }] }))}`;
      const timestamp = `${nowSeconds()}`;
      const headers = {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': computeSlackSignature(SIGNING_SECRET, timestamp, body),
      };
      const request = new Request('https://spacecat.test/slack/events', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body,
      });

      const result = await slackSignatureWrapper(next)(request, buildContext(headers));

      expect(result).to.equal('downstream-called');
    });

    it('verifies a body containing multi-byte UTF-8 characters', async () => {
      const body = JSON.stringify({ type: 'event_callback', text: 'héllo ☃ 日本語' });
      const { request, context } = signedDelivery(body);

      await slackSignatureWrapper(next)(request, context);

      expect(next).to.have.been.calledOnce;
    });

    it('leaves non-Slack routes untouched, even with no signature headers', async () => {
      const request = buildRequest('{}');
      const context = buildContext({}, { pathInfo: { method: 'GET', suffix: '/sites', headers: {} } });

      const result = await slackSignatureWrapper(next)(request, context);

      expect(result).to.equal('downstream-called');
      expect(log.warn).to.have.not.been.called;
    });

    it('guards the suffix form without a leading slash', async () => {
      const request = buildRequest('{}');
      const context = buildContext({}, { pathInfo: { method: 'POST', suffix: 'slack/events', headers: {} } });

      const result = await slackSignatureWrapper(next)(request, context);

      expect(result.status).to.equal(401);
      expect(next).to.have.not.been.called;
    });

    it('lets an OPTIONS preflight through unverified', async () => {
      // CORS preflight carries no body to sign and is answered with a 204 by run(); turning it
      // into a 401 would be a gratuitous behaviour change.
      const context = buildContext({}, { pathInfo: { method: 'OPTIONS', suffix: '/slack/events', headers: {} } });

      const result = await slackSignatureWrapper(next)(buildRequest('{}'), context);

      expect(result).to.equal('downstream-called');
    });

    it('still guards non-POST, non-preflight methods on the Slack suffix', async () => {
      // Deliberately wider than the single POST route the router exposes today, so re-adding a
      // route on this path cannot silently create an unverified entry point.
      const context = buildContext({}, { pathInfo: { method: 'GET', suffix: '/slack/events', headers: {} } });

      const result = await slackSignatureWrapper(next)(buildRequest('{}'), context);

      expect(result.status).to.equal(401);
      expect(next).to.have.not.been.called;
    });

    it('fails CLOSED when pathInfo is missing but the URL is the Slack route', async () => {
      // Regression guard for the ordering hazard: if this wrapper ever ran before
      // enrichPathInfo, `pathInfo.suffix` would be empty. Keying only off pathInfo would then
      // skip the guard and pass the request through UNVERIFIED -- the VULN-39365 surface.
      // The raw-URL backstop must reject instead.
      const result = await slackSignatureWrapper(next)(buildRequest('{}'), { log, env: {} });

      expect(result.status).to.equal(401);
      expect(next).to.have.not.been.called;
    });

    it('fails closed on the Slack URL even with a trailing slash', async () => {
      const request = new Request('https://spacecat.test/slack/events/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      const result = await slackSignatureWrapper(next)(request, { log, env: {} });

      expect(result.status).to.equal(401);
    });

    it('fails closed on the Slack URL behind an /api/v1 prefix', async () => {
      const request = new Request('https://spacecat.test/api/v1/slack/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      const result = await slackSignatureWrapper(next)(request, { log, env: {} });

      expect(result.status).to.equal(401);
    });

    it('still passes a non-Slack URL through when pathInfo is missing', async () => {
      const request = new Request('https://spacecat.test/sites', { method: 'GET' });

      const result = await slackSignatureWrapper(next)(request, { log, env: {} });

      expect(result).to.equal('downstream-called');
    });

    it('does not guard the sibling /slack/channels route', async () => {
      // Authenticated by RouteScopedLegacyApiKeyHandler, not signed by Slack.
      const request = new Request('https://spacecat.test/slack/channels/invite-by-user-id', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      const result = await slackSignatureWrapper(next)(request, { log, env: {} });

      expect(result).to.equal('downstream-called');
    });
  });

  describe('rejects forged and malformed requests', () => {
    const expectUnauthorized = (result) => {
      expect(result.status).to.equal(401);
      expect(result.headers.get('x-error')).to.equal('slack signature verification failed');
      expect(next).to.have.not.been.called;
    };

    it('rejects a request with no signature headers at all (the VULN-39365 attack)', async () => {
      const body = JSON.stringify({ type: 'event_callback', event: { type: 'app_mention' } });

      const result = await slackSignatureWrapper(next)(buildRequest(body), buildContext({}));

      expectUnauthorized(result);
    });

    it('rejects a signature computed with the wrong secret', async () => {
      const body = JSON.stringify({ type: 'event_callback' });
      const { request, context } = signedDelivery(body, { secret: 'attacker-guess' });

      expectUnauthorized(await slackSignatureWrapper(next)(request, context));
    });

    it('rejects when the body was tampered with after signing', async () => {
      const timestamp = `${nowSeconds()}`;
      const signedBody = JSON.stringify({ type: 'event_callback', event: { type: 'app_mention' } });
      const headers = {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': computeSlackSignature(SIGNING_SECRET, timestamp, signedBody),
      };
      const tamperedBody = JSON.stringify({ type: 'event_callback', event: { type: 'file_shared' } });

      const result = await slackSignatureWrapper(next)(
        buildRequest(tamperedBody, headers),
        buildContext(headers),
      );

      expectUnauthorized(result);
    });

    it('rejects a missing timestamp header', async () => {
      const body = '{}';
      const headers = { 'x-slack-signature': computeSlackSignature(SIGNING_SECRET, `${nowSeconds()}`, body) };

      expectUnauthorized(await slackSignatureWrapper(next)(
        buildRequest(body, headers),
        buildContext(headers),
      ));
    });

    it('rejects a missing signature header', async () => {
      const headers = { 'x-slack-request-timestamp': `${nowSeconds()}` };

      expectUnauthorized(await slackSignatureWrapper(next)(
        buildRequest('{}', headers),
        buildContext(headers),
      ));
    });

    it('rejects a malformed signature header without throwing on length mismatch', async () => {
      const headers = {
        'x-slack-request-timestamp': `${nowSeconds()}`,
        'x-slack-signature': 'v0=not-hex',
      };

      expectUnauthorized(await slackSignatureWrapper(next)(
        buildRequest('{}', headers),
        buildContext(headers),
      ));
    });

    it('rejects an uppercase-hex signature (pattern is strict)', async () => {
      const body = '{}';
      const timestamp = `${nowSeconds()}`;
      const headers = {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': computeSlackSignature(SIGNING_SECRET, timestamp, body).toUpperCase(),
      };

      expectUnauthorized(await slackSignatureWrapper(next)(
        buildRequest(body, headers),
        buildContext(headers),
      ));
    });

    it('rejects a non-numeric timestamp', async () => {
      const body = '{}';
      const headers = {
        'x-slack-request-timestamp': 'not-a-number',
        'x-slack-signature': computeSlackSignature(SIGNING_SECRET, 'not-a-number', body),
      };

      expectUnauthorized(await slackSignatureWrapper(next)(
        buildRequest(body, headers),
        buildContext(headers),
      ));
    });

    it('rejects a replayed request whose timestamp is too old', async () => {
      const stale = `${nowSeconds() - MAX_TIMESTAMP_SKEW_SECONDS - 1}`;
      const { request, context } = signedDelivery('{}', { timestamp: stale });

      expectUnauthorized(await slackSignatureWrapper(next)(request, context));
    });

    it('rejects a timestamp too far in the future', async () => {
      const future = `${nowSeconds() + MAX_TIMESTAMP_SKEW_SECONDS + 60}`;
      const { request, context } = signedDelivery('{}', { timestamp: future });

      expectUnauthorized(await slackSignatureWrapper(next)(request, context));
    });

    // Boundary cases are pinned with fake timers: with the real clock a one-second boundary can
    // flake under CI load, and the exact +/-MAX assertions would not be exact.
    describe('replay-window boundaries (fake timers)', () => {
      let clock;

      beforeEach(() => {
        clock = sandbox.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
      });

      afterEach(() => {
        clock.restore();
      });

      it('accepts a timestamp at the exact past edge of the replay window', async () => {
        const edge = `${nowSeconds() - MAX_TIMESTAMP_SKEW_SECONDS}`;
        const { request, context } = signedDelivery('{}', { timestamp: edge });

        expect(await slackSignatureWrapper(next)(request, context)).to.equal('downstream-called');
      });

      it('accepts a timestamp at the exact future edge of the replay window', async () => {
        const edge = `${nowSeconds() + MAX_TIMESTAMP_SKEW_SECONDS}`;
        const { request, context } = signedDelivery('{}', { timestamp: edge });

        expect(await slackSignatureWrapper(next)(request, context)).to.equal('downstream-called');
      });

      it('rejects a timestamp exactly one second past the window', async () => {
        const stale = `${nowSeconds() - MAX_TIMESTAMP_SKEW_SECONDS - 1}`;
        const { request, context } = signedDelivery('{}', { timestamp: stale });

        expectUnauthorized(await slackSignatureWrapper(next)(request, context));
      });

      it('rejects a timestamp exactly one second beyond the future window', async () => {
        const ahead = `${nowSeconds() + MAX_TIMESTAMP_SKEW_SECONDS + 1}`;
        const { request, context } = signedDelivery('{}', { timestamp: ahead });

        expectUnauthorized(await slackSignatureWrapper(next)(request, context));
      });

      it('reports the observed skew so clock drift is diagnosable', async () => {
        const stale = `${nowSeconds() - MAX_TIMESTAMP_SKEW_SECONDS - 42}`;
        const { request, context } = signedDelivery('{}', { timestamp: stale });

        await slackSignatureWrapper(next)(request, context);

        const logged = log.warn.getCalls().map((c) => c.args.join(' ')).join('\n');
        expect(logged).to.contain('reason=stale_timestamp');
        expect(logged).to.contain(`skewSeconds=${MAX_TIMESTAMP_SKEW_SECONDS + 42}`);
      });
    });

    it('rejects a body larger than the cap before hashing it', async () => {
      const body = 'x'.repeat(MAX_BODY_BYTES + 1);
      const { request, context } = signedDelivery(body);

      expectUnauthorized(await slackSignatureWrapper(next)(request, context));
    });

    it('rejects an oversized body whose content-length understates it (post-read enforcement)', async () => {
      // The declared-length check is an honest-client hint; a forger can omit or understate it.
      // This exercises the post-read byte-length branch the code calls "the real enforcement".
      const body = 'x'.repeat(MAX_BODY_BYTES + 1);
      const timestamp = `${nowSeconds()}`;
      const headers = {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': computeSlackSignature(SIGNING_SECRET, timestamp, body),
      };
      const request = buildRequest(body, { ...headers, 'content-length': '10' });

      const result = await slackSignatureWrapper(next)(request, buildContext(headers));

      expectUnauthorized(result);
      const logged = log.warn.getCalls().map((c) => c.args.join(' ')).join('\n');
      expect(logged).to.contain('reason=body_too_large');
      expect(logged).to.contain('bodyBytes=');
    });

    it('rejects a declared-oversized content-length without reading the body', async () => {
      const body = '{}';
      const timestamp = `${nowSeconds()}`;
      const headers = {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': computeSlackSignature(SIGNING_SECRET, timestamp, body),
      };
      const request = buildRequest(body, { ...headers, 'content-length': `${MAX_BODY_BYTES + 1}` });
      sandbox.spy(request, 'clone');

      expectUnauthorized(await slackSignatureWrapper(next)(request, buildContext(headers)));
      expect(request.clone).to.have.not.been.called;
    });

    it('fails closed when SLACK_SIGNING_SECRET is not configured', async () => {
      const body = '{}';
      const { request } = signedDelivery(body);
      const timestamp = `${nowSeconds()}`;
      const context = buildContext({
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': computeSlackSignature(SIGNING_SECRET, timestamp, body),
      }, { env: {} });

      expectUnauthorized(await slackSignatureWrapper(next)(request, context));
    });

    it('fails closed when context.env is absent entirely', async () => {
      const context = buildContext({}, { env: undefined });

      expectUnauthorized(await slackSignatureWrapper(next)(buildRequest('{}'), context));
    });

    it('returns 401 rather than throwing when the body cannot be read', async () => {
      const body = '{}';
      const { request, context } = signedDelivery(body);
      sandbox.stub(request, 'clone').throws(new Error('stream already consumed'));

      expectUnauthorized(await slackSignatureWrapper(next)(request, context));
    });

    it('never logs the signature, secret or body', async () => {
      const body = JSON.stringify({ secretish: 'do-not-log-me' });
      const { request, context } = signedDelivery(body, { secret: 'attacker-guess' });

      await slackSignatureWrapper(next)(request, context);

      const logged = log.warn.getCalls().map((c) => c.args.join(' ')).join('\n');
      expect(logged).to.contain('reason=signature_mismatch');
      // Diagnostic fields are safe to log; the secret, the signature and the body are not.
      expect(logged).to.contain('bodyBytes=');
      expect(logged).to.not.contain(SIGNING_SECRET);
      expect(logged).to.not.contain('attacker-guess');
      expect(logged).to.not.contain('do-not-log-me');
      expect(logged).to.not.contain('v0=');
    });
  });

  describe('interaction with downstream body parsing', () => {
    it('leaves the body readable by bodyData (uses clone, not the original stream)', async () => {
      const payload = { type: 'event_callback', event: { type: 'app_mention', text: 'hi' } };
      const body = JSON.stringify(payload);
      const { request, context } = signedDelivery(body);

      // bodyData is what actually populates context.data in the real chain, and it runs
      // *after* this wrapper. Compose them the same way src/index.js does.
      let parsed;
      const chained = slackSignatureWrapper(bodyData(async (req, ctx) => {
        parsed = ctx.data;
        return 'ok';
      }));

      const result = await chained(request, context);

      expect(result).to.equal('ok');
      expect(parsed).to.deep.equal(payload);
    });
  });

  describe('computeSlackSignature', () => {
    it('matches the Slack-documented v0 basestring construction', async () => {
      const timestamp = '1531420618';
      const body = 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J';
      const expected = `v0=${crypto
        .createHmac('sha256', SIGNING_SECRET)
        .update(`v0:${timestamp}:${body}`, 'utf8')
        .digest('hex')}`;

      expect(computeSlackSignature(SIGNING_SECRET, timestamp, body)).to.equal(expected);
    });
  });
});
