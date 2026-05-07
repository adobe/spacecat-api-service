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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

import {
  isAEMAuthoredSite,
  buildCheckPath,
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
      expect(isAEMAuthoredSite('aem_cs')).to.be.true;
    });

    it('returns true for aem_ams', () => {
      expect(isAEMAuthoredSite('aem_ams')).to.be.true;
    });

    it('returns false for aem_edge', () => {
      expect(isAEMAuthoredSite('aem_edge')).to.be.false;
    });

    it('returns false for other', () => {
      expect(isAEMAuthoredSite('other')).to.be.false;
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
    it('matches title-related issues to jcr:title by default', () => {
      expect(buildCheckPath('Missing title', {})).to.equal('/properties/jcr:title');
      expect(buildCheckPath('Title too short', {})).to.equal('/properties/jcr:title');
      expect(buildCheckPath('Invalid title', {})).to.equal('/properties/jcr:title');
      expect(buildCheckPath('Duplicate title', {})).to.equal('/properties/jcr:title');
      expect(buildCheckPath('Missing title tag', {})).to.equal('/properties/jcr:title');
    });

    it('matches description-related issues to jcr:description by default', () => {
      expect(buildCheckPath('Missing description', {})).to.equal('/properties/jcr:description');
      expect(buildCheckPath('Missing meta description', {})).to.equal('/properties/jcr:description');
      expect(buildCheckPath('Description too long', {})).to.equal('/properties/jcr:description');
    });

    it('uses custom metaTagPropertyMap title when provided', () => {
      const config = { metaTagPropertyMap: { title: 'myTitle' } };
      expect(buildCheckPath('Missing title', config)).to.equal('/properties/myTitle');
      expect(buildCheckPath('Title too short', config)).to.equal('/properties/myTitle');
    });

    it('uses custom metaTagPropertyMap description when provided', () => {
      const config = { metaTagPropertyMap: { description: 'myDesc' } };
      expect(buildCheckPath('Missing meta description', config)).to.equal('/properties/myDesc');
    });

    it('returns undefined for non-metatag issues', () => {
      expect(buildCheckPath('Missing Alt Text')).to.be.undefined;
      expect(buildCheckPath('Broken link')).to.be.undefined;
      expect(buildCheckPath('')).to.be.undefined;
    });

    it('returns undefined when suggestionType is undefined', () => {
      expect(buildCheckPath(undefined)).to.be.undefined;
    });

    it('is case-insensitive', () => {
      expect(buildCheckPath('MISSING TITLE', {})).to.equal('/properties/jcr:title');
      expect(buildCheckPath('missing meta description', {})).to.equal('/properties/jcr:description');
    });

    it('uses defaults when deliveryConfig is undefined', () => {
      expect(buildCheckPath('Missing title', undefined)).to.equal('/properties/jcr:title');
      expect(buildCheckPath('Missing description', undefined)).to.equal('/properties/jcr:description');
    });

    it('does not apply metaTagPropertyMap to non-metatag suggestions', () => {
      const config = { metaTagPropertyMap: { 'alt text': 'dam:altText' } };
      expect(buildCheckPath('Missing Alt Text', config)).to.be.undefined;
    });
  });

  describe('resolvePageIds', () => {
    let resolvePageIds;
    let determineAEMCSPageIdStub;

    beforeEach(async () => {
      determineAEMCSPageIdStub = sandbox.stub();
      ({ resolvePageIds } = await esmock(
        '../../src/support/aem-content-api.js',
        {
          '@adobe/spacecat-shared-utils': {
            DELIVERY_TYPES: { AEM_CS: 'aem_cs', AEM_AMS: 'aem_ams' },
            determineAEMCSPageId: determineAEMCSPageIdStub,
          },
        },
      ));
    });

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
      expect(determineAEMCSPageIdStub).to.not.have.been.called;
    });

    it('returns pageId when shared utility resolves successfully', async () => {
      determineAEMCSPageIdStub.resolves('pg-123-abc');

      const result = await resolvePageIds(
        'https://example.com',
        'https://author.example.com',
        ['/us/en/page1'],
        'token',
        log,
      );

      expect(result).to.have.lengthOf(1);
      expect(result[0]).to.deep.equal({ url: '/us/en/page1', pageId: 'pg-123-abc' });
      expect(determineAEMCSPageIdStub).to.have.been.calledOnceWith(
        'https://example.com/us/en/page1',
        'https://author.example.com',
        'Bearer token',
        true,
        log,
      );
    });

    it('constructs full URL with slash for paths without leading slash', async () => {
      determineAEMCSPageIdStub.resolves('pg-456');

      await resolvePageIds(
        'https://example.com',
        'https://author.example.com',
        ['us/en/page2'],
        'token',
        log,
      );

      expect(determineAEMCSPageIdStub).to.have.been.calledWith(
        'https://example.com/us/en/page2',
        sinon.match.any,
        sinon.match.any,
        sinon.match.any,
        sinon.match.any,
      );
    });

    it('strips trailing slash from siteBaseURL', async () => {
      determineAEMCSPageIdStub.resolves('pg-x');

      await resolvePageIds(
        'https://example.com/',
        'https://author.example.com',
        ['/page'],
        'token',
        log,
      );

      expect(determineAEMCSPageIdStub).to.have.been.calledWith(
        'https://example.com/page',
        sinon.match.any,
        sinon.match.any,
        sinon.match.any,
        sinon.match.any,
      );
    });

    it('returns error when shared utility returns null', async () => {
      determineAEMCSPageIdStub.resolves(null);

      const result = await resolvePageIds(
        'https://example.com',
        'https://author.example.com',
        ['/us/en/page1'],
        'token',
        log,
      );

      expect(result).to.have.lengthOf(1);
      expect(result[0].url).to.equal('/us/en/page1');
      expect(result[0].error).to.equal('Could not determine page ID');
    });

    it('returns error when shared utility throws', async () => {
      determineAEMCSPageIdStub.rejects(new Error('Network error'));

      const result = await resolvePageIds(
        'https://example.com',
        'https://author.example.com',
        ['/page'],
        'token',
        log,
      );

      expect(result[0].error).to.equal('Network error');
      expect(log.warn).to.have.been.calledWith(
        sinon.match(/resolvePageIds failed/),
      );
    });

    it('resolves multiple pages in batch', async () => {
      determineAEMCSPageIdStub.onFirstCall().resolves('pg-1');
      determineAEMCSPageIdStub.onSecondCall().resolves(null);
      determineAEMCSPageIdStub.onThirdCall()
        .rejects(new Error('fail'));

      const result = await resolvePageIds(
        'https://example.com',
        'https://author.example.com',
        ['/page1', '/page2', '/page3'],
        'token',
        log,
      );

      expect(result).to.have.lengthOf(3);
      expect(result[0]).to.deep.equal({ url: '/page1', pageId: 'pg-1' });
      expect(result[1].error).to.equal('Could not determine page ID');
      expect(result[2].error).to.equal('fail');
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
