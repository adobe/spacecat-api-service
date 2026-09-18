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
import { createElementsService } from '../../../src/support/elements/elements-service.js';
import { ELEMENT_IDS } from '../../../src/support/elements/element-ids.js';

use(chaiAsPromised);
use(sinonChai);

const row = (overrides = {}) => ({
  project_id: 'project-1',
  prompt: 'Which shoes are best?',
  response: 'A complete answer',
  date: '2026-09-07',
  model: 'search-gpt',
  responses: 1,
  sources: [],
  tags: [],
  ...overrides,
});
const page = (rows, rowCount) => ({
  blocks: { data: rows, data_statistics: [{ rowCount }] },
});

describe('createElementsService#getResponseFeed', () => {
  let transport;
  let service;

  beforeEach(() => {
    transport = { fetchElement: sinon.stub() };
    service = createElementsService(transport);
  });

  it('makes exactly one combined-element request for one project page', async () => {
    transport.fetchElement.resolves(page([row()], 1));
    const result = await service.getResponseFeed('workspace-1', {
      projectId: 'project-1', date: '2026-09-07', offset: 0, pageSize: 500,
    });

    expect(transport.fetchElement).to.have.been.calledOnceWith(
      'workspace-1',
      ELEMENT_IDS.BRAND_CLAIMS_RESPONSES,
      sinon.match({ project_id: 'project-1' }),
      sinon.match({
        timeoutMs: 20_000,
        maxRetries: 0,
        maxResponseBytes: 8 * 1024 * 1024,
        redactWorkspaceInErrors: true,
      }),
    );
    expect(result.page).to.deep.equal({
      offset: 0, pageSize: 500, returned: 1, rowCount: 1, nextOffset: null,
    });
  });

  it('passes an endpoint-configured upstream byte ceiling to the transport', async () => {
    transport.fetchElement.resolves(page([], 0));
    await service.getResponseFeed('workspace-1', {
      projectId: 'project-1',
      date: '2026-09-07',
      offset: 0,
      pageSize: 500,
      maxUpstreamBytes: 1234,
    });
    expect(transport.fetchElement.firstCall.args[3]).to.include({
      timeoutMs: 20_000,
      maxRetries: 0,
      maxResponseBytes: 1234,
      redactWorkspaceInErrors: true,
    });
  });

  it('returns the next offset while rows remain', async () => {
    transport.fetchElement.resolves(page(Array.from({ length: 500 }, () => row()), 1296));
    const result = await service.getResponseFeed('workspace-1', {
      projectId: 'project-1', date: '2026-09-07', offset: 500, pageSize: 500,
    });
    expect(result.page.nextOffset).to.equal(1000);
  });

  it('terminates an exact-multiple corpus without requesting an empty page', async () => {
    transport.fetchElement.resolves(page(Array.from({ length: 500 }, () => row()), 1000));
    const result = await service.getResponseFeed('workspace-1', {
      projectId: 'project-1', date: '2026-09-07', offset: 500, pageSize: 500,
    });
    expect(result.page.nextOffset).to.equal(null);
    expect(transport.fetchElement).to.have.been.calledOnce;
  });

  it('accepts a genuinely empty corpus at offset zero', async () => {
    transport.fetchElement.resolves(page([], 0));
    const result = await service.getResponseFeed('workspace-1', {
      projectId: 'project-1', date: '2026-09-07', offset: 0, pageSize: 500,
    });
    expect(result.page).to.include({ returned: 0, rowCount: 0, nextOffset: null });
  });

  it('rejects a spurious empty page for a non-empty corpus', async () => {
    transport.fetchElement.resolves(page([], 1000));
    await expect(service.getResponseFeed('workspace-1', {
      projectId: 'project-1', date: '2026-09-07', offset: 1000, pageSize: 500,
    })).to.be.rejectedWith('empty nonterminal page');
  });

  it('rejects impossible pagination metadata', async () => {
    transport.fetchElement.resolves(page([row(), row()], 1));
    await expect(service.getResponseFeed('workspace-1', {
      projectId: 'project-1', date: '2026-09-07', offset: 0, pageSize: 500,
    })).to.be.rejectedWith('pagination metadata');
  });

  [
    ['another project', { project_id: 'project-2' }],
    ['another date', { date: '2026-09-08' }],
    ['another model', { model: 'perplexity' }],
  ].forEach(([description, changed]) => {
    it(`rejects a row from ${description}`, async () => {
      transport.fetchElement.resolves(page([row(changed)], 1));
      await expect(service.getResponseFeed('workspace-1', {
        projectId: 'project-1', date: '2026-09-07', offset: 0, pageSize: 500,
      })).to.be.rejectedWith('outside the requested slice');
    });
  });
});
