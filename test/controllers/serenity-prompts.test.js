/* eslint-disable header/header */
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

import { expect, use } from 'chai';
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import esmock from 'esmock';

use(chaiAsPromised);

class FakeError extends Error {}

const BRAND = 'b-1';
const FIXTURE = {
  workspaceId: 'ws-1',
  rows: [
    {
      brandId: BRAND, category: 'SEO', market: 'US', language: 'en', projectId: 'p-us-en',
    },
  ],
};

function makeContext({
  token, brandId, data, query,
} = {}) {
  const url = new URL('http://localhost/');
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  return {
    env: { SEMRUSH_PROJECT_MATRIX: JSON.stringify(FIXTURE) },
    request: { url: url.toString() },
    pathInfo: { headers: { authorization: token ? `Bearer ${token}` : '' } },
    params: { brandId },
    data: data || {},
  };
}

describe('SerenityPromptsController', () => {
  let SerenityPromptsController;
  let log;

  beforeEach(async () => {
    log = { error: sinon.spy(), info: sinon.spy(), debug: sinon.spy() };
    SerenityPromptsController = (await esmock(
      '../../src/controllers/serenity-prompts.js',
    )).default;
  });

  it('returns 400 when no IMS bearer is present', async () => {
    const ctrl = SerenityPromptsController({ env: {} }, log);
    const ctx = makeContext({ brandId: BRAND });
    const res = await ctrl.listPrompts(ctx);
    expect(res.status).to.equal(400);
  });

  it('returns 503 when matrix is not configured', async () => {
    const ctrl = SerenityPromptsController({ env: {} }, log);
    const ctx = makeContext({ token: 'tok', brandId: BRAND });
    ctx.env = {}; // no matrix configured
    const res = await ctrl.listPrompts(ctx);
    expect(res.status).to.equal(503);
    const body = await res.json();
    expect(body.error).to.equal('matrixNotConfigured');
  });

  it('listPrompts hits the matrix project and returns aggregated results', async () => {
    const fakeTransport = {
      listPromptsByTags: sinon.stub().resolves({
        items: [{ id: 's1', name: 'hello', tags: [{ id: 't', name: 'general' }] }],
        total: 1,
        page: 1,
      }),
      createTaggedPrompts: sinon.stub(),
      deletePromptsByIds: sinon.stub(),
    };
    const mocked = await esmock(
      '../../src/controllers/serenity-prompts.js',
      {
        '../../src/support/serenity/rest-transport.js': {
          createSerenityTransport: () => fakeTransport,
          SerenityTransportError: FakeError,
        },
      },
    );
    const ctrl = mocked.default({ env: {} }, log);
    const ctx = makeContext({ token: 'tok', brandId: BRAND });
    const res = await ctrl.listPrompts(ctx);
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.items).to.have.lengthOf(1);
    expect(body.items[0].text).to.equal('hello');
    expect(fakeTransport.listPromptsByTags.calledOnce).to.equal(true);
  });

  it('returns 201 on create with fan-out results', async () => {
    const fakeTransport = {
      listPromptsByTags: sinon.stub(),
      createTaggedPrompts: sinon.stub().resolves({ ids: ['new-id'], existing_count: 0 }),
      deletePromptsByIds: sinon.stub(),
    };
    const mocked = await esmock(
      '../../src/controllers/serenity-prompts.js',
      {
        '../../src/support/serenity/rest-transport.js': {
          createSerenityTransport: () => fakeTransport,
          SerenityTransportError: FakeError,
        },
      },
    );
    const ctrl = mocked.default({ env: {} }, log);
    const ctx = makeContext({
      token: 'tok',
      brandId: BRAND,
      data: {
        prompts: [{
          text: 't', category: 'SEO', language: 'en', regions: ['US'],
        }],
      },
    });
    const res = await ctrl.createPrompts(ctx);
    expect(res.status).to.equal(201);
    const body = await res.json();
    expect(body.created).to.have.lengthOf(1);
    expect(body.created[0].projects[0].semrushPromptId).to.equal('new-id');
  });

  it('returns 400 from updatePrompt when promptId is missing', async () => {
    const ctrl = SerenityPromptsController({ env: {} }, log);
    const ctx = makeContext({ token: 'tok', brandId: BRAND });
    delete ctx.params.promptId;
    const res = await ctrl.updatePrompt(ctx);
    expect(res.status).to.equal(400);
  });
});
