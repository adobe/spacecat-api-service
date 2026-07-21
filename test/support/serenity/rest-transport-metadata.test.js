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
import esmock from 'esmock';

use(chaiAsPromised);
use(sinonChai);

const IMS = 'ims-bearer-test-token';
const WS = '11111111-2222-3333-4444-555555555555';
const PID = 'proj-xyz';
const TEST_ENV = { SEMRUSH_PROJECTS_BASE_URL: 'https://adobe-hackathon.semrush.com' };

/**
 * The v3 prompt-authorship-metadata write methods (LLMO-6289) call facade
 * operations the CURRENTLY-INSTALLED project-engine-client (1.14.0) does not yet
 * expose — WP2 re-vendors the client to add them. To exercise the transport
 * WRAPPERS (their `{ params, body }` shaping) before that dep bump lands, esmock
 * replaces `createSerenityProjectEngineTransport` with a fake facade carrying the
 * four operations as stubs, and asserts each wrapper delegates with the right
 * init. Everything else in the module (the raw client, the user-manager client)
 * is left as the real export.
 */
describe('Semrush REST transport — v3 metadata write surface (LLMO-6289)', () => {
  const sandbox = sinon.createSandbox();
  let facade;
  let createSerenityTransport;

  beforeEach(async () => {
    facade = {
      createPromptsWithMetadata: sandbox.stub().resolves({ items: [{ id: 'new-1', name: 'x' }] }),
      patchPrompt: sandbox.stub().resolves({ id: 'p1', name: 'next', is_updated: true }),
      patchPromptMetadata: sandbox.stub().resolves(null),
      patchPromptsMetadataBatch: sandbox.stub().resolves(null),
    };
    const mod = await esmock(
      '../../../src/support/serenity/rest-transport.js',
      {
        '@adobe/spacecat-shared-project-engine-client': {
          createSerenityProjectEngineTransport: () => facade,
          createSerenityProjectEngineApiClient: () => ({ GET: sandbox.stub() }),
          ProjectEngineApiError: class ProjectEngineApiError extends Error {},
        },
        '@adobe/spacecat-shared-user-manager-client': {
          createSerenityUserManagerApiClient: () => ({}),
        },
      },
    );
    createSerenityTransport = mod.createSerenityTransport;
  });

  afterEach(() => sandbox.restore());

  it('createPromptsWithMetadata posts { items:[{name,metadata}], tag_ids } and returns the wrapper', async () => {
    const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });
    const items = [{
      name: 'hello',
      metadata: {
        created_by: 'u1', created_at: 't', updated_by: 'u1', updated_at: 't',
      },
    }];

    const result = await transport.createPromptsWithMetadata(WS, PID, items, ['tag-1']);

    expect(facade.createPromptsWithMetadata).to.have.been.calledOnceWithExactly({
      params: { path: { id: WS, project_id: PID } },
      body: { items, tag_ids: ['tag-1'] },
    });
    expect(result.items).to.deep.equal([{ id: 'new-1', name: 'x' }]);
  });

  it('patchPrompt PATCHes {id} with the combined { name, metadata } body', async () => {
    const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });
    const body = { name: 'next', metadata: { updated_by: 'u1', updated_at: 't' } };

    await transport.patchPrompt(WS, PID, 'p1', body);

    expect(facade.patchPrompt).to.have.been.calledOnceWithExactly({
      params: { path: { id: WS, project_id: PID, prompt_id: 'p1' } },
      body,
    });
  });

  it('patchPromptMetadata PATCHes {id}/metadata with the merge-patch body', async () => {
    const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });
    const metadata = { updated_by: 'u1', updated_at: 't', created_by: null };

    await transport.patchPromptMetadata(WS, PID, 'p1', metadata);

    expect(facade.patchPromptMetadata).to.have.been.calledOnceWithExactly({
      params: { path: { id: WS, project_id: PID, prompt_id: 'p1' } },
      body: metadata,
    });
  });

  it('patchPromptsMetadataBatch PATCHes /metadata with { items:[{id,metadata}] }', async () => {
    const transport = createSerenityTransport({ env: TEST_ENV, imsToken: IMS });
    const items = [
      { id: 'p1', metadata: { updated_by: 'u1' } },
      { id: 'p2', metadata: { updated_by: 'u2' } },
    ];

    await transport.patchPromptsMetadataBatch(WS, PID, items);

    expect(facade.patchPromptsMetadataBatch).to.have.been.calledOnceWithExactly({
      params: { path: { id: WS, project_id: PID } },
      body: { items },
    });
  });
});
