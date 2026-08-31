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

/* eslint-disable max-len -- AI Visibility cited-pages search_type tests */

import { expect } from 'chai';
import sinon from 'sinon';
import { create } from '@bufbuild/protobuf';
import {
  SourcesResponseSchema,
  OwnedSourcesTotalResponseSchema,
} from '@quazar/ai-seo-ts/v2/source/messages_pb.js';
import { ExportResponseSchema } from '@quazar/ai-seo-ts/v2/common/messages_pb.js';
import { SEARCH_TYPE_ENUM } from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import { handleCitedPages } from '../../../../../../src/support/ai-visibility/handlers/v1/source/cited-pages.js';
import { handleCitedPagesTotals } from '../../../../../../src/support/ai-visibility/handlers/v1/source/cited-pages-totals.js';
import { handleCitedPagesExport } from '../../../../../../src/support/ai-visibility/handlers/v1/source/cited-pages-export.js';

function sp(query) {
  return new URLSearchParams(query);
}

const APEX = 'domain=intuit.com';
const SUBDOMAIN = 'domain=quickbooks.intuit.com';
const WWW = 'domain=www.intuit.com';
const MISSING = '';

describe('AI Visibility – v1 cited-pages search_type (LLMO-7015)', () => {
  let sandbox;
  let clients;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clients = {
      sourceClient: {
        sources: sandbox.stub().resolves(create(SourcesResponseSchema, { source: [] })),
        ownedSourcesTotal: sandbox.stub().resolves(create(OwnedSourcesTotalResponseSchema, {})),
        sourcesExport: sandbox.stub().resolves(create(ExportResponseSchema, {})),
      },
    };
  });

  afterEach(() => sandbox.restore());

  describe('handleCitedPages', () => {
    it('resolves search_type DOMAIN for an apex domain', async () => {
      await handleCitedPages(sp(APEX), clients);
      expect(clients.sourceClient.sources.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type SUBDOMAIN for a non-www subdomain', async () => {
      await handleCitedPages(sp(SUBDOMAIN), clients);
      expect(clients.sourceClient.sources.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.SUBDOMAIN);
    });

    it('resolves search_type DOMAIN for a bare www subdomain', async () => {
      await handleCitedPages(sp(WWW), clients);
      expect(clients.sourceClient.sources.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type DOMAIN when the domain is missing', async () => {
      await handleCitedPages(sp(MISSING), clients);
      expect(clients.sourceClient.sources.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });
  });

  describe('handleCitedPagesTotals', () => {
    it('resolves search_type DOMAIN for an apex domain', async () => {
      await handleCitedPagesTotals(sp(APEX), clients);
      expect(clients.sourceClient.ownedSourcesTotal.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type SUBDOMAIN for a non-www subdomain', async () => {
      await handleCitedPagesTotals(sp(SUBDOMAIN), clients);
      expect(clients.sourceClient.ownedSourcesTotal.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.SUBDOMAIN);
    });

    it('resolves search_type DOMAIN for a bare www subdomain', async () => {
      await handleCitedPagesTotals(sp(WWW), clients);
      expect(clients.sourceClient.ownedSourcesTotal.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type DOMAIN when the domain is missing', async () => {
      await handleCitedPagesTotals(sp(MISSING), clients);
      expect(clients.sourceClient.ownedSourcesTotal.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });
  });

  describe('handleCitedPagesExport', () => {
    it('resolves search_type DOMAIN for an apex domain on the nested request', async () => {
      await handleCitedPagesExport(sp(APEX), clients);
      expect(clients.sourceClient.sourcesExport.firstCall.args[0].request.searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type SUBDOMAIN for a non-www subdomain on the nested request', async () => {
      await handleCitedPagesExport(sp(SUBDOMAIN), clients);
      expect(clients.sourceClient.sourcesExport.firstCall.args[0].request.searchType).to.equal(SEARCH_TYPE_ENUM.SUBDOMAIN);
    });

    it('resolves search_type DOMAIN for a bare www subdomain on the nested request', async () => {
      await handleCitedPagesExport(sp(WWW), clients);
      expect(clients.sourceClient.sourcesExport.firstCall.args[0].request.searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type DOMAIN when the domain is missing on the nested request', async () => {
      await handleCitedPagesExport(sp(MISSING), clients);
      expect(clients.sourceClient.sourcesExport.firstCall.args[0].request.searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });
  });
});
