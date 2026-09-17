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

/* eslint-disable max-len -- AI Visibility gap-source-domains search_type tests */

import { expect } from 'chai';
import sinon from 'sinon';
import { create } from '@bufbuild/protobuf';
import {
  GapSourceDomainsResponseSchema,
  GapSourceDomainsTotalsResponseSchema,
} from '@quazar/ai-seo-ts/v2/source/messages_pb.js';
import { ExportResponseSchema } from '@quazar/ai-seo-ts/v2/common/messages_pb.js';
import { SEARCH_TYPE_ENUM } from '@quazar/ai-seo-ts/v2/source/enums_pb.js';
import { handleGapSourceDomains } from '../../../../../../src/support/ai-visibility/handlers/v1/source/gap-source-domains.js';
import { handleGapSourceDomainsTotals } from '../../../../../../src/support/ai-visibility/handlers/v1/source/gap-source-domains-totals.js';
import { handleGapSourceDomainsExport } from '../../../../../../src/support/ai-visibility/handlers/v1/source/gap-source-domains-export.js';

function sp(query) {
  return new URLSearchParams(query);
}

const APEX = 'domain=intuit.com&competitors=rival.com';
const SUBDOMAIN = 'domain=quickbooks.intuit.com&competitors=rival.com';

describe('AI Visibility – v1 gap-source-domains search_type (LLMO-7082)', () => {
  let sandbox;
  let clients;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    clients = {
      sourceClient: {
        gapSourceDomains: sandbox.stub().resolves(create(GapSourceDomainsResponseSchema, { domains: [] })),
        gapSourceDomainsTotals: sandbox.stub().resolves(create(GapSourceDomainsTotalsResponseSchema, { totals: [] })),
        gapSourceDomainsExport: sandbox.stub().resolves(create(ExportResponseSchema, {})),
      },
    };
  });

  afterEach(() => sandbox.restore());

  describe('handleGapSourceDomains', () => {
    it('resolves search_type DOMAIN for an apex domain', async () => {
      await handleGapSourceDomains(sp(APEX), clients);
      expect(clients.sourceClient.gapSourceDomains.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type SUBDOMAIN for a non-www subdomain', async () => {
      await handleGapSourceDomains(sp(SUBDOMAIN), clients);
      expect(clients.sourceClient.gapSourceDomains.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.SUBDOMAIN);
    });
  });

  describe('handleGapSourceDomainsTotals', () => {
    it('resolves search_type DOMAIN for an apex domain', async () => {
      await handleGapSourceDomainsTotals(sp(APEX), clients);
      expect(clients.sourceClient.gapSourceDomainsTotals.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type SUBDOMAIN for a non-www subdomain', async () => {
      await handleGapSourceDomainsTotals(sp(SUBDOMAIN), clients);
      expect(clients.sourceClient.gapSourceDomainsTotals.firstCall.args[0].searchType).to.equal(SEARCH_TYPE_ENUM.SUBDOMAIN);
    });
  });

  describe('handleGapSourceDomainsExport', () => {
    it('resolves search_type DOMAIN for an apex domain on the nested request', async () => {
      await handleGapSourceDomainsExport(sp(APEX), clients);
      expect(clients.sourceClient.gapSourceDomainsExport.firstCall.args[0].request.searchType).to.equal(SEARCH_TYPE_ENUM.DOMAIN);
    });

    it('resolves search_type SUBDOMAIN for a non-www subdomain on the nested request', async () => {
      await handleGapSourceDomainsExport(sp(SUBDOMAIN), clients);
      expect(clients.sourceClient.gapSourceDomainsExport.firstCall.args[0].request.searchType).to.equal(SEARCH_TYPE_ENUM.SUBDOMAIN);
    });
  });
});
