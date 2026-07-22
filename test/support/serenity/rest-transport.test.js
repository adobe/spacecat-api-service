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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { ProjectEngineApiError } from '@adobe/spacecat-shared-project-engine-client';

import {
  createSerenityTransport,
  SerenityTransportError,
  redactUpstreamMessage,
} from '../../../src/support/serenity/rest-transport.js';

use(chaiAsPromised);
use(sinonChai);

const IMS = 'ims-bearer-test-token';
const WORKSPACE_ID = '11111111-2222-3333-4444-555555555555';
const PROJECT_ID = 'proj-xyz';
// Sub-workspace lifecycle (serenity dual-mode, subworkspace path) parent id —
// used both by the createSubworkspace/listWorkspaceFamily describe blocks below
// and by the retry-behaviour suite's real create-call-shape tests.
const PARENT_WS = 'bb0f4e1c-8bb1-402e-88f2-f68618ea7397';

// Strict mode: rest-transport now requires SEMRUSH_PROJECTS_BASE_URL to be
// supplied via env (Vault-backed in dev/stage/prod). Tests inject a
// deterministic value so the URL-based assertions below stay stable.
const TEST_ENV = { SEMRUSH_PROJECTS_BASE_URL: 'https://adobe-hackathon.semrush.com' };

// All transport methods now route through the typed Semrush clients (Project
// Engine + User Manager, both openapi-fetch), which call the injected fetch with
// a `Request` object. Real `Response` objects are returned so openapi-fetch can
// parse them the same way it parses live responses.
function fetchOk(body) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchFail(status, body) {
  return new Response(JSON.stringify(body ?? { code: 'upstream_error' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Normalises whatever the fetch seam received into a uniform shape. Every method
// now issues a typed-client call (a `Request` object); the `(urlString, init)`
// branch is kept defensively for any non-Request call style.
async function callOf(stub, n = 0) {
  const [input, init] = stub.getCall(n).args;
  if (typeof Request !== 'undefined' && input instanceof Request) {
    const text = await input.clone().text();
    return {
      url: input.url,
      method: input.method,
      body: text === '' ? undefined : text,
      header: (k) => input.headers.get(k),
    };
  }
  return {
    url: input,
    method: init?.method,
    body: init?.body,
    header: (k) => (init?.headers ?? {})[k],
  };
}

describe('Semrush REST transport', () => {
  const sandbox = sinon.createSandbox();
  let fetchStub;
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchStub = sandbox.stub();
    global.fetch = fetchStub;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    sandbox.restore();
  });

  describe('auth + base URL', () => {
    it('surfaces a missing-imsToken 401 as a ProjectEngineApiError wrapping the auth cause on a PE call', async () => {
      // LLMO-6386: a Project Engine call throws ProjectEngineApiError directly. The shared
      // authToken getter still throws SerenityTransportError(401) on a missing token, but that
      // now happens inside the facade's auth middleware, so it is surfaced as the facade's
      // no-HTTP-response ProjectEngineApiError (status undefined) carrying the 401 as `.cause`.
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: '' });
      const err = await transport.publishProject(WORKSPACE_ID, PROJECT_ID).catch((e) => e);
      expect(err).to.be.instanceOf(ProjectEngineApiError);
      expect(err.status).to.equal(undefined);
      expect(err.cause).to.be.instanceOf(SerenityTransportError);
      expect(err.cause.status).to.equal(401);
      expect(err.cause.message).to.match(/Missing IMS bearer token/);
    });

    it('sends Authorization: Bearer <ims> — no cookie, no Auth-Data-Jwt, no User-Agent', async () => {
      fetchStub.resolves(fetchOk({ id: PROJECT_ID }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.publishProject(WORKSPACE_ID, PROJECT_ID);

      const call = await callOf(fetchStub);
      expect(call.header('Authorization')).to.equal(`Bearer ${IMS}`);
      expect(call.header('Accept')).to.equal('application/json');
      expect(call.header('Cookie')).to.equal(null);
      expect(call.header('Auth-Data-Jwt')).to.equal(null);
      expect(call.header('User-Agent')).to.equal(null);
    });

    it('uses the env-supplied base URL when constructing outbound URLs', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.publishProject(WORKSPACE_ID, PROJECT_ID);

      const call = await callOf(fetchStub);
      expect(call.url).to.match(/^https:\/\/adobe-hackathon\.semrush\.com\//);
    });

    it('throws if SEMRUSH_PROJECTS_BASE_URL is missing (no source default)', () => {
      expect(() => createSerenityTransport({ env: {}, imsToken: IMS }))
        .to.throw(/SEMRUSH_PROJECTS_BASE_URL is not set/);
    });

    it('throws if SEMRUSH_PROJECTS_BASE_URL is blank', () => {
      expect(() => createSerenityTransport({
        env: { SEMRUSH_PROJECTS_BASE_URL: '   ' },
        imsToken: IMS,
      })).to.throw(/SEMRUSH_PROJECTS_BASE_URL is not set/);
    });

    it('reads SEMRUSH_PROJECTS_BASE_URL from env and strips trailing slash', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({
        env: { SEMRUSH_PROJECTS_BASE_URL: 'https://override.semrush.com/' },
        imsToken: IMS,
      });

      await transport.publishProject(WORKSPACE_ID, PROJECT_ID);

      const call = await callOf(fetchStub);
      expect(call.url).to.match(/^https:\/\/override\.semrush\.com\/enterprise\//);
    });

    it('reduces a value with path/query/fragment to its bare origin', async () => {
      // A misconfigured `https://host/path-prefix` would otherwise silently
      // prepend the path to every outbound request. baseUrl() returns the
      // origin only — no path, no query, no fragment.
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({
        env: { SEMRUSH_PROJECTS_BASE_URL: 'https://override.semrush.com/some/path?x=1#frag' },
        imsToken: IMS,
      });

      await transport.publishProject(WORKSPACE_ID, PROJECT_ID);

      const call = await callOf(fetchStub);
      expect(call.url).to.match(/^https:\/\/override\.semrush\.com\/enterprise\/projects\/api\/v1\//);
      expect(call.url).to.not.include('/some/path');
      expect(call.url).to.not.include('x=1');
      expect(call.url).to.not.include('#frag');
    });

    it('strips userinfo from the base URL so credentials never leak outbound', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({
        env: { SEMRUSH_PROJECTS_BASE_URL: 'https://user:pass@override.semrush.com/' },
        imsToken: IMS,
      });

      await transport.publishProject(WORKSPACE_ID, PROJECT_ID);

      const call = await callOf(fetchStub);
      expect(call.url).to.not.include('user:pass@');
      expect(call.url).to.match(/^https:\/\/override\.semrush\.com\//);
    });

    it('rejects a non-https SEMRUSH_PROJECTS_BASE_URL with 503 configuration error', () => {
      try {
        createSerenityTransport({
          env: { SEMRUSH_PROJECTS_BASE_URL: 'http://attacker.example/' },
          imsToken: IMS,
        });
        expect.fail('expected createSerenityTransport to throw');
      } catch (e) {
        expect(e.message).to.match(/must use https/);
        expect(e.status).to.equal(503);
      }
    });

    it('rejects an unparseable SEMRUSH_PROJECTS_BASE_URL with 503 configuration error', () => {
      try {
        createSerenityTransport({
          env: { SEMRUSH_PROJECTS_BASE_URL: 'not a url' },
          imsToken: IMS,
        });
        expect.fail('expected createSerenityTransport to throw');
      } catch (e) {
        expect(e.message).to.match(/not a valid URL/);
        expect(e.status).to.equal(503);
      }
    });

    it('attaches status 503 to the missing-env error so mapError returns configurationError', () => {
      try {
        createSerenityTransport({ env: {}, imsToken: IMS });
        expect.fail('expected createSerenityTransport to throw');
      } catch (e) {
        expect(e.message).to.match(/SEMRUSH_PROJECTS_BASE_URL is not set/);
        expect(e.status).to.equal(503);
      }
    });

    // ── User Manager base-URL split (api-service#2656) ──
    // The User Manager gateway resolves its own origin from SEMRUSH_USERS_BASE_URL,
    // falling back to SEMRUSH_PROJECTS_BASE_URL when unset. getWorkspaceStatus is a
    // User-Manager-gateway method; publishProject is a Project-Engine method.
    it('routes User Manager calls at SEMRUSH_USERS_BASE_URL when set, Project Engine at SEMRUSH_PROJECTS_BASE_URL', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({
        env: {
          SEMRUSH_PROJECTS_BASE_URL: 'https://projects.semrush.test',
          SEMRUSH_USERS_BASE_URL: 'https://users.semrush.test',
        },
        imsToken: IMS,
      });

      await transport.getWorkspaceStatus(WORKSPACE_ID);
      expect((await callOf(fetchStub)).url)
        .to.match(/^https:\/\/users\.semrush\.test\/enterprise\/users\/api\//);

      await transport.publishProject(WORKSPACE_ID, PROJECT_ID);
      expect((await callOf(fetchStub, 1)).url)
        .to.match(/^https:\/\/projects\.semrush\.test\/enterprise\/projects\/api\//);
    });

    it('falls back to SEMRUSH_PROJECTS_BASE_URL for User Manager calls when SEMRUSH_USERS_BASE_URL is unset', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({
        env: { SEMRUSH_PROJECTS_BASE_URL: 'https://shared.semrush.test' },
        imsToken: IMS,
      });

      await transport.getWorkspaceStatus(WORKSPACE_ID);

      expect((await callOf(fetchStub)).url)
        .to.match(/^https:\/\/shared\.semrush\.test\/enterprise\/users\/api\//);
    });

    it('rejects a non-https SEMRUSH_USERS_BASE_URL naming the USERS var (503)', () => {
      try {
        createSerenityTransport({
          env: {
            SEMRUSH_PROJECTS_BASE_URL: 'https://projects.semrush.test',
            SEMRUSH_USERS_BASE_URL: 'http://attacker.example/',
          },
          imsToken: IMS,
        });
        expect.fail('expected createSerenityTransport to throw');
      } catch (e) {
        expect(e.message).to.match(/SEMRUSH_USERS_BASE_URL must use https/);
        expect(e.status).to.equal(503);
      }
    });

    it('encodes path segments so reserved chars stay inside the segment', async () => {
      fetchStub.resolves(fetchOk({ items: [] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.listAiModels('ws/with/slashes', 'pid?with#hash');

      const call = await callOf(fetchStub);
      // Slashes/question marks/hashes must be percent-encoded — never break
      // out of their segment (the typed client encodes path params).
      expect(call.url).to.include('ws%2Fwith%2Fslashes');
      expect(call.url).to.include('pid%3Fwith%23hash');
    });

    it('preserves a non-abort fetch error (network error, not timeout) as the PE facade cause', async () => {
      // createTimeoutFetch re-throws a non-AbortError verbatim; on a PE call (publishProject) the
      // facade then surfaces it as a status-undefined ProjectEngineApiError carrying the original
      // network error as `.cause` (LLMO-6386), rather than the raw error escaping directly.
      const netErr = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
      fetchStub.rejects(netErr);
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });
      const err = await transport.publishProject(WORKSPACE_ID, PROJECT_ID).catch((e) => e);
      expect(err).to.be.instanceOf(ProjectEngineApiError);
      expect(err.status).to.equal(undefined);
      expect(err.cause).to.equal(netErr);
    });

    it('aborts with a 504 SerenityTransportError cause (wrapped in ProjectEngineApiError) on a PE fetch timeout', async () => {
      // fetch never resolves; the transport's AbortController should fire.
      fetchStub.callsFake((_input, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });
      // Patch in a tiny "timeout" by stubbing setTimeout to immediately fire.
      const realSetTimeout = global.setTimeout;
      // Use sinon's fake timers narrowly so we don't break other things.
      const clock = sinon.useFakeTimers({
        now: 1_700_000_000_000,
        toFake: ['setTimeout', 'clearTimeout'],
      });
      try {
        const promise = transport.publishProject(WORKSPACE_ID, PROJECT_ID);
        // tickAsync (not tick): the typed client awaits its auth middleware
        // before the transport's timeout setTimeout is registered, so the clock
        // must interleave microtasks to let that timer be scheduled before it
        // fires. A synchronous tick would fire against a not-yet-registered timer.
        await clock.tickAsync(20_000); // safely past the 15s default timeout
        const err = await promise.catch((e) => e);
        // PE path: createTimeoutFetch's 504 SerenityTransportError is the facade's `.cause`.
        expect(err).to.be.instanceOf(ProjectEngineApiError);
        expect(err.status).to.equal(undefined);
        expect(err.cause).to.be.instanceOf(SerenityTransportError);
        expect(err.cause.status).to.equal(504);
      } finally {
        clock.restore();
        global.setTimeout = realSetTimeout;
      }
    });
  });

  // ── Retry / backoff (LLMO reliability gap-fix) ──────────────────────────
  //
  // Both typed clients underlying this transport (Project Engine, User
  // Manager) ship a bounded-backoff retry layer (createRetryingFetch in
  // spacecat-shared-project-engine-client / -user-manager-client's
  // internal.js). It used to be pinned off here (`maxRetries: 0`) to preserve
  // the pre-migration hand-rolled transport's one-shot behaviour; this suite
  // covers it now that the pin is removed and the library defaults
  // (maxRetries: 2, retryBaseDelayMs: 200 -> 3 attempts total) apply.
  //
  // Every test that drives a retryable outcome fakes `setTimeout`/`clearTimeout`
  // so the jittered exponential backoff (and the per-attempt 15s timeout) never
  // costs real wall-clock time; `tickAsync` (not `tick`) is required throughout
  // because the typed client's auth middleware and openapi-fetch both interleave
  // microtasks before each attempt's timer is registered.
  describe('retry behaviour', () => {
    const FAKE_NOW = 1_700_000_000_000;

    function withFakeTimers(fn) {
      return async () => {
        const clock = sinon.useFakeTimers({ now: FAKE_NOW, toFake: ['setTimeout', 'clearTimeout'] });
        try {
          await fn(clock);
        } finally {
          clock.restore();
        }
      };
    }

    it('retries a retryable GET (503) and returns the eventual success', withFakeTimers(async (clock) => {
      fetchStub.onCall(0).resolves(fetchFail(503, { code: 'unavailable' }));
      fetchStub.onCall(1).resolves(fetchOk({ status: 'created' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const promise = transport.getWorkspaceStatus(WORKSPACE_ID);
      await clock.tickAsync(60_000);
      const result = await promise;

      expect(result.status).to.equal('created');
      expect(fetchStub.callCount).to.equal(2);
    }));

    it('retries a retryable DELETE (503) and returns the eventual success', withFakeTimers(async (clock) => {
      // GET is the only idempotent method exercised for retryable 5xx above.
      // The idempotency gate treats GET/HEAD/PUT/DELETE/OPTIONS alike, so this
      // locks in that DELETE gets the same guarantee, using deleteProject (a
      // real transport method) rather than a synthetic call.
      fetchStub.onCall(0).resolves(fetchFail(503, { code: 'unavailable' }));
      fetchStub.onCall(1).resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const promise = transport.deleteProject(WORKSPACE_ID, PROJECT_ID);
      await clock.tickAsync(60_000);
      await promise;

      expect(fetchStub.callCount).to.equal(2);
      expect((await callOf(fetchStub, 1)).method).to.equal('DELETE');
    }));

    it('retries a 429 even on a POST create (createSubworkspace) and returns the eventual success', withFakeTimers(async (clock) => {
      // createSubworkspace is the real brand-provisioning create-call shape
      // (brand-provisioning.js -> workspace-lifecycle.js#ensureSubworkspace ->
      // transport.createSubworkspace). A 429 means the Semrush gateway rejected
      // the request at the edge before the handler ran, so the create never
      // happened -- safe to retry for ANY method, including this POST.
      fetchStub.onCall(0).resolves(fetchFail(429, { code: 'rate_limited' }));
      fetchStub.onCall(1).resolves(fetchOk({ id: 'subworkspace-ws-1', status: 'not ready' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const resources = { ai: { projects: 3, prompts: 1500 } };
      const promise = transport.createSubworkspace(PARENT_WS, 'Adobe Express', resources);
      await clock.tickAsync(60_000);
      const result = await promise;

      expect(result.id).to.equal('subworkspace-ws-1');
      expect(fetchStub.callCount).to.equal(2);
      const retryCall = await callOf(fetchStub, 1);
      expect(retryCall.method).to.equal('POST');
      expect(JSON.parse(retryCall.body)).to.deep.equal({ title: 'Adobe Express', resources });
    }));

    it('does NOT retry a 500 on a POST create (createSubworkspace) -- avoids double-provisioning', withFakeTimers(async (clock) => {
      // The critical guardrail: a create is a POST, and a 5xx is retried ONLY
      // for idempotent methods. Retrying a POST on 500 could double-fire the
      // sub-workspace/resource create upstream, so it must surface the 500
      // immediately, in a single attempt.
      fetchStub.resolves(fetchFail(500, { code: 'internal_error' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const resources = { ai: { projects: 3, prompts: 1500 } };
      const promise = transport.createSubworkspace(PARENT_WS, 'Adobe Express', resources)
        .catch((e) => e);
      await clock.tickAsync(60_000);
      const err = await promise;

      expect(err).to.be.instanceOf(SerenityTransportError);
      expect(err.status).to.equal(500);
      expect(fetchStub.callCount).to.equal(1);
    }));

    it('does NOT retry a 500 on the createProject POST either (same idempotency rule)', withFakeTimers(async (clock) => {
      fetchStub.resolves(fetchFail(500, { code: 'internal_error' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const promise = transport.createProject(WORKSPACE_ID, {
        name: 'US - EN',
        type: 'ai',
        brand_name_display: 'Acme',
        brand_names: ['Acme'],
        domain: 'acme.com',
        country_code: 'us',
        location_id: 2840,
        location_name: 'United States',
        language_id: 'lang-uuid-en',
      }).catch((e) => e);
      await clock.tickAsync(60_000);
      const err = await promise;

      // createProject is a Project Engine call → ProjectEngineApiError (LLMO-6386).
      expect(err).to.be.instanceOf(ProjectEngineApiError);
      expect(err.status).to.equal(500);
      expect(fetchStub.callCount).to.equal(1);
    }));

    it('retries a 429 on createProject (POST) and eventually succeeds', withFakeTimers(async (clock) => {
      fetchStub.onCall(0).resolves(fetchFail(429, { code: 'rate_limited' }));
      fetchStub.onCall(1).resolves(fetchOk({ id: 'new-project-uuid' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const promise = transport.createProject(WORKSPACE_ID, { name: 'US - EN' });
      await clock.tickAsync(60_000);
      const result = await promise;

      expect(result.id).to.equal('new-project-uuid');
      expect(fetchStub.callCount).to.equal(2);
    }));

    it('honours Retry-After (delta-seconds) as a floor on the backoff wait', withFakeTimers(async (clock) => {
      fetchStub.onCall(0).resolves(new Response(JSON.stringify({ code: 'rate_limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
      }));
      fetchStub.onCall(1).resolves(fetchOk({ status: 'created' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const promise = transport.getWorkspaceStatus(WORKSPACE_ID);

      // Retry-After: 1 is a 1s FLOOR on the wait. Advancing to just under it
      // must not dispatch the retry yet -- proving the header is what's gating
      // the delay, not backoff jitter alone (which defaults to ~100-200ms and
      // would otherwise let this pass for the wrong reason).
      await clock.tickAsync(900);
      expect(fetchStub.callCount).to.equal(1);

      await clock.tickAsync(200);
      const result = await promise;

      expect(result.status).to.equal('created');
      expect(fetchStub.callCount).to.equal(2);
    }));

    it('returns the last retryable response after exhausting all retries (does not swallow into an exception)', withFakeTimers(async (clock) => {
      fetchStub.resolves(fetchFail(503, { code: 'still_unavailable' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const promise = transport.getWorkspaceStatus(WORKSPACE_ID).catch((e) => e);
      await clock.tickAsync(60_000);
      const err = await promise;

      // Default maxRetries: 2 -> 3 attempts total.
      expect(fetchStub.callCount).to.equal(3);
      expect(err).to.be.instanceOf(SerenityTransportError);
      expect(err.status).to.equal(503);
    }));

    it('exhausts all retries on a POST create under sustained 429 (createProject)', withFakeTimers(async (clock) => {
      // The other exhaustion test above only covers GET+503. POST retries via a
      // different branch of the idempotency gate (429-only, never 5xx), so
      // exhaustion needs its own coverage in case that branch's retry-count/
      // last-response behavior ever drifts from the idempotent-method path.
      fetchStub.resolves(fetchFail(429, { code: 'rate_limited' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const promise = transport.createProject(WORKSPACE_ID, { name: 'US - EN' }).catch((e) => e);
      await clock.tickAsync(60_000);
      const err = await promise;

      expect(fetchStub.callCount).to.equal(3);
      expect(err).to.be.instanceOf(ProjectEngineApiError);
      expect(err.status).to.equal(429);
    }));

    it('rethrows the last network error after exhausting all retries on an idempotent method', withFakeTimers(async (clock) => {
      const netErr = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
      fetchStub.rejects(netErr);
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const promise = transport.getWorkspaceStatus(WORKSPACE_ID).catch((e) => e);
      await clock.tickAsync(60_000);
      const err = await promise;

      expect(fetchStub.callCount).to.equal(3);
      expect(err.message).to.equal('ECONNRESET');
    }));

    it('gives each retry attempt its OWN fresh per-attempt timeout (not one budget for the whole retry loop)', withFakeTimers(async (clock) => {
      // Simulate: attempt 1 times out (never resolves until aborted), attempt 2
      // succeeds immediately. If the timeout were shared across the whole retry
      // loop (a single 15s AbortController for every attempt, rather than a new
      // one per attempt), the clock advance below -- 15s for attempt 1's abort,
      // then a further tick for backoff -- would either abort the already-
      // succeeded second attempt or never let it run at all. Getting a clean
      // 200 after exactly 2 calls proves attempt 2 got its own untouched budget.
      let call = 0;
      fetchStub.callsFake((_input, init) => {
        call += 1;
        if (call === 1) {
          return new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              const e = new Error('aborted');
              e.name = 'AbortError';
              reject(e);
            });
          });
        }
        return Promise.resolve(fetchOk({ status: 'created' }));
      });
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const promise = transport.getWorkspaceStatus(WORKSPACE_ID);
      await clock.tickAsync(60_000);
      const result = await promise;

      expect(result.status).to.equal('created');
      expect(fetchStub.callCount).to.equal(2);
    }));

    it('does NOT retry a per-attempt timeout on a non-idempotent method (POST)', withFakeTimers(async (clock) => {
      fetchStub.callsFake((_input, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const promise = transport.publishProject(WORKSPACE_ID, PROJECT_ID).catch((e) => e);
      await clock.tickAsync(20_000); // past the 15s per-attempt timeout, once
      const err = await promise;

      // PE path: the 504 SerenityTransportError is carried as the facade error's `.cause`.
      expect(err).to.be.instanceOf(ProjectEngineApiError);
      expect(err.status).to.equal(undefined);
      expect(err.cause).to.be.instanceOf(SerenityTransportError);
      expect(err.cause.status).to.equal(504);
      expect(fetchStub.callCount).to.equal(1);
    }));

    it('does not retry a non-retryable 4xx (e.g. 404) regardless of method', withFakeTimers(async (clock) => {
      fetchStub.resolves(fetchFail(404, { message: 'not found' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const promise = transport.getWorkspaceStatus(WORKSPACE_ID).catch((e) => e);
      await clock.tickAsync(60_000);
      const err = await promise;

      expect(err.status).to.equal(404);
      expect(fetchStub.callCount).to.equal(1);
    }));
  });

  describe('non-2xx upstream', () => {
    it('throws ProjectEngineApiError carrying status and parsed body (PE call)', async () => {
      fetchStub.resolves(fetchFail(502, { code: 'gateway_timeout' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      try {
        await transport.publishProject(WORKSPACE_ID, PROJECT_ID);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(ProjectEngineApiError);
        expect(err.status).to.equal(502);
        expect(err.body).to.deep.equal({ code: 'gateway_timeout' });
      }
    });

    it('falls back to raw text when upstream body is not JSON', async () => {
      fetchStub.resolves(new Response('plain text error', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      try {
        await transport.publishProject(WORKSPACE_ID, PROJECT_ID);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.body).to.equal('plain text error');
      }
    });

    it('returns null for an empty 2xx response body', async () => {
      fetchStub.resolves(new Response(null, { status: 204 }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.publishProject(WORKSPACE_ID, PROJECT_ID);
      expect(result).to.equal(null);
    });

    it('carries a null body when a non-2xx response has no parseable body', async () => {
      fetchStub.resolves(new Response(null, { status: 500 }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      try {
        await transport.publishProject(WORKSPACE_ID, PROJECT_ID);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(ProjectEngineApiError);
        expect(err.status).to.equal(500);
        expect(err.body).to.equal(null);
      }
    });
  });

  describe('listPromptsByTags', () => {
    it('POSTs to /v2/.../aio/prompts/by_tags with the body shape', async () => {
      fetchStub.resolves(fetchOk({ items: [], page: 1, total: 0 }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.listPromptsByTags(WORKSPACE_ID, PROJECT_ID, {
        page: 2,
        limit: 50,
        search: 'photoshop',
      });

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('POST');
      expect(call.url).to.include(
        `/enterprise/projects/api/v2/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/aio/prompts/by_tags`,
      );
      expect(JSON.parse(call.body)).to.deep.include({
        tag_ids: [],
        page: 2,
        limit: 50,
        search: 'photoshop',
      });
    });

    it('defaults page/limit and empty tag_ids when omitted', async () => {
      fetchStub.resolves(fetchOk({ items: [] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.listPromptsByTags(WORKSPACE_ID, PROJECT_ID, {});

      const call = await callOf(fetchStub);
      const body = JSON.parse(call.body);
      expect(body.tag_ids).to.deep.equal([]);
      expect(body.page).to.equal(1);
      expect(body.limit).to.equal(200);
    });

    it('does not forward sort_field / sort_dir — Semrush rejects them on this endpoint', async () => {
      fetchStub.resolves(fetchOk({ items: [] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.listPromptsByTags(WORKSPACE_ID, PROJECT_ID, {
        sort_field: 'created_at',
        sort_dir: 'desc',
        search: 'photoshop',
      });

      const call = await callOf(fetchStub);
      const body = JSON.parse(call.body);
      expect(body).to.not.have.property('sort_field');
      expect(body).to.not.have.property('sort_dir');
      expect(body.search).to.equal('photoshop');
    });
  });

  describe('createPromptsByIds', () => {
    it('POSTs to /v2/.../aio/prompts with { items, tag_ids } and returns the list wrapper', async () => {
      fetchStub.resolves(fetchOk({
        page: 1, total: 1, items: [{ id: 'new-prompt', name: 'What is Acrobat?' }], existing_count: 0,
      }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.createPromptsByIds(WORKSPACE_ID, PROJECT_ID, ['What is Acrobat?'], ['tag-cat-1', 'tag-child-1']);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('POST');
      expect(call.url).to.match(/\/aio\/prompts$/);
      expect(JSON.parse(call.body)).to.deep.equal({
        items: ['What is Acrobat?'], tag_ids: ['tag-cat-1', 'tag-child-1'],
      });
      expect(result.items).to.deep.equal([{ id: 'new-prompt', name: 'What is Acrobat?' }]);
    });

    it('surfaces an upstream 500 (unresolvable tag id) as a ProjectEngineApiError', async () => {
      fetchStub.resolves(fetchFail(500, { message: 'unknown tag id: bogus' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await expect(transport.createPromptsByIds(WORKSPACE_ID, PROJECT_ID, ['x'], ['bogus']))
        .to.be.rejected.then((err) => {
          expect(err).to.be.instanceOf(ProjectEngineApiError);
          expect(err.status).to.equal(500);
        });
    });
  });

  describe('deletePromptsByIds', () => {
    it('DELETEs /v2/.../aio/prompts with body { ids }', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.deletePromptsByIds(WORKSPACE_ID, PROJECT_ID, ['p1', 'p2']);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('DELETE');
      expect(call.url).to.match(/\/aio\/prompts$/);
      expect(JSON.parse(call.body)).to.deep.equal({ ids: ['p1', 'p2'] });
    });
  });

  describe('renamePrompt', () => {
    it('POSTs /v2/.../aio/prompts/{prompt_id}/rename with { new_name } and returns the id-stable result', async () => {
      fetchStub.resolves(fetchOk({ id: 'p1', name: 'Next text', is_updated: true }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.renamePrompt(WORKSPACE_ID, PROJECT_ID, 'p1', 'Next text');

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('POST');
      expect(call.url).to.match(/\/aio\/prompts\/p1\/rename$/);
      expect(JSON.parse(call.body)).to.deep.equal({ new_name: 'Next text' });
      expect(result).to.deep.equal({ id: 'p1', name: 'Next text', is_updated: true });
    });

    it('surfaces the upstream 409 (text collision) as a ProjectEngineApiError(409)', async () => {
      fetchStub.resolves(fetchFail(409, { message: 'conflict' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await expect(transport.renamePrompt(WORKSPACE_ID, PROJECT_ID, 'p1', 'A sibling\'s text'))
        .to.be.rejected.then((err) => {
          expect(err).to.be.instanceOf(ProjectEngineApiError);
          expect(err.status).to.equal(409);
        });
    });
  });

  describe('updatePromptTagsByIds', () => {
    it('PUTs /v2/.../aio/prompts/tags with { items } (id + references + replace)', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.updatePromptTagsByIds(WORKSPACE_ID, PROJECT_ID, [
        { id: 'p1', references: ['tag-1', 'tag-2'], replace: true },
      ]);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('PUT');
      expect(call.url).to.match(/\/aio\/prompts\/tags$/);
      expect(JSON.parse(call.body)).to.deep.equal({
        items: [{ id: 'p1', references: ['tag-1', 'tag-2'], replace: true }],
      });
    });
  });

  describe('brand URLs', () => {
    const BENCHMARK_ID = 'bench-9';

    it('listBenchmarks GETs /v1/.../ai_models/benchmarks', async () => {
      fetchStub.resolves(fetchOk({ aio_benchmarks: [{ id: BENCHMARK_ID, main_brand: true }] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.listBenchmarks(WORKSPACE_ID, PROJECT_ID);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('GET');
      expect(call.url).to.match(/\/projects\/proj-xyz\/ai_models\/benchmarks$/);
      expect(call.body).to.equal(undefined);
    });

    it('listBrandUrls GETs /v2/.../benchmarks/{bid}/brand_urls (published view by default)', async () => {
      fetchStub.resolves(fetchOk({ brand_urls: [] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.listBrandUrls(WORKSPACE_ID, PROJECT_ID, BENCHMARK_ID);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('GET');
      // No `draft` query → the default (published) view.
      expect(call.url).to.match(/\/aio\/benchmarks\/bench-9\/brand_urls$/);
    });

    it('listBrandUrls sends ?draft=true when the draft view is requested', async () => {
      fetchStub.resolves(fetchOk({ brand_urls: [] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.listBrandUrls(WORKSPACE_ID, PROJECT_ID, BENCHMARK_ID, { draft: true });

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('GET');
      expect(call.url).to.match(/\/aio\/benchmarks\/bench-9\/brand_urls\?draft=true$/);
    });

    it('createBrandUrls POSTs the entries array as the body', async () => {
      fetchStub.resolves(fetchOk({ ids: ['u1'], existing_count: 0 }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const entries = [{ url: 'https://acme.com', type: 'website' }];
      await transport.createBrandUrls(WORKSPACE_ID, PROJECT_ID, BENCHMARK_ID, entries);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('POST');
      expect(call.url).to.match(/\/aio\/benchmarks\/bench-9\/brand_urls$/);
      expect(JSON.parse(call.body)).to.deep.equal(entries);
    });

    it('deleteBrandUrls DELETEs with body { ids }', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.deleteBrandUrls(WORKSPACE_ID, PROJECT_ID, BENCHMARK_ID, ['u1', 'u2']);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('DELETE');
      expect(call.url).to.match(/\/aio\/benchmarks\/bench-9\/brand_urls$/);
      expect(JSON.parse(call.body)).to.deep.equal({ ids: ['u1', 'u2'] });
    });

    it('createBenchmarks POSTs the benchmarks array to /v2/.../ai_models/benchmarks', async () => {
      fetchStub.resolves(fetchOk({ ids: ['b1'], existing_count: 0 }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const benchmarks = [{ brand_name: 'Acme', domain: 'acme.com' }];
      await transport.createBenchmarks(WORKSPACE_ID, PROJECT_ID, benchmarks);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('POST');
      expect(call.url).to.match(/\/v2\/workspaces\/.*\/projects\/proj-xyz\/ai_models\/benchmarks$/);
      expect(JSON.parse(call.body)).to.deep.equal(benchmarks);
    });

    it('deleteBenchmarks DELETEs /v1/.../ai_models/benchmarks with body { ids }', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.deleteBenchmarks(WORKSPACE_ID, PROJECT_ID, ['b1', 'b2']);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('DELETE');
      expect(call.url).to.match(/\/v1\/workspaces\/.*\/projects\/proj-xyz\/ai_models\/benchmarks$/);
      expect(JSON.parse(call.body)).to.deep.equal({ ids: ['b1', 'b2'] });
    });

    it('updateBenchmark PUTs /v1/.../ai_models/benchmarks/{bid} with the benchmark body', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const body = { brand_name: 'Acme', domain: 'acme.com', brand_aliases: ['ACME Inc'] };
      await transport.updateBenchmark(WORKSPACE_ID, PROJECT_ID, 'bench-7', body);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('PUT');
      expect(call.url).to.match(
        /\/v1\/workspaces\/.*\/projects\/proj-xyz\/ai_models\/benchmarks\/bench-7$/,
      );
      expect(JSON.parse(call.body)).to.deep.equal(body);
    });
  });

  describe('updateProject (brand_names alias sync)', () => {
    it('PATCHes /v1/workspaces/{ws}/projects/{pid} with the update body', async () => {
      fetchStub.resolves(fetchOk({ id: PROJECT_ID }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const body = { brand_name_display: 'Acme', brand_names: ['Acme', 'ACME Inc'] };
      await transport.updateProject(WORKSPACE_ID, PROJECT_ID, body);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('PATCH');
      expect(call.url).to.match(
        new RegExp(`/v1/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}$`),
      );
      expect(JSON.parse(call.body)).to.deep.equal(body);
    });
  });

  describe('CI competitors', () => {
    it('getProject GETs the project with required draft + type=ai query', async () => {
      fetchStub.resolves(fetchOk({ id: PROJECT_ID, settings: { ci: { competitors: [] } } }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.getProject(WORKSPACE_ID, PROJECT_ID);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('GET');
      expect(call.url).to.include(`/v1/workspaces/${WORKSPACE_ID}/projects/proj-xyz?`);
      expect(call.url).to.include('draft=true');
      expect(call.url).to.include('type=ai');
    });

    it('getProject honors an explicit draft=false', async () => {
      fetchStub.resolves(fetchOk({ id: PROJECT_ID }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.getProject(WORKSPACE_ID, PROJECT_ID, { draft: false });

      const call = await callOf(fetchStub);
      expect(call.url).to.include('draft=false');
    });

    it('updateCiCompetitors PUTs ci/competitors with { ci_competitors }', async () => {
      fetchStub.resolves(fetchOk({ ci_competitors: [] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const list = [{ domain: 'a.com', color: '#111' }, { domain: 'b.com' }];
      await transport.updateCiCompetitors(WORKSPACE_ID, PROJECT_ID, list);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('PUT');
      expect(call.url).to.match(/\/projects\/proj-xyz\/ci\/competitors$/);
      expect(JSON.parse(call.body)).to.deep.equal({ ci_competitors: list });
    });
  });

  describe('publishProject', () => {
    it('POSTs to /v1/workspaces/{ws}/projects/{pid}/publish with no body', async () => {
      fetchStub.resolves(fetchOk({ status: 'accepted' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.publishProject(WORKSPACE_ID, PROJECT_ID);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('POST');
      expect(call.url).to.match(
        new RegExp(`/v1/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/publish$`),
      );
      expect(call.body).to.equal(undefined);
    });
  });

  describe('listAiModels', () => {
    it('GETs /v1/.../ai_models with page=1&limit=100 by default', async () => {
      fetchStub.resolves(fetchOk({ items: [] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.listAiModels(WORKSPACE_ID, PROJECT_ID);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('GET');
      expect(call.url).to.include(`/v1/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/ai_models?`);
      expect(call.url).to.include('page=1');
      expect(call.url).to.include('limit=100');
    });

    it('honours explicit page/limit for pagination', async () => {
      fetchStub.resolves(fetchOk({ items: [] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.listAiModels(WORKSPACE_ID, PROJECT_ID, { page: 3, limit: 25 });

      const call = await callOf(fetchStub);
      expect(call.url).to.include('page=3');
      expect(call.url).to.include('limit=25');
    });
  });

  describe('createProject (new in this PR)', () => {
    it('POSTs to /v1/workspaces/{ws}/projects with the full ProjectRequest body', async () => {
      fetchStub.resolves(fetchOk({ id: 'new-project-uuid' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const body = {
        name: 'adobe.com · US · en',
        type: 'ai',
        brand_name_display: 'Adobe',
        brand_names: ['Adobe', 'Adobe Inc.'],
        domain: 'adobe.com',
        country_code: 'us',
        location_id: 2840,
        location_name: 'United States',
        language_id: 'lang-uuid-en',
      };
      await transport.createProject(WORKSPACE_ID, body);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('POST');
      expect(call.url).to.match(new RegExp(`/v1/workspaces/${WORKSPACE_ID}/projects$`));
      expect(JSON.parse(call.body)).to.deep.equal(body);
    });
  });

  describe('listLanguages (new in this PR)', () => {
    it('GETs /v1/languages', async () => {
      fetchStub.resolves(fetchOk({ items: [{ id: 'lang-en', name: 'English' }] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.listLanguages();

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('GET');
      expect(call.url).to.match(/\/v1\/languages$/);
      expect(result.items[0].name).to.equal('English');
    });
  });

  describe('deleteProject', () => {
    it('DELETEs /v1/workspaces/{ws}/projects/{pid} with no body', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.deleteProject(WORKSPACE_ID, PROJECT_ID);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('DELETE');
      expect(call.url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/projects/api/v1/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}`,
      );
      expect(call.body).to.equal(undefined);
    });

    it('throws ProjectEngineApiError(404) on upstream not-found so callers can treat it as idempotent', async () => {
      fetchStub.resolves(fetchFail(404, { message: 'not found' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const promise = transport.deleteProject(WORKSPACE_ID, PROJECT_ID);
      await expect(promise).to.be.rejectedWith(ProjectEngineApiError);
      try {
        await promise;
      } catch (e) {
        expect(e.status).to.equal(404);
        expect(e.body).to.deep.equal({ message: 'not found' });
      }
    });
  });

  describe('addAiModel (new in this PR)', () => {
    it('POSTs model_id to /v2/.../ai_models and returns the assignment row', async () => {
      fetchStub.resolves(fetchOk({ id: 'new-assignment-uuid' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.addAiModel(WORKSPACE_ID, PROJECT_ID, 'cat-gpt-4o');

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('POST');
      // V2: identical schema to v1, drop-in (createBenchmarks precedent). The
      // sibling list/delete ai_models routes have no v2 variant and stay on v1.
      expect(call.url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/projects/api/v2/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/ai_models`,
      );
      expect(JSON.parse(call.body)).to.deep.equal({ model_id: 'cat-gpt-4o' });
      expect(result.id).to.equal('new-assignment-uuid');
    });
  });

  describe('deleteAiModelsByIds (new in this PR)', () => {
    it('DELETEs an ids array from /v1/.../ai_models', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.deleteAiModelsByIds(WORKSPACE_ID, PROJECT_ID, ['assign-1', 'assign-2']);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('DELETE');
      expect(call.url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/projects/api/v1/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/ai_models`,
      );
      expect(JSON.parse(call.body)).to.deep.equal({ ids: ['assign-1', 'assign-2'] });
    });
  });

  describe('listGlobalAiModels', () => {
    it('GETs /v1/ai_models (global catalog, no workspace prefix) with default pagination', async () => {
      fetchStub.resolves(fetchOk({ page: 1, total: 1, items: [{ id: 'cat-gpt', key: 'chatgpt' }] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.listGlobalAiModels();

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('GET');
      expect(call.url).to.equal(
        'https://adobe-hackathon.semrush.com/enterprise/projects/api/v1/ai_models?page=1&limit=100',
      );
      expect(result.items[0].id).to.equal('cat-gpt');
    });
  });

  describe('createProjectTags', () => {
    it('POSTs { names } to /v2/workspaces/{ws}/projects/{pid}/aio/tags', async () => {
      fetchStub.resolves(fetchOk({ id: 'tag-1', name: 'source:ai' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const names = ['source:ai', 'type:branded'];
      await transport.createProjectTags(WORKSPACE_ID, PROJECT_ID, names);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('POST');
      expect(call.url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/projects/api/v2/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/aio/tags`,
      );
      expect(JSON.parse(call.body)).to.deep.equal({ names });
    });

    it('includes parent_id in the body when nesting under a parent', async () => {
      fetchStub.resolves(fetchOk([{ id: 'child-1', name: 'category:Sneakers', parent_id: 'parent-1' }]));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.createProjectTags(WORKSPACE_ID, PROJECT_ID, ['category:Sneakers'], { parentId: 'parent-1' });

      const call = await callOf(fetchStub);
      expect(JSON.parse(call.body)).to.deep.equal({ names: ['category:Sneakers'], parent_id: 'parent-1' });
    });

    it('omits parent_id for an empty parentId (flat create)', async () => {
      fetchStub.resolves(fetchOk([{ id: 'tag-1', name: 'category:Flat' }]));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.createProjectTags(WORKSPACE_ID, PROJECT_ID, ['category:Flat'], { parentId: '' });

      const call = await callOf(fetchStub);
      expect(JSON.parse(call.body)).to.deep.equal({ names: ['category:Flat'] });
    });
  });

  describe('listProjectTags', () => {
    it('GETs /v2/workspaces/{ws}/projects/{pid}/aio/tags with parent_id + search', async () => {
      fetchStub.resolves(fetchOk({ items: [{ id: 't-1', name: 'category:Running Shoes' }], page: 1, total: 1 }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.listProjectTags(WORKSPACE_ID, PROJECT_ID);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('GET');
      expect(call.url).to.contain(
        `/v2/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/aio/tags`,
      );
      expect(call.url).to.contain('parent_id=');
      expect(call.url).to.contain('search=');
      expect(call.url).to.not.contain('draft=');
      expect(result.items).to.deep.equal([{ id: 't-1', name: 'category:Running Shoes' }]);
    });

    it('drills a parent level and reads the draft view when requested', async () => {
      fetchStub.resolves(fetchOk({ items: [], page: 1, total: 0 }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.listProjectTags(WORKSPACE_ID, PROJECT_ID, { parentId: 'parent-1', draft: true });

      const call = await callOf(fetchStub);
      expect(call.url).to.contain('parent_id=parent-1');
      expect(call.url).to.contain('draft=true');
    });
  });

  describe('updateProjectTag', () => {
    it('PATCHes /aio/tags/{tag_id} with { name, parent_id } and returns the updated tag', async () => {
      fetchStub.resolves(fetchOk({ id: 'tag-1', name: 'category:Renamed', parent_id: 'parent-1' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.updateProjectTag(WORKSPACE_ID, PROJECT_ID, 'tag-1', {
        name: 'category:Renamed', parentId: 'parent-1',
      });

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('PATCH');
      expect(call.url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/projects/api/v2/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/aio/tags/tag-1`,
      );
      expect(JSON.parse(call.body)).to.deep.equal({ name: 'category:Renamed', parent_id: 'parent-1' });
      expect(result).to.deep.equal({ id: 'tag-1', name: 'category:Renamed', parent_id: 'parent-1' });
    });

    it('re-sends the current parent_id when only renaming (omitting it would promote)', async () => {
      fetchStub.resolves(fetchOk({ id: 'tag-1', name: 'Renamed', parent_id: 'root-1' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.updateProjectTag(WORKSPACE_ID, PROJECT_ID, 'tag-1', {
        name: 'Renamed', parentId: 'root-1',
      });

      const call = await callOf(fetchStub);
      expect(JSON.parse(call.body)).to.deep.equal({ name: 'Renamed', parent_id: 'root-1' });
    });

    it('sends a literal null parent_id to promote a child to root (gate 1)', async () => {
      fetchStub.resolves(fetchOk({ id: 'tag-1', name: 'Sneakers', parent_id: null }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.updateProjectTag(WORKSPACE_ID, PROJECT_ID, 'tag-1', {
        name: 'Sneakers', parentId: null,
      });

      const call = await callOf(fetchStub);
      expect(JSON.parse(call.body)).to.deep.equal({ name: 'Sneakers', parent_id: null });
    });

    // Upstream has no "leave the parent alone" body: a PATCH without `parent_id`
    // PROMOTES the tag to a root (verified live). Refuse to build such a body.
    it('throws rather than omitting parent_id (omission promotes the tag to a root)', async () => {
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      for (const parentId of [undefined, '']) {
        // eslint-disable-next-line no-await-in-loop
        await expect(transport.updateProjectTag(WORKSPACE_ID, PROJECT_ID, 'tag-1', {
          name: 'Renamed', parentId,
        })).to.be.rejectedWith(TypeError, /parentId is required/);
      }
      expect(fetchStub.called).to.equal(false);
    });

    it('surfaces an upstream 404 as a ProjectEngineApiError', async () => {
      fetchStub.resolves(fetchFail(404, { message: 'not found' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await expect(transport.updateProjectTag(WORKSPACE_ID, PROJECT_ID, 'ghost', { name: 'X', parentId: 'root-1' }))
        .to.be.rejected.then((err) => {
          expect(err).to.be.instanceOf(ProjectEngineApiError);
          expect(err.status).to.equal(404);
          expect(err.body).to.deep.equal({ message: 'not found' });
        });
    });
  });

  describe('getBrandTopics', () => {
    it('GETs /v1/workspaces/{ws}/brand-topics with domain + country query', async () => {
      fetchStub.resolves(fetchOk([
        { topic: 'Running', volume: 900, prompts: ['best running shoes'] },
      ]));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.getBrandTopics(WORKSPACE_ID, { domain: 'example.com', country: 'US' });

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('GET');
      expect(call.url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/projects/api/v1/workspaces/${WORKSPACE_ID}/brand-topics?domain=example.com&country=US`,
      );
      expect(result[0].topic).to.equal('Running');
    });
  });

  // ── Sub-workspace lifecycle (serenity dual-mode, subworkspace path) ──────────────
  describe('createSubworkspace', () => {
    it('POSTs { title, resources } to /v2/workspaces/{parent}/child (no X-Upload-Receipt)', async () => {
      fetchStub.resolves(fetchOk({ id: 'subworkspace-ws-1', status: 'not ready' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const resources = { ai: { projects: 3, prompts: 1500 } };
      const result = await transport.createSubworkspace(PARENT_WS, 'Adobe Express', resources);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('POST');
      expect(call.url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/users/api/v2/workspaces/${PARENT_WS}/child`,
      );
      expect(JSON.parse(call.body)).to.deep.equal({ title: 'Adobe Express', resources });
      expect(call.header('X-Upload-Receipt')).to.equal(null);
      expect(result.id).to.equal('subworkspace-ws-1');
    });
  });

  describe('getWorkspaceStatus', () => {
    it('GETs /v1/workspaces/{ws}/status', async () => {
      fetchStub.resolves(fetchOk({ status: 'created' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.getWorkspaceStatus(WORKSPACE_ID);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('GET');
      expect(call.url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/users/api/v1/workspaces/${WORKSPACE_ID}/status`,
      );
      expect(result.status).to.equal('created');
    });
  });

  describe('getWorkspaceResources', () => {
    it('GETs /v1/workspaces/{ws}/resources', async () => {
      fetchStub.resolves(fetchOk({
        product_resources: { ai: { resources: { projects: { used: 0, drafted: 0, total: 13 } } } },
      }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.getWorkspaceResources(WORKSPACE_ID);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('GET');
      expect(call.url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/users/api/v1/workspaces/${WORKSPACE_ID}/resources`,
      );
      expect(result.product_resources.ai.resources.projects.total).to.equal(13);
    });
  });

  describe('listWorkspaceFamily', () => {
    it('GETs /v1/workspaces/{parent}/family', async () => {
      fetchStub.resolves(fetchOk({ items: [{ id: 'subworkspace-ws-1', title: 'Adobe Express' }] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.listWorkspaceFamily(PARENT_WS);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('GET');
      expect(call.url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/users/api/v1/workspaces/${PARENT_WS}/family`,
      );
      expect(result.items[0].id).to.equal('subworkspace-ws-1');
    });
  });

  describe('transferWorkspaceResources', () => {
    it('POSTs the payload wrapped under `resources` to /v2/workspaces/{ws}/resources/transfer', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const payload = { ai: { projects: 3, prompts: 1500 } };
      await transport.transferWorkspaceResources(WORKSPACE_ID, payload);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('POST');
      // V2: same aiProductResources `ai` shape proven live via createSubworkspace,
      // wrapped under `resources` (WorkspaceResourcesTransferV2Form).
      expect(call.url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/users/api/v2/workspaces/${WORKSPACE_ID}/resources/transfer`,
      );
      expect(JSON.parse(call.body)).to.deep.equal({ resources: payload });
    });
  });

  describe('deleteWorkspace (test-cleanup only)', () => {
    const DELETE_ENV = { ...TEST_ENV, SERENITY_ALLOW_WORKSPACE_DELETE: 'true' };

    it('DELETEs /v1/workspaces/{ws} with no body when explicitly allowed', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: DELETE_ENV, imsToken: IMS });

      await transport.deleteWorkspace(WORKSPACE_ID);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('DELETE');
      expect(call.url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/users/api/v1/workspaces/${WORKSPACE_ID}`,
      );
      expect(call.body).to.equal(undefined);
    });

    it('is fail-closed: throws and never calls fetch when the flag is absent', async () => {
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await expect(transport.deleteWorkspace(WORKSPACE_ID)).to.be.rejectedWith(
        /workspace deletion is disabled/i,
      );
      expect(fetchStub.called).to.equal(false);
    });

    it('is fail-closed: rejects a non-"true" flag value', async () => {
      const transport = createSerenityTransport({
        env: { ...TEST_ENV, SERENITY_ALLOW_WORKSPACE_DELETE: '1' },
        imsToken: IMS,
      });

      await expect(transport.deleteWorkspace(WORKSPACE_ID)).to.be.rejectedWith(
        /workspace deletion is disabled/i,
      );
      expect(fetchStub.called).to.equal(false);
    });
  });

  describe('listProjects', () => {
    it('GETs the v1 default-view project list for a workspace', async () => {
      fetchStub.resolves(fetchOk({ items: [{ id: PROJECT_ID, publish_status: 'live' }] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.listProjects(WORKSPACE_ID);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('GET');
      expect(call.url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/projects/api/v1/workspaces/${WORKSPACE_ID}/projects?type=ai`,
      );
      expect(result.items[0].id).to.equal(PROJECT_ID);
    });
  });

  describe('getInitStatus', () => {
    it('GETs /v2/workspaces/{ws}/projects/{pid}/aio/init_status', async () => {
      fetchStub.resolves(fetchOk({ initialized: false }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.getInitStatus(WORKSPACE_ID, PROJECT_ID);

      const call = await callOf(fetchStub);
      expect(call.method).to.equal('GET');
      // v2 (not v1): project-engine-client 1.2.0 moved init_status to /v2 and
      // dropped the /v1 route.
      expect(call.url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/projects/api/v2/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/aio/init_status`,
      );
      expect(result.initialized).to.equal(false);
    });
  });
  // The user-manager methods now route through the typed User Manager client, so
  // their auth/timeout/error paths share the same plumbing as the project methods;
  // they are exercised here via getWorkspaceStatus for completeness.
  describe('user-manager gateway error paths', () => {
    it('throws SerenityTransportError(401) when imsToken is missing', async () => {
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: '' });
      await expect(transport.getWorkspaceStatus(WORKSPACE_ID))
        .to.be.rejectedWith(/Missing IMS bearer token/);
      expect(fetchStub.called).to.equal(false);
    });

    it('throws SerenityTransportError carrying upstream status + parsed body on non-2xx (after exhausting GET retries)', async () => {
      // getWorkspaceStatus is a GET (idempotent) — a persistent 503 is now
      // retried (default maxRetries: 2 -> 3 attempts total) before the last
      // response is surfaced. Fake timers keep the jittered backoff sleeps from
      // costing real wall-clock time in the test run.
      fetchStub.resolves(fetchFail(503, { code: 'unavailable' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });
      const clock = sinon.useFakeTimers({ now: 1_700_000_000_000, toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const promise = transport.getWorkspaceStatus(WORKSPACE_ID).catch((e) => e);
        await clock.tickAsync(60_000);
        const err = await promise;
        expect(err).to.be.instanceOf(SerenityTransportError);
        expect(err.status).to.equal(503);
        expect(err.body).to.deep.equal({ code: 'unavailable' });
        expect(fetchStub.callCount).to.equal(3);
      } finally {
        clock.restore();
      }
    });

    it('falls back to raw text when the upstream body is not JSON (after exhausting GET retries)', async () => {
      fetchStub.resolves(new Response('gateway exploded', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });
      const clock = sinon.useFakeTimers({ now: 1_700_000_000_000, toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const promise = transport.getWorkspaceStatus(WORKSPACE_ID).catch((e) => e);
        await clock.tickAsync(60_000);
        const err = await promise;
        expect(err.body).to.equal('gateway exploded');
        expect(fetchStub.callCount).to.equal(3);
      } finally {
        clock.restore();
      }
    });

    it('retries a network error on GET, then rethrows it verbatim once retries are exhausted', async () => {
      const netErr = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      fetchStub.rejects(netErr);
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });
      const clock = sinon.useFakeTimers({ now: 1_700_000_000_000, toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const promise = transport.getWorkspaceStatus(WORKSPACE_ID).catch((e) => e);
        await clock.tickAsync(60_000);
        const err = await promise;
        expect(err.message).to.equal('ENOTFOUND');
        expect(fetchStub.callCount).to.equal(3);
      } finally {
        clock.restore();
      }
    });

    it('aborts with SerenityTransportError(504) on timeout, retried on GET (idempotent) then exhausted', async () => {
      // getWorkspaceStatus is a GET (idempotent) — every attempt times out here,
      // so the retry layer treats each timeout as a network-error-equivalent
      // retryable failure, retries up to the default 3 attempts total, and
      // surfaces the last one as the 504 once exhausted. Needs a longer tick
      // than a single attempt's 15s ceiling: 3 attempts x 15s + 2 backoff waits.
      fetchStub.callsFake((_url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });
      const clock = sinon.useFakeTimers({ now: 1_700_000_000_000, toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const promise = transport.getWorkspaceStatus(WORKSPACE_ID);
        await clock.tickAsync(90_000);
        const err = await promise.catch((e) => e);
        expect(err).to.be.instanceOf(SerenityTransportError);
        expect(err.status).to.equal(504);
        expect(fetchStub.callCount).to.equal(3);
      } finally {
        clock.restore();
      }
    }).timeout(15000);
  });

  describe('defensive branch coverage', () => {
    describe('redactUpstreamMessage', () => {
      it('returns "Upstream authorization failed" for 401 SerenityTransportError', () => {
        const e = new SerenityTransportError(401, 'internal auth fail');
        expect(redactUpstreamMessage(e)).to.equal('Upstream authorization failed');
      });

      it('returns "Upstream authorization failed" for 403 SerenityTransportError', () => {
        const e = new SerenityTransportError(403, 'internal auth fail');
        expect(redactUpstreamMessage(e)).to.equal('Upstream authorization failed');
      });

      it('returns "Upstream request failed" for a non-auth SerenityTransportError (e.g. 500)', () => {
        const e = new SerenityTransportError(500, 'boom');
        expect(redactUpstreamMessage(e)).to.equal('Upstream request failed');
      });

      // LLMO-6386: a Project Engine failure now surfaces as ProjectEngineApiError, whose message
      // embeds the service name + method + status ("Project Engine POST request failed with status
      // 405"); it must be redacted to the same generic string, never echoed to the client.
      it('redacts a ProjectEngineApiError by status (401/403 → auth failed, else request failed)', () => {
        expect(redactUpstreamMessage(new ProjectEngineApiError(401, 'GET', null)))
          .to.equal('Upstream authorization failed');
        expect(redactUpstreamMessage(new ProjectEngineApiError(403, 'POST', null)))
          .to.equal('Upstream authorization failed');
        expect(redactUpstreamMessage(new ProjectEngineApiError(405, 'POST', '<html>405</html>')))
          .to.equal('Upstream request failed');
      });

      it('never leaks the raw "Project Engine ..." message of a ProjectEngineApiError', () => {
        const e = new ProjectEngineApiError(500, 'POST', { code: 'boom' });
        expect(redactUpstreamMessage(e)).to.equal('Upstream request failed');
        expect(redactUpstreamMessage(e)).to.not.match(/Project Engine/);
      });

      it('unwraps a status-undefined ProjectEngineApiError to its cause before redacting (auth 401)', () => {
        // Timeout/auth/network PE failure: redact by the wrapped cause's status, matching the
        // retired adaptPE boundary — a missing-token 401 cause still reads "authorization failed".
        const authCause = new SerenityTransportError(401, 'Missing IMS bearer token');
        expect(redactUpstreamMessage(new ProjectEngineApiError(undefined, 'POST', null, { cause: authCause })))
          .to.equal('Upstream authorization failed');
        const timeoutCause = new SerenityTransportError(504, 'timed out');
        expect(redactUpstreamMessage(new ProjectEngineApiError(undefined, 'GET', null, { cause: timeoutCause })))
          .to.equal('Upstream request failed');
      });

      it('returns e.message unchanged for a plain (non-transport) Error', () => {
        const e = new Error('safe app error message');
        expect(redactUpstreamMessage(e)).to.equal('safe app error message');
      });

      it('returns the raw network cause message for a status-undefined ProjectEngineApiError wrapping a plain Error', () => {
        // A raw network error carried as cause is not a Semrush transport type, so (as before the
        // adaptPE boundary was retired) its own message passes through.
        const netCause = new Error('fetch failed');
        expect(redactUpstreamMessage(new ProjectEngineApiError(undefined, 'GET', null, { cause: netCause })))
          .to.equal('fetch failed');
      });

      it('returns undefined when called with null (e?.message is undefined)', () => {
        expect(redactUpstreamMessage(null)).to.equal(undefined);
      });
    });

    describe('local unwrap error/data/null fallback (User Manager / brand-topics path)', () => {
      it('falls through to data then null when the non-2xx error body parses to JSON null', async () => {
        // This exercises the transport's LOCAL `unwrap` — used only by the User Manager (`users.*`)
        // and brand-topics (`projectsRaw`) paths, which still throw SerenityTransportError
        // (LLMO-6386 leaves them unchanged). createSubworkspace is a POST (not retried on 5xx), so
        // a single attempt reaches unwrap. openapi-fetch parses a JSON `null` error body to
        // `error === null` (nullish), so `error ?? data ?? null` evaluates the `data` operand (also
        // nullish here) and finally the `null` literal — exercising both right-hand operands of the
        // coalescing chain. (A `''` error body would short-circuit at `error` since '' is not
        // nullish, which is why the empty-body test does not reach these branches.)
        fetchStub.resolves(new Response('null', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }));
        const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

        try {
          await transport.createSubworkspace(PARENT_WS, 'Adobe Express', { ai: { projects: 1, prompts: 1 } });
          expect.fail('should have thrown');
        } catch (err) {
          expect(err).to.be.instanceOf(SerenityTransportError);
          expect(err.status).to.equal(500);
          // error(null) ?? data(undefined) ?? null → null; unwrap keeps null.
          expect(err.body).to.equal(null);
        }
      });
    });

    describe('createTimeoutFetch re-throws a non-abort error via the wrapped fetch', () => {
      it('propagates a non-AbortError rejection from the wrapped fetch as the facade error cause', async () => {
        // Drive the timeout-fetch catch with a rejection whose name is NOT 'AbortError' so the
        // `if` guard is false and `throw e` re-raises the original error verbatim (no 504 mapping).
        // On a PE call (publishProject) that raw error is not an HTTP response, so the facade
        // surfaces it as a status-undefined ProjectEngineApiError carrying it as `.cause`
        // (LLMO-6386); the original error is preserved unchanged there.
        const boom = Object.assign(new Error('EPIPE'), { name: 'TypeError', code: 'EPIPE' });
        fetchStub.rejects(boom);
        const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

        const err = await transport.publishProject(WORKSPACE_ID, PROJECT_ID).catch((e) => e);
        expect(err).to.be.instanceOf(ProjectEngineApiError);
        expect(err.status).to.equal(undefined);
        expect(err.cause).to.equal(boom);
        expect(err.cause.message).to.equal('EPIPE');
      });
    });

    describe('getBrandTopics with undefined domain and country', () => {
      it('falls back to empty string for undefined domain and country (String(?? "") branches)', async () => {
        // String(domain ?? '') and String(country ?? '') right-side branches.
        fetchStub.resolves(fetchOk([]));
        const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

        await transport.getBrandTopics(WORKSPACE_ID, { domain: undefined, country: undefined });

        const call = await callOf(fetchStub);
        expect(call.url).to.include('domain=');
        expect(call.url).to.include('country=');
        // Both params present but with empty values.
        const params = new URL(call.url).searchParams;
        expect(params.get('domain')).to.equal('');
        expect(params.get('country')).to.equal('');
      });
    });
  });
});
