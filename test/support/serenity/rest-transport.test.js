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

// Strict mode: rest-transport now requires SEMRUSH_PROJECTS_BASE_URL to be
// supplied via env (Vault-backed in dev/stage/prod). Tests inject a
// deterministic value so the URL-based assertions below stay stable.
const TEST_ENV = { SEMRUSH_PROJECTS_BASE_URL: 'https://adobe-hackathon.semrush.com' };

function fetchOk(body) {
  return {
    ok: true,
    status: 200,
    text: async () => (body == null ? '' : JSON.stringify(body)),
  };
}

function fetchFail(status, body) {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify(body ?? { code: 'upstream_error' }),
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
    it('throws SerenityTransportError(401) when imsToken is missing on a call', async () => {
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: '' });
      const promise = transport.publishProject(WORKSPACE_ID, PROJECT_ID);
      await expect(promise).to.be.rejectedWith(SerenityTransportError);
      await expect(promise).to.be.rejectedWith(/Missing IMS bearer token/);
    });

    it('sends Authorization: Bearer <ims> — no cookie, no Auth-Data-Jwt, no User-Agent', async () => {
      fetchStub.resolves(fetchOk({ id: PROJECT_ID }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.publishProject(WORKSPACE_ID, PROJECT_ID);

      const [, init] = fetchStub.firstCall.args;
      expect(init.headers).to.deep.equal({
        Authorization: `Bearer ${IMS}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      });
      expect(init.headers).to.not.have.property('Cookie');
      expect(init.headers).to.not.have.property('Auth-Data-Jwt');
      expect(init.headers).to.not.have.property('User-Agent');
    });

    it('uses the env-supplied base URL when constructing outbound URLs', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.publishProject(WORKSPACE_ID, PROJECT_ID);

      const [url] = fetchStub.firstCall.args;
      expect(url).to.match(/^https:\/\/adobe-hackathon\.semrush\.com\//);
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

      const [url] = fetchStub.firstCall.args;
      expect(url).to.match(/^https:\/\/override\.semrush\.com\/enterprise\//);
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

      const [url] = fetchStub.firstCall.args;
      expect(url).to.match(/^https:\/\/override\.semrush\.com\/enterprise\/projects\/api\/v1\//);
      expect(url).to.not.include('/some/path');
      expect(url).to.not.include('x=1');
      expect(url).to.not.include('#frag');
    });

    it('strips userinfo from the base URL so credentials never leak outbound', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({
        env: { SEMRUSH_PROJECTS_BASE_URL: 'https://user:pass@override.semrush.com/' },
        imsToken: IMS,
      });

      await transport.publishProject(WORKSPACE_ID, PROJECT_ID);

      const [url] = fetchStub.firstCall.args;
      expect(url).to.not.include('user:pass@');
      expect(url).to.match(/^https:\/\/override\.semrush\.com\//);
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

    it('encodes path segments so reserved chars stay inside the segment', async () => {
      fetchStub.resolves(fetchOk({ items: [] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.listAiModels('ws/with/slashes', 'pid?with#hash');

      const [url] = fetchStub.firstCall.args;
      // Slashes/question marks/hashes must be percent-encoded — never break
      // out of their segment.
      expect(url).to.include('ws%2Fwith%2Fslashes');
      expect(url).to.include('pid%3Fwith%23hash');
    });

    it('re-throws non-abort fetch errors verbatim (network error, not timeout)', async () => {
      const netErr = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
      fetchStub.rejects(netErr);
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });
      await expect(transport.publishProject(WORKSPACE_ID, PROJECT_ID))
        .to.be.rejectedWith(/ECONNRESET/);
    });

    it('aborts with SerenityTransportError(504) on fetch timeout', async () => {
      // fetch never resolves; the transport's AbortController should fire.
      fetchStub.callsFake((_url, init) => new Promise((resolve, reject) => {
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
        clock.tick(20_000); // safely past the 15s default timeout
        const err = await promise.catch((e) => e);
        expect(err).to.be.instanceOf(SerenityTransportError);
        expect(err.status).to.equal(504);
      } finally {
        clock.restore();
        global.setTimeout = realSetTimeout;
      }
    });
  });

  describe('non-2xx upstream', () => {
    it('throws SerenityTransportError carrying status and parsed body', async () => {
      fetchStub.resolves(fetchFail(502, { code: 'gateway_timeout' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      try {
        await transport.publishProject(WORKSPACE_ID, PROJECT_ID);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(SerenityTransportError);
        expect(err.status).to.equal(502);
        expect(err.body).to.deep.equal({ code: 'gateway_timeout' });
      }
    });

    it('falls back to raw text when upstream body is not JSON', async () => {
      fetchStub.resolves({
        ok: false,
        status: 500,
        text: async () => 'plain text error',
      });
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      try {
        await transport.publishProject(WORKSPACE_ID, PROJECT_ID);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.body).to.equal('plain text error');
      }
    });

    it('returns null for an empty 2xx response body', async () => {
      fetchStub.resolves({
        ok: true,
        status: 204,
        text: async () => '',
      });
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.publishProject(WORKSPACE_ID, PROJECT_ID);
      expect(result).to.equal(null);
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

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('POST');
      expect(url).to.include(
        `/enterprise/projects/api/v2/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/aio/prompts/by_tags`,
      );
      expect(JSON.parse(init.body)).to.deep.include({
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

      const body = JSON.parse(fetchStub.firstCall.args[1].body);
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

      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      expect(body).to.not.have.property('sort_field');
      expect(body).to.not.have.property('sort_dir');
      expect(body.search).to.equal('photoshop');
    });
  });

  describe('createTaggedPrompts', () => {
    it('POSTs to /v2/.../aio/prompts/tagged with grouped prompts', async () => {
      fetchStub.resolves(fetchOk({ ids: ['p1', 'p2'], existing_count: 0 }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const promptsByTag = { 'topic:acrobat': ['What is Acrobat?'] };
      await transport.createTaggedPrompts(WORKSPACE_ID, PROJECT_ID, promptsByTag);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('POST');
      expect(url).to.include('/aio/prompts/tagged');
      expect(JSON.parse(init.body)).to.deep.equal({ prompts: promptsByTag });
    });
  });

  describe('deletePromptsByIds', () => {
    it('DELETEs /v2/.../aio/prompts with body { ids }', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.deletePromptsByIds(WORKSPACE_ID, PROJECT_ID, ['p1', 'p2']);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('DELETE');
      expect(url).to.match(/\/aio\/prompts$/);
      expect(JSON.parse(init.body)).to.deep.equal({ ids: ['p1', 'p2'] });
    });
  });

  describe('brand URLs', () => {
    const BENCHMARK_ID = 'bench-9';

    it('listBenchmarks GETs /v1/.../ai_models/benchmarks', async () => {
      fetchStub.resolves(fetchOk({ aio_benchmarks: [{ id: BENCHMARK_ID, main_brand: true }] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.listBenchmarks(WORKSPACE_ID, PROJECT_ID);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('GET');
      expect(url).to.match(/\/projects\/proj-xyz\/ai_models\/benchmarks$/);
      expect(init.body).to.equal(undefined);
    });

    it('listBrandUrls GETs /v2/.../benchmarks/{bid}/brand_urls', async () => {
      fetchStub.resolves(fetchOk({ brand_urls: [] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.listBrandUrls(WORKSPACE_ID, PROJECT_ID, BENCHMARK_ID);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('GET');
      expect(url).to.match(/\/aio\/benchmarks\/bench-9\/brand_urls$/);
    });

    it('createBrandUrls POSTs the entries array as the body', async () => {
      fetchStub.resolves(fetchOk({ ids: ['u1'], existing_count: 0 }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const entries = [{ url: 'https://acme.com', type: 'website' }];
      await transport.createBrandUrls(WORKSPACE_ID, PROJECT_ID, BENCHMARK_ID, entries);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('POST');
      expect(url).to.match(/\/aio\/benchmarks\/bench-9\/brand_urls$/);
      expect(JSON.parse(init.body)).to.deep.equal(entries);
    });

    it('deleteBrandUrls DELETEs with body { ids }', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.deleteBrandUrls(WORKSPACE_ID, PROJECT_ID, BENCHMARK_ID, ['u1', 'u2']);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('DELETE');
      expect(url).to.match(/\/aio\/benchmarks\/bench-9\/brand_urls$/);
      expect(JSON.parse(init.body)).to.deep.equal({ ids: ['u1', 'u2'] });
    });

    it('createBenchmarks POSTs the benchmarks array to /v2/.../ai_models/benchmarks', async () => {
      fetchStub.resolves(fetchOk({ ids: ['b1'], existing_count: 0 }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const benchmarks = [{ brand_name: 'Acme', domain: 'acme.com' }];
      await transport.createBenchmarks(WORKSPACE_ID, PROJECT_ID, benchmarks);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('POST');
      expect(url).to.match(/\/v2\/workspaces\/.*\/projects\/proj-xyz\/ai_models\/benchmarks$/);
      expect(JSON.parse(init.body)).to.deep.equal(benchmarks);
    });

    it('deleteBenchmarks DELETEs /v1/.../ai_models/benchmarks with body { ids }', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.deleteBenchmarks(WORKSPACE_ID, PROJECT_ID, ['b1', 'b2']);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('DELETE');
      expect(url).to.match(/\/v1\/workspaces\/.*\/projects\/proj-xyz\/ai_models\/benchmarks$/);
      expect(JSON.parse(init.body)).to.deep.equal({ ids: ['b1', 'b2'] });
    });
  });

  describe('CI competitors', () => {
    it('getProject GETs the project with required draft + type=ai query', async () => {
      fetchStub.resolves(fetchOk({ id: PROJECT_ID, settings: { ci: { competitors: [] } } }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.getProject(WORKSPACE_ID, PROJECT_ID);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('GET');
      expect(url).to.include(`/v1/workspaces/${WORKSPACE_ID}/projects/proj-xyz?`);
      expect(url).to.include('draft=true');
      expect(url).to.include('type=ai');
    });

    it('getProject honors an explicit draft=false', async () => {
      fetchStub.resolves(fetchOk({ id: PROJECT_ID }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.getProject(WORKSPACE_ID, PROJECT_ID, { draft: false });

      const [url] = fetchStub.firstCall.args;
      expect(url).to.include('draft=false');
    });

    it('updateCiCompetitors PUTs ci/competitors with { ci_competitors }', async () => {
      fetchStub.resolves(fetchOk({ ci_competitors: [] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const list = [{ domain: 'a.com', color: '#111' }, { domain: 'b.com' }];
      await transport.updateCiCompetitors(WORKSPACE_ID, PROJECT_ID, list);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('PUT');
      expect(url).to.match(/\/projects\/proj-xyz\/ci\/competitors$/);
      expect(JSON.parse(init.body)).to.deep.equal({ ci_competitors: list });
    });
  });

  describe('publishProject', () => {
    it('POSTs to /v1/workspaces/{ws}/projects/{pid}/publish with no body', async () => {
      fetchStub.resolves(fetchOk({ status: 'accepted' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.publishProject(WORKSPACE_ID, PROJECT_ID);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('POST');
      expect(url).to.match(
        new RegExp(`/v1/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/publish$`),
      );
      expect(init.body).to.equal(undefined);
    });
  });

  describe('listAiModels', () => {
    it('GETs /v1/.../ai_models with page=1&limit=100 by default', async () => {
      fetchStub.resolves(fetchOk({ items: [] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.listAiModels(WORKSPACE_ID, PROJECT_ID);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('GET');
      expect(url).to.include(`/v1/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/ai_models?`);
      expect(url).to.include('page=1');
      expect(url).to.include('limit=100');
    });

    it('honours explicit page/limit for pagination', async () => {
      fetchStub.resolves(fetchOk({ items: [] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.listAiModels(WORKSPACE_ID, PROJECT_ID, { page: 3, limit: 25 });

      const [url] = fetchStub.firstCall.args;
      expect(url).to.include('page=3');
      expect(url).to.include('limit=25');
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

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('POST');
      expect(url).to.match(new RegExp(`/v1/workspaces/${WORKSPACE_ID}/projects$`));
      expect(JSON.parse(init.body)).to.deep.equal(body);
    });
  });

  describe('listLanguages (new in this PR)', () => {
    it('GETs /v1/languages', async () => {
      fetchStub.resolves(fetchOk({ items: [{ id: 'lang-en', name: 'English' }] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.listLanguages();

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('GET');
      expect(url).to.match(/\/v1\/languages$/);
      expect(result.items[0].name).to.equal('English');
    });
  });

  describe('deleteProject', () => {
    it('DELETEs /v1/workspaces/{ws}/projects/{pid} with no body', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.deleteProject(WORKSPACE_ID, PROJECT_ID);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('DELETE');
      expect(url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/projects/api/v1/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}`,
      );
      expect(init.body).to.be.undefined;
    });

    it('throws SerenityTransportError(404) on upstream not-found so callers can treat it as idempotent', async () => {
      fetchStub.resolves(fetchFail(404, { message: 'not found' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const promise = transport.deleteProject(WORKSPACE_ID, PROJECT_ID);
      await expect(promise).to.be.rejectedWith(SerenityTransportError);
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

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('POST');
      // V2: identical schema to v1, drop-in (createBenchmarks precedent). The
      // sibling list/delete ai_models routes have no v2 variant and stay on v1.
      expect(url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/projects/api/v2/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/ai_models`,
      );
      expect(JSON.parse(init.body)).to.deep.equal({ model_id: 'cat-gpt-4o' });
      expect(result.id).to.equal('new-assignment-uuid');
    });
  });

  describe('deleteAiModelsByIds (new in this PR)', () => {
    it('DELETEs an ids array from /v1/.../ai_models', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      await transport.deleteAiModelsByIds(WORKSPACE_ID, PROJECT_ID, ['assign-1', 'assign-2']);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('DELETE');
      expect(url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/projects/api/v1/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/ai_models`,
      );
      expect(JSON.parse(init.body)).to.deep.equal({ ids: ['assign-1', 'assign-2'] });
    });
  });

  describe('listGlobalAiModels', () => {
    it('GETs /v1/ai_models (global catalog, no workspace prefix) with default pagination', async () => {
      fetchStub.resolves(fetchOk({ page: 1, total: 1, items: [{ id: 'cat-gpt', key: 'chatgpt' }] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.listGlobalAiModels();

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('GET');
      expect(url).to.equal(
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

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('POST');
      expect(url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/projects/api/v2/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/aio/tags`,
      );
      expect(JSON.parse(init.body)).to.deep.equal({ names });
    });
  });

  describe('queryBrandPresenceResults', () => {
    it('POSTs render_data to the BP elements endpoint and returns raw JSON', async () => {
      const renderData = { project_id: 'proj-1', filters: {} };
      fetchStub.resolves(fetchOk({ data: { rows: [{ prompt: 'hello' }] } }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.queryBrandPresenceResults(WORKSPACE_ID, 'elem-42', renderData);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('POST');
      expect(url).to.equal(
        `https://adobe-hackathon.semrush.com/apis/v4-raw/external-api/v1/workspaces/${WORKSPACE_ID}/products/ai/elements/elem-42`,
      );
      expect(JSON.parse(init.body)).to.deep.equal({ render_data: renderData });
      expect(result.data.rows[0].prompt).to.equal('hello');
    });

    it('throws SerenityTransportError on upstream 4xx', async () => {
      fetchStub.resolves(fetchFail(403, { message: 'forbidden' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const promise = transport.queryBrandPresenceResults(WORKSPACE_ID, 'elem-42', {});
      await expect(promise).to.be.rejectedWith(SerenityTransportError);
    });
  });

  describe('getBrandTopics', () => {
    it('GETs /v1/workspaces/{ws}/brand-topics with domain + country query', async () => {
      fetchStub.resolves(fetchOk([
        { topic: 'Running', volume: 900, prompts: ['best running shoes'] },
      ]));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.getBrandTopics(WORKSPACE_ID, { domain: 'example.com', country: 'US' });

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('GET');
      expect(url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/projects/api/v1/workspaces/${WORKSPACE_ID}/brand-topics?domain=example.com&country=US`,
      );
      expect(result[0].topic).to.equal('Running');
    });
  });

  // ── Sub-workspace lifecycle (serenity dual-mode, subworkspace path) ──────────────
  const PARENT_WS = 'bb0f4e1c-8bb1-402e-88f2-f68618ea7397';

  describe('createSubworkspace', () => {
    it('POSTs { title, resources } to /v2/workspaces/{parent}/child (no X-Upload-Receipt)', async () => {
      fetchStub.resolves(fetchOk({ id: 'subworkspace-ws-1', status: 'not ready' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const resources = { ai: { projects: 3, prompts: 1500 } };
      const result = await transport.createSubworkspace(PARENT_WS, 'Adobe Express', resources);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('POST');
      expect(url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/users/api/v2/workspaces/${PARENT_WS}/child`,
      );
      expect(JSON.parse(init.body)).to.deep.equal({ title: 'Adobe Express', resources });
      expect(init.headers).to.not.have.property('X-Upload-Receipt');
      expect(result.id).to.equal('subworkspace-ws-1');
    });
  });

  describe('getWorkspaceStatus', () => {
    it('GETs /v1/workspaces/{ws}/status', async () => {
      fetchStub.resolves(fetchOk({ status: 'created' }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.getWorkspaceStatus(WORKSPACE_ID);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('GET');
      expect(url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/users/api/v1/workspaces/${WORKSPACE_ID}/status`,
      );
      expect(result.status).to.equal('created');
    });
  });

  describe('listWorkspaceFamily', () => {
    it('GETs /v1/workspaces/{parent}/family', async () => {
      fetchStub.resolves(fetchOk({ items: [{ id: 'subworkspace-ws-1', title: 'Adobe Express' }] }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.listWorkspaceFamily(PARENT_WS);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('GET');
      expect(url).to.equal(
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

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('POST');
      // V2: same aiProductResources `ai` shape proven live via createSubworkspace,
      // wrapped under `resources` (WorkspaceResourcesTransferV2Form).
      expect(url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/users/api/v2/workspaces/${WORKSPACE_ID}/resources/transfer`,
      );
      expect(JSON.parse(init.body)).to.deep.equal({ resources: payload });
    });
  });

  describe('deleteWorkspace (test-cleanup only)', () => {
    const DELETE_ENV = { ...TEST_ENV, SERENITY_ALLOW_WORKSPACE_DELETE: 'true' };

    it('DELETEs /v1/workspaces/{ws} with no body when explicitly allowed', async () => {
      fetchStub.resolves(fetchOk(null));
      const transport = createSerenityTransport({ env: DELETE_ENV, imsToken: IMS });

      await transport.deleteWorkspace(WORKSPACE_ID);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('DELETE');
      expect(url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/users/api/v1/workspaces/${WORKSPACE_ID}`,
      );
      expect(init.body).to.be.undefined;
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

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('GET');
      expect(url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/projects/api/v1/workspaces/${WORKSPACE_ID}/projects?type=ai`,
      );
      expect(result.items[0].id).to.equal(PROJECT_ID);
    });
  });

  describe('getInitStatus', () => {
    it('GETs /v1/workspaces/{ws}/projects/{pid}/aio/init_status', async () => {
      fetchStub.resolves(fetchOk({ initialized: false }));
      const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

      const result = await transport.getInitStatus(WORKSPACE_ID, PROJECT_ID);

      const [url, init] = fetchStub.firstCall.args;
      expect(init.method).to.equal('GET');
      expect(url).to.equal(
        `https://adobe-hackathon.semrush.com/enterprise/projects/api/v1/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/aio/init_status`,
      );
      expect(result.initialized).to.equal(false);
    });
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

      it('returns e.message unchanged for a plain (non-transport) Error', () => {
        const e = new Error('safe app error message');
        expect(redactUpstreamMessage(e)).to.equal('safe app error message');
      });

      it('returns undefined when called with null (e?.message is undefined)', () => {
        expect(redactUpstreamMessage(null)).to.equal(undefined);
      });
    });

    describe('enc nullish path via listProjects with undefined workspaceId', () => {
      it('encodes undefined workspaceId as empty string (String(undefined ?? ""))', async () => {
        // enc(undefined) -> String(undefined ?? '') = '' -> encodeURIComponent('') = ''
        fetchStub.resolves(fetchOk({ items: [] }));
        const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

        await transport.listProjects(undefined);

        const [url] = fetchStub.firstCall.args;
        // The workspaceId segment is encoded as empty string, so the URL has //
        // between /workspaces/ and /projects (empty segment).
        expect(url).to.include('/workspaces//projects?type=ai');
      });
    });

    describe('getBrandTopics with undefined domain and country', () => {
      it('falls back to empty string for undefined domain and country (String(?? "") branches)', async () => {
        // Lines 288-289: String(domain ?? '') and String(country ?? '') right-side branches.
        fetchStub.resolves(fetchOk([]));
        const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });

        await transport.getBrandTopics(WORKSPACE_ID, { domain: undefined, country: undefined });

        const [url] = fetchStub.firstCall.args;
        expect(url).to.include('domain=');
        expect(url).to.include('country=');
        // Both params present but with empty values.
        const params = new URL(url).searchParams;
        expect(params.get('domain')).to.equal('');
        expect(params.get('country')).to.equal('');
      });
    });
  });
});
