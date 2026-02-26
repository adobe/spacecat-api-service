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

/* eslint-env mocha */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import {
  isAEMAuthoredSite,
  buildCheckPath,
  resolvePageIds,
  fetchRelationships,
} from '../../src/support/aem-content-api.js';

use(chaiAsPromised);
use(sinonChai);

describe('AEM Content API support', () => {
  const sandbox = sinon.createSandbox();
  let log;
  let originalFetch;
  let fetchStub;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchStub = sandbox.stub();
    global.fetch = fetchStub;

    log = {
      info: sandbox.stub(),
      error: sandbox.stub(),
      warn: sandbox.stub(),
      debug: sandbox.stub(),
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    sandbox.restore();
  });

  describe('isAEMAuthoredSite', () => {
    it('returns true for aem_cs', () => {
      expect(isAEMAuthoredSite(SiteModel.DELIVERY_TYPES.AEM_CS)).to.be.true;
    });

    it('returns true for aem_ams', () => {
      expect(isAEMAuthoredSite(SiteModel.DELIVERY_TYPES.AEM_AMS)).to.be.true;
    });

    it('returns false for aem_edge', () => {
      expect(isAEMAuthoredSite(SiteModel.DELIVERY_TYPES.AEM_EDGE)).to.be.false;
    });

    it('returns false for other', () => {
      expect(isAEMAuthoredSite(SiteModel.DELIVERY_TYPES.OTHER)).to.be.false;
    });

    it('returns falsy for null', () => {
      expect(isAEMAuthoredSite(null)).to.not.equal(true);
    });

    it('returns falsy for undefined', () => {
      expect(isAEMAuthoredSite(undefined)).to.not.equal(true);
    });

    it('returns falsy for empty string', () => {
      expect(isAEMAuthoredSite('')).to.not.equal(true);
    });
  });

  describe('buildCheckPath', () => {
    it('returns /properties/jcr:title for Missing Title when metaTagPropertyMap is empty', () => {
      expect(buildCheckPath('Missing Title', {})).to.equal('/properties/jcr:title');
    });

    it('returns custom title property for Missing Title when metaTagPropertyMap.title is set', () => {
      expect(buildCheckPath('Missing Title', { title: 'myTitle' })).to.equal('/properties/myTitle');
    });

    it('returns /properties/jcr:description for Missing Description when metaTagPropertyMap is empty', () => {
      expect(buildCheckPath('Missing Description', {})).to.equal('/properties/jcr:description');
    });

    it('returns custom description property for Missing Description when metaTagPropertyMap.description is set', () => {
      expect(buildCheckPath('Missing Description', { description: 'myDesc' })).to.equal('/properties/myDesc');
    });

    it('returns undefined for alt-text or other suggestion types', () => {
      expect(buildCheckPath('Missing Alt Text')).to.be.undefined;
      expect(buildCheckPath('Other Type')).to.be.undefined;
      expect(buildCheckPath('')).to.be.undefined;
    });

    it('returns undefined when suggestionType is undefined', () => {
      expect(buildCheckPath(undefined)).to.be.undefined;
    });

    it('uses default jcr:title when metaTagPropertyMap is undefined', () => {
      expect(buildCheckPath('Missing Title', undefined)).to.equal('/properties/jcr:title');
    });
  });

  describe('resolvePageIds', () => {
    it('returns invalid pageUrl error for empty or non-string entries', async () => {
      const result = await resolvePageIds(
        'https://example.com',
        'https://author.example.com',
        [undefined, '   '],
        'token',
        log,
      );

      expect(result).to.deep.equal([
        { url: undefined, error: 'Invalid pageUrl' },
        { url: '   ', error: 'Invalid pageUrl' },
      ]);
      expect(fetchStub).to.not.have.been.called;
    });

    it('returns pageId when HTML contains content-page-id meta', async () => {
      const html = '<meta name="content-page-id" content="pg-123-abc" />';
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(html),
      });

      const result = await resolvePageIds(
        'https://example.com',
        'https://author.example.com',
        ['/us/en/page1'],
        'token',
        log,
      );

      expect(result).to.have.lengthOf(1);
      expect(result[0]).to.deep.equal({ url: '/us/en/page1', pageId: 'pg-123-abc' });
      expect(global.fetch).to.have.been.calledOnceWith(
        'https://example.com/us/en/page1',
        { method: 'GET', redirect: 'follow' },
      );
    });

    it('accepts pageUrl without leading slash and builds full URL', async () => {
      const html = '<meta name="content-page-id" content="pg-456" />';
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(html),
      });

      const result = await resolvePageIds(
        'https://example.com',
        'https://author.example.com',
        ['us/en/page2'],
        'token',
        log,
      );

      expect(result[0].pageId).to.equal('pg-456');
      expect(global.fetch).to.have.been.calledWith(
        'https://example.com/us/en/page2',
        { method: 'GET', redirect: 'follow' },
      );
    });

    it('strips trailing slash from siteBaseURL', async () => {
      const html = '<meta name="content-page-id" content="pg-x" />';
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve(html),
      });

      await resolvePageIds(
        'https://example.com/',
        'https://author.example.com',
        ['/page'],
        'token',
        log,
      );

      expect(global.fetch).to.have.been.calledWith(
        'https://example.com/page',
        sinon.match.any,
      );
    });

    it('returns error when HTTP response is not ok', async () => {
      fetchStub.resolves({
        ok: false,
        status: 404,
      });

      const result = await resolvePageIds(
        'https://example.com',
        'https://author.example.com',
        ['/us/en/page1'],
        'token',
        log,
      );

      expect(result).to.have.lengthOf(1);
      expect(result[0]).to.deep.equal({ url: '/us/en/page1', error: 'HTTP 404' });
    });

    it('returns error when HTML has no content-page-id or content-page-ref', async () => {
      fetchStub.resolves({
        ok: true,
        text: () => Promise.resolve('<html><body>no meta</body></html>'),
      });

      const result = await resolvePageIds(
        'https://example.com',
        'https://author.example.com',
        ['/page'],
        'token',
        log,
      );

      expect(result[0].error).to.equal('No content-page-id or content-page-ref');
    });

    it('resolves via content-page-ref when content-page-id is absent', async () => {
      const html = '<meta name="content-page-ref" content="aem:path:/content/site/en/page" />';
      fetchStub
        .onFirstCall()
        .resolves({
          ok: true,
          text: () => Promise.resolve(html),
        })
        .onSecondCall()
        .resolves({
          ok: true,
          json: () => Promise.resolve({ pageId: 'pg-from-ref' }),
        });

      const result = await resolvePageIds(
        'https://example.com',
        'https://author.example.com',
        ['/page'],
        'token',
        log,
      );

      expect(result[0]).to.deep.equal({ url: '/page', pageId: 'pg-from-ref' });
      expect(global.fetch).to.have.been.calledTwice;
      const resolveCall = global.fetch.secondCall;
      expect(resolveCall.args[0]).to.include('/adobe/pages/resolve');
      expect(resolveCall.args[0]).to.include('pageRef=');
      expect(resolveCall.args[1].headers.Authorization).to.equal('Bearer token');
    });

    it('returns resolve failed when content-page-ref resolve API is not ok', async () => {
      const html = '<meta name="content-page-ref" content="aem:path:/content/site/en/page" />';
      fetchStub
        .onFirstCall()
        .resolves({
          ok: true,
          text: () => Promise.resolve(html),
        })
        .onSecondCall()
        .resolves({
          ok: false,
          status: 404,
        });

      const result = await resolvePageIds(
        'https://example.com',
        'https://author.example.com',
        ['/page'],
        'token',
        log,
      );

      expect(result[0]).to.deep.equal({ url: '/page', error: 'Resolve failed' });
      expect(log.warn).to.have.been.calledWith('Resolve API returned 404 for pageRef');
    });

    it('returns resolve failed when content-page-ref resolve API throws', async () => {
      const html = '<meta name="content-page-ref" content="aem:path:/content/site/en/page" />';
      fetchStub
        .onFirstCall()
        .resolves({
          ok: true,
          text: () => Promise.resolve(html),
        })
        .onSecondCall()
        .rejects(new Error('Resolve failure'));

      const result = await resolvePageIds(
        'https://example.com',
        'https://author.example.com',
        ['/page'],
        'token',
        log,
      );

      expect(result[0]).to.deep.equal({ url: '/page', error: 'Resolve failed' });
      expect(log.warn).to.have.been.calledWith('Resolve API error: Resolve failure');
    });

    it('returns resolve failed when content-page-ref resolve response has no pageId', async () => {
      const html = '<meta name="content-page-ref" content="aem:path:/content/site/en/page" />';
      fetchStub
        .onFirstCall()
        .resolves({
          ok: true,
          text: () => Promise.resolve(html),
        })
        .onSecondCall()
        .resolves({
          ok: true,
          json: () => Promise.resolve({}),
        });

      const result = await resolvePageIds(
        'https://example.com',
        'https://author.example.com',
        ['/page'],
        'token',
        log,
      );

      expect(result[0]).to.deep.equal({ url: '/page', error: 'Resolve failed' });
    });

    it('returns error when fetch throws', async () => {
      fetchStub.rejects(new Error('Network error'));

      const result = await resolvePageIds(
        'https://example.com',
        'https://author.example.com',
        ['/page'],
        'token',
        log,
      );

      expect(result[0].error).to.equal('Network error');
      expect(log.warn).to.have.been.calledWith(sinon.match(/resolvePageIds failed/));
    });
  });

  describe('fetchRelationships', () => {
    it('POSTs to correct URL and returns results and errors', async () => {
      const mockResults = { k1: { pageId: 'pg1', upstream: { chain: [] } } };
      const mockErrors = {};
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ results: mockResults, errors: mockErrors }),
      });

      const items = [
        { key: 'k1', pageId: 'pg1', include: ['upstream'] },
      ];

      const result = await fetchRelationships(
        'https://author.example.com',
        items,
        'ims-token',
        log,
      );

      expect(result.results).to.deep.equal(mockResults);
      expect(result.errors).to.deep.equal(mockErrors);
      expect(global.fetch).to.have.been.calledOnceWith(
        'https://author.example.com/adobe/pages/relationships/search',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ims-token',
          },
          body: JSON.stringify({ items }),
        },
      );
    });

    it('strips trailing slash from authorURL', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({ results: {}, errors: {} }),
      });

      await fetchRelationships(
        'https://author.example.com/',
        [],
        'token',
        log,
      );

      expect(global.fetch).to.have.been.calledWith(
        'https://author.example.com/adobe/pages/relationships/search',
        sinon.match.any,
      );
    });

    it('returns results and errors on non-ok response', async () => {
      fetchStub.resolves({
        ok: false,
        status: 500,
      });

      const result = await fetchRelationships(
        'https://author.example.com',
        [],
        'token',
        log,
      );

      expect(result.results).to.deep.equal({});
      expect(result.errors).to.deep.equal({ default: { error: 'HTTP 500' } });
      expect(log.warn).to.have.been.calledWith('Relationships search returned 500');
    });

    it('defaults missing results and errors to empty objects', async () => {
      fetchStub.resolves({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const result = await fetchRelationships(
        'https://author.example.com',
        [],
        'token',
        log,
      );

      expect(result.results).to.deep.equal({});
      expect(result.errors).to.deep.equal({});
    });

    it('returns default error when fetch throws', async () => {
      fetchStub.rejects(new Error('Connection refused'));

      const result = await fetchRelationships(
        'https://author.example.com',
        [],
        'token',
        log,
      );

      expect(result.results).to.deep.equal({});
      expect(result.errors).to.deep.equal({ default: { error: 'Connection refused' } });
      expect(log.warn).to.have.been.calledWith(sinon.match(/Relationships search error/));
    });
  });
});
