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
import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('document-path-resolver', () => {
  let sandbox;
  let resolveDocumentPath;
  let determineAEMCSPageIdStub;
  let getPageEditUrlStub;
  let log;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    log = { warn: sandbox.stub() };
    determineAEMCSPageIdStub = sandbox.stub().resolves(null);
    getPageEditUrlStub = sandbox.stub().resolves(null);

    const module = await esmock('../../src/support/document-path-resolver.js', {
      '@adobe/spacecat-shared-utils': {
        determineAEMCSPageId: determineAEMCSPageIdStub,
        getPageEditUrl: getPageEditUrlStub,
        prependSchema: (url) => (url.startsWith('http') ? url : `https://${url}`),
      },
    });
    resolveDocumentPath = module.resolveDocumentPath;
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('resolveDocumentPath', () => {
    describe('extractPageUrl / extractPagePath branches', () => {
      it('returns null when changeDetails is null (extractPageUrl branch)', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({ authorURL: 'https://author.example.com' }),
        };
        const result = await resolveDocumentPath(site, 'broken-internal-links', null, 'Bearer t', log);
        expect(result).to.be.null;
        expect(determineAEMCSPageIdStub).to.not.have.been.called;
      });

      it('returns null for opportunity type not in PAGE_URL_FIELDS', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({ authorURL: 'https://author.example.com' }),
        };
        const result = await resolveDocumentPath(site, 'unknown-opportunity-type', { url: 'https://example.com/p' }, 'Bearer t', log);
        expect(result).to.be.null;
        expect(determineAEMCSPageIdStub).to.not.have.been.called;
      });

      it('uses changeDetails.url for structured-data when path is missing (extractPagePath ternary)', async () => {
        determineAEMCSPageIdStub.resolves('page-id');
        getPageEditUrlStub.resolves('https://author.example.com/editor.html');
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({ authorURL: 'https://author.example.com' }),
        };
        const result = await resolveDocumentPath(site, 'structured-data', { url: 'https://example.com/docs/page' }, 'Bearer t', log);
        expect(result).to.equal('https://author.example.com/editor.html');
        expect(determineAEMCSPageIdStub).to.have.been.calledWith(
          'https://example.com/docs/page',
          'https://author.example.com',
          'Bearer t',
          false,
          log,
        );
      });
    });

    describe('broken-backlinks', () => {
      it('returns null when authorURL is missing', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({}),
        };
        const result = await resolveDocumentPath(site, 'broken-backlinks', { urlEdited: 'https://x.com/p' }, 'Bearer t', log);
        expect(result).to.be.null;
      });

      it('returns null when getDeliveryConfig returns null (optional chaining branch)', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => null,
        };
        const result = await resolveDocumentPath(site, 'broken-backlinks', { urlEdited: 'https://x.com/p' }, 'Bearer t', log);
        expect(result).to.be.null;
      });

      it('returns null when authorURL is empty string (branch coverage line 78)', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({ authorURL: '' }),
        };
        const result = await resolveDocumentPath(site, 'broken-backlinks', { urlEdited: 'https://x.com/p' }, 'Bearer t', log);
        expect(result).to.be.null;
      });

      it('returns vanity-urlmgr overlay URL when redirectsMode is vanityurlmgr and urlEdited present', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({
            authorURL: 'https://author.example.com',
            redirectsMode: 'vanityurlmgr',
          }),
        };
        const result = await resolveDocumentPath(site, 'broken-backlinks', { urlEdited: 'https://example.com/fix' }, 'Bearer t', log);
        expect(result).to.equal(
          'https://author.example.com/mnt/overlay/wcm/core/content/sites/properties.html?item=/fix',
        );
      });

      it('returns vanity-urlmgr overlay URL when urlEdited is absent but urlsSuggested is present', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({
            authorURL: 'https://author.example.com',
            redirectsMode: 'vanityurlmgr',
          }),
        };
        const result = await resolveDocumentPath(site, 'broken-backlinks', { urlsSuggested: ['https://example.com/fix'] }, 'Bearer t', log);
        expect(result).to.equal(
          'https://author.example.com/mnt/overlay/wcm/core/content/sites/properties.html?item=/fix',
        );
      });

      it('returns vanity-urlmgr overlay URL when urlEdited and urlsSuggested absent but urlSuggested is present', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({
            authorURL: 'https://author.example.com',
            redirectsMode: 'vanityurlmgr',
          }),
        };
        const result = await resolveDocumentPath(site, 'broken-backlinks', { urlSuggested: ['https://example.com/fix'] }, 'Bearer t', log);
        expect(result).to.equal(
          'https://author.example.com/mnt/overlay/wcm/core/content/sites/properties.html?item=/fix',
        );
      });

      it('falls through to redirectsSource when vanityurlmgr but no targetUrl at all', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({
            authorURL: 'https://author.example.com',
            redirectsMode: 'vanityurlmgr',
            redirectsSource: '/etc/redirects.txt',
          }),
        };
        const result = await resolveDocumentPath(site, 'broken-backlinks', {}, 'Bearer t', log);
        expect(result).to.equal('https://author.example.com/etc/redirects.txt');
      });

      it('falls through to redirectsSource when vanityurlmgr and changeDetails is null', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({
            authorURL: 'https://author.example.com',
            redirectsMode: 'vanityurlmgr',
            redirectsSource: '/etc/redirects.txt',
          }),
        };
        const result = await resolveDocumentPath(site, 'broken-backlinks', null, 'Bearer t', log);
        expect(result).to.equal('https://author.example.com/etc/redirects.txt');
      });

      it('returns redirectsSource URL when redirectsSource is set', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({
            authorURL: 'https://author.example.com',
            redirectsSource: '/etc/redirects.txt',
          }),
        };
        const result = await resolveDocumentPath(site, 'broken-backlinks', {}, 'Bearer t', log);
        expect(result).to.equal('https://author.example.com/etc/redirects.txt');
      });

      it('returns redirectsSource when redirectsMode is set but not vanityurlmgr', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({
            authorURL: 'https://author.example.com',
            redirectsMode: 'redirectmap',
            redirectsSource: '/etc/redirects.txt',
          }),
        };
        const result = await resolveDocumentPath(site, 'broken-backlinks', { urlEdited: 'https://example.com/fix' }, 'Bearer t', log);
        expect(result).to.equal('https://author.example.com/etc/redirects.txt');
      });

      it('falls through to redirectsSource when vanityurlmgr targetUrl is malformed', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({
            authorURL: 'https://author.example.com',
            redirectsMode: 'vanityurlmgr',
            redirectsSource: '/etc/redirects.txt',
          }),
        };
        // Use a value that causes new URL() to throw (e.g. empty string or invalid)
        const result = await resolveDocumentPath(site, 'broken-backlinks', { urlEdited: '  \t' }, 'Bearer t', log);
        expect(result).to.equal('https://author.example.com/etc/redirects.txt');
      });

      it('returns null when vanityurlmgr targetUrl is malformed and no redirectsSource', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({
            authorURL: 'https://author.example.com',
            redirectsMode: 'vanityurlmgr',
          }),
        };
        const result = await resolveDocumentPath(site, 'broken-backlinks', { urlEdited: '  \t' }, 'Bearer t', log);
        expect(result).to.be.null;
      });
    });

    describe('AEM CS (aem_cs)', () => {
      it('returns null when authorURL is missing for page-level type', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({}),
        };
        const result = await resolveDocumentPath(site, 'broken-internal-links', { urlFrom: 'https://example.com/page' }, 'Bearer t', log);
        expect(result).to.be.null;
      });

      it('resolves page URL via determineAEMCSPageId and getPageEditUrl for broken-internal-links', async () => {
        determineAEMCSPageIdStub.resolves('resolved-page-id');
        getPageEditUrlStub.resolves('https://author.example.com/editor.html/resolved');
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({
            authorURL: 'https://author.example.com',
            preferContentApi: true,
          }),
        };
        const result = await resolveDocumentPath(site, 'broken-internal-links', { urlFrom: 'https://example.com/page' }, 'Bearer t', log);
        expect(result).to.equal('https://author.example.com/editor.html/resolved');
        expect(determineAEMCSPageIdStub).to.have.been.calledWith(
          'https://example.com/page',
          'https://author.example.com',
          'Bearer t',
          true,
          log,
        );
        expect(getPageEditUrlStub).to.have.been.calledWith('https://author.example.com', 'Bearer t', 'resolved-page-id');
      });

      it('returns null when extractPageUrl returns null for opportunity type', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({ authorURL: 'https://author.example.com' }),
        };
        const result = await resolveDocumentPath(site, 'broken-internal-links', {}, 'Bearer t', log);
        expect(result).to.be.null;
        expect(determineAEMCSPageIdStub).to.not.have.been.called;
      });

      it('returns null when determineAEMCSPageId returns null', async () => {
        determineAEMCSPageIdStub.resolves(null);
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({ authorURL: 'https://author.example.com' }),
        };
        const result = await resolveDocumentPath(site, 'canonical', { url: 'https://example.com/p' }, 'Bearer t', log);
        expect(result).to.be.null;
        expect(getPageEditUrlStub).to.not.have.been.called;
      });

      it('uses changeDetails.path for structured-data when url field is missing', async () => {
        determineAEMCSPageIdStub.resolves('page-id');
        getPageEditUrlStub.resolves('https://author.example.com/editor.html');
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({ authorURL: 'https://author.example.com' }),
        };
        const result = await resolveDocumentPath(site, 'structured-data', { path: '/docs/page' }, 'Bearer t', log);
        expect(result).to.equal('https://author.example.com/editor.html');
        // Resolver passes prependSchema(pageUrlRaw) to determineAEMCSPageId; path '/docs/page' becomes 'https:///docs/page'
        expect(determineAEMCSPageIdStub).to.have.been.calledWith(
          'https:///docs/page',
          'https://author.example.com',
          'Bearer t',
          false,
          log,
        );
      });

      it('returns null for structured-data when both url and path are missing', async () => {
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({ authorURL: 'https://author.example.com' }),
        };
        const result = await resolveDocumentPath(site, 'structured-data', {}, 'Bearer t', log);
        expect(result).to.be.null;
        expect(determineAEMCSPageIdStub).to.not.have.been.called;
      });
    });

    describe('AEM Edge (aem_edge)', () => {
      it('returns null when contentClient is not provided', async () => {
        const site = {
          getDeliveryType: () => 'aem_edge',
          getDeliveryConfig: () => ({}),
        };
        const result = await resolveDocumentPath(site, 'broken-internal-links', { urlFrom: 'https://example.com/page' }, 'Bearer t', log);
        expect(result).to.be.null;
      });

      it('resolves edit URL via contentClient when contentClient and page path are present', async () => {
        const mockContentClient = {
          getResourcePath: sandbox.stub().resolves('/docs/page.md'),
          getEditURL: sandbox.stub().resolves('https://eds.edit.url/page'),
          getLivePreviewURLs: sandbox.stub().resolves({ previewURL: 'https://preview.url' }),
        };
        const site = {
          getDeliveryType: () => 'aem_edge',
          getDeliveryConfig: () => ({}),
        };
        const result = await resolveDocumentPath(
          site,
          'broken-internal-links',
          { urlFrom: 'https://example.com/page' },
          'Bearer t',
          log,
          mockContentClient,
        );
        expect(result).to.equal('https://eds.edit.url/page');
        expect(mockContentClient.getResourcePath).to.have.been.calledWith('/page');
        expect(mockContentClient.getEditURL).to.have.been.calledWith('/docs/page');
      });

      it('falls back to previewURL when getEditURL returns null', async () => {
        const mockContentClient = {
          getResourcePath: sandbox.stub().resolves('/docs/page.md'),
          getEditURL: sandbox.stub().resolves(null),
          getLivePreviewURLs: sandbox.stub().resolves({ previewURL: 'https://preview.url/page' }),
        };
        const site = {
          getDeliveryType: () => 'aem_edge',
          getDeliveryConfig: () => ({}),
        };
        const result = await resolveDocumentPath(
          site,
          'meta-tags',
          { url: 'https://example.com/page' },
          'Bearer t',
          log,
          mockContentClient,
        );
        expect(result).to.equal('https://preview.url/page');
        expect(mockContentClient.getLivePreviewURLs).to.have.been.calledWith('/docs/page');
      });

      it('uses url from changeDetails for structured-data on AEM Edge (extractPagePath ternary true branch)', async () => {
        const mockContentClient = {
          getResourcePath: sandbox.stub().resolves('/docs/page.md'),
          getEditURL: sandbox.stub().resolves('https://eds.edit.url/page'),
          getLivePreviewURLs: sandbox.stub().resolves({ previewURL: null }),
        };
        const site = {
          getDeliveryType: () => 'aem_edge',
          getDeliveryConfig: () => ({}),
        };
        const result = await resolveDocumentPath(
          site,
          'structured-data',
          { url: 'https://example.com/docs/page' },
          'Bearer t',
          log,
          mockContentClient,
        );
        expect(result).to.equal('https://eds.edit.url/page');
        expect(mockContentClient.getResourcePath).to.have.been.calledWith('/docs/page');
      });

      it('uses path from changeDetails when path starts with / (structured-data)', async () => {
        const mockContentClient = {
          getResourcePath: sandbox.stub().resolves('/site/docs/page.md'),
          getEditURL: sandbox.stub().resolves('https://edit.url'),
        };
        const site = {
          getDeliveryType: () => 'aem_edge',
          getDeliveryConfig: () => ({}),
        };
        const result = await resolveDocumentPath(
          site,
          'structured-data',
          { path: '/docs/page' },
          'Bearer t',
          log,
          mockContentClient,
        );
        expect(result).to.equal('https://edit.url');
        expect(mockContentClient.getResourcePath).to.have.been.calledWith('/docs/page');
      });

      it('returns null when extractPagePath returns null for aem_edge', async () => {
        const mockContentClient = {
          getResourcePath: sandbox.stub(),
          getEditURL: sandbox.stub(),
        };
        const site = {
          getDeliveryType: () => 'aem_edge',
          getDeliveryConfig: () => ({}),
        };
        const result = await resolveDocumentPath(site, 'canonical', {}, 'Bearer t', log, mockContentClient);
        expect(result).to.be.null;
        expect(mockContentClient.getResourcePath).to.not.have.been.called;
      });

      it('returns null when getResourcePath returns null', async () => {
        const mockContentClient = {
          getResourcePath: sandbox.stub().resolves(null),
          getEditURL: sandbox.stub(),
        };
        const site = {
          getDeliveryType: () => 'aem_edge',
          getDeliveryConfig: () => ({}),
        };
        const result = await resolveDocumentPath(
          site,
          'broken-internal-links',
          { urlFrom: 'https://example.com/page' },
          'Bearer t',
          log,
          mockContentClient,
        );
        expect(result).to.be.null;
        expect(mockContentClient.getEditURL).to.not.have.been.called;
      });

      it('returns null when getEditURL and getLivePreviewURLs both yield no URL', async () => {
        const mockContentClient = {
          getResourcePath: sandbox.stub().resolves('/docs/p.md'),
          getEditURL: sandbox.stub().resolves(null),
          getLivePreviewURLs: sandbox.stub().resolves({ previewURL: null }),
        };
        const site = {
          getDeliveryType: () => 'aem_edge',
          getDeliveryConfig: () => ({}),
        };
        const result = await resolveDocumentPath(
          site,
          'meta-tags',
          { url: 'https://example.com/p' },
          'Bearer t',
          log,
          mockContentClient,
        );
        expect(result).to.be.null;
      });

      it('returns null when extractPagePath throws (e.g. malformed URL in changeDetails)', async () => {
        const mockContentClient = {
          getResourcePath: sandbox.stub(),
          getEditURL: sandbox.stub(),
        };
        const site = {
          getDeliveryType: () => 'aem_edge',
          getDeliveryConfig: () => ({}),
        };
        const result = await resolveDocumentPath(
          site,
          'canonical',
          { url: 'http://[' },
          'Bearer t',
          log,
          mockContentClient,
        );
        expect(result).to.be.null;
        expect(mockContentClient.getResourcePath).to.not.have.been.called;
      });

      it('returns null when getLivePreviewURLs returns undefined (urls?.previewURL branch)', async () => {
        const mockContentClient = {
          getResourcePath: sandbox.stub().resolves('/docs/p.md'),
          getEditURL: sandbox.stub().resolves(null),
          getLivePreviewURLs: sandbox.stub().resolves(undefined),
        };
        const site = {
          getDeliveryType: () => 'aem_edge',
          getDeliveryConfig: () => ({}),
        };
        const result = await resolveDocumentPath(
          site,
          'meta-tags',
          { url: 'https://example.com/p' },
          'Bearer t',
          log,
          mockContentClient,
        );
        expect(result).to.be.null;
      });
    });

    describe('error handling', () => {
      it('returns null and logs when resolveDocumentPath throws', async () => {
        determineAEMCSPageIdStub.rejects(new Error('Network error'));
        const site = {
          getDeliveryType: () => 'aem_cs',
          getDeliveryConfig: () => ({ authorURL: 'https://author.example.com' }),
        };
        const result = await resolveDocumentPath(site, 'broken-internal-links', { urlFrom: 'https://example.com/p' }, 'Bearer t', log);
        expect(result).to.be.null;
        expect(log.warn).to.have.been.calledOnce;
        expect(log.warn.firstCall.args[0]).to.include('Failed to resolve documentPath');
        expect(log.warn.firstCall.args[0]).to.include('Network error');
      });
    });
  });
});
