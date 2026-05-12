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
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import {
  createSerenityTransport,
  SerenityTransportError,
} from '../../../src/support/serenity/rest-transport.js';

use(chaiAsPromised);

const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body == null ? '' : JSON.stringify(body)),
  };
}

describe('serenity/rest-transport', () => {
  let fetchStub;

  beforeEach(() => {
    fetchStub = sinon.stub();
    globalThis.fetch = fetchStub;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('forwards the IMS bearer as Auth-Data-Jwt on each call', async () => {
    fetchStub.resolves(jsonResponse({ items: [], page: 1, total: 0 }));
    const t = createSerenityTransport({ env: {}, imsToken: 'ims-token-xyz' });
    await t.listPromptsByTags('ws', 'p1', { tag_ids: [] });
    expect(fetchStub.calledOnce).to.equal(true);
    const [url, init] = fetchStub.firstCall.args;
    expect(url).to.include('/v2/workspaces/ws/projects/p1/aio/prompts/by_tags');
    expect(init.headers['Auth-Data-Jwt']).to.equal('ims-token-xyz');
    expect(init.method).to.equal('POST');
    const body = JSON.parse(init.body);
    expect(body.tag_ids).to.deep.equal([]);
    expect(body.page).to.equal(1);
  });

  it('uses SEMRUSH_PROJECTS_BASE_URL when set', async () => {
    fetchStub.resolves(jsonResponse({ ids: ['x'] }, 201));
    const t = createSerenityTransport({
      env: { SEMRUSH_PROJECTS_BASE_URL: 'https://stage.example.com/' },
      imsToken: 't',
    });
    await t.createTaggedPrompts('ws', 'p1', { 'tag-a': ['hello'] });
    const [url] = fetchStub.firstCall.args;
    expect(url.startsWith('https://stage.example.com/enterprise/projects/api/v2/workspaces/ws/projects/p1/aio/prompts/tagged')).to.equal(true);
  });

  it('refuses to call without an IMS token', async () => {
    const t = createSerenityTransport({ env: {}, imsToken: '' });
    await expect(t.listPromptsByTags('ws', 'p1', {})).to.be.rejectedWith(SerenityTransportError);
    expect(fetchStub.called).to.equal(false);
  });

  it('wraps non-2xx responses as SerenityTransportError', async () => {
    fetchStub.resolves(jsonResponse({ error: 'forbidden' }, 403));
    const t = createSerenityTransport({ env: {}, imsToken: 't' });
    try {
      await t.listPromptsByTags('ws', 'p1', {});
      expect.fail('expected throw');
    } catch (e) {
      expect(e).to.be.instanceOf(SerenityTransportError);
      expect(e.status).to.equal(403);
      expect(e.body).to.deep.equal({ error: 'forbidden' });
    }
  });

  it('returns parsed JSON on success', async () => {
    fetchStub.resolves(jsonResponse({ items: [{ id: 'p1', name: 'hi', tags: [] }], total: 1 }));
    const t = createSerenityTransport({ env: {}, imsToken: 't' });
    const result = await t.listPromptsByTags('ws', 'p1', { tag_ids: [] });
    expect(result.total).to.equal(1);
    expect(result.items[0].name).to.equal('hi');
  });

  it('DELETE forwards the body of ids', async () => {
    fetchStub.resolves(jsonResponse(null, 204));
    const t = createSerenityTransport({ env: {}, imsToken: 't' });
    await t.deletePromptsByIds('ws', 'p1', ['a', 'b']);
    const [, init] = fetchStub.firstCall.args;
    expect(init.method).to.equal('DELETE');
    expect(JSON.parse(init.body)).to.deep.equal({ ids: ['a', 'b'] });
  });
});
