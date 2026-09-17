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
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import { resolveProjects } from '../../../src/support/serenity/resolve-projects.js';

use(sinonChai);

const WS = 'ws-1';

describe('resolveProjects', () => {
  const sandbox = sinon.createSandbox();
  afterEach(() => sandbox.restore());

  it('lists via transport.listProjects and returns its items when no prefetch is supplied', async () => {
    const items = [{ id: 'p-1' }, { id: 'p-2' }];
    const transport = { listProjects: sandbox.stub().resolves({ items }) };

    const result = await resolveProjects(transport, WS);

    expect(result).to.equal(items);
    expect(transport.listProjects).to.have.been.calledOnceWith(WS);
  });

  it('lists when prefetchedProjects is explicitly null', async () => {
    const items = [{ id: 'p-1' }];
    const transport = { listProjects: sandbox.stub().resolves({ items }) };

    const result = await resolveProjects(transport, WS, null);

    expect(result).to.deep.equal(items);
    expect(transport.listProjects).to.have.been.calledOnceWith(WS);
  });

  it('reuses an explicit empty-array prefetch WITHOUT listing (empty-array-reuse invariant)', async () => {
    const transport = { listProjects: sandbox.stub() };

    const result = await resolveProjects(transport, WS, []);

    expect(result).to.deep.equal([]);
    expect(transport.listProjects).to.not.have.been.called;
  });

  it('returns a non-empty prefetch as-is without listing', async () => {
    const prefetched = [{ id: 'p-9' }];
    const transport = { listProjects: sandbox.stub() };

    const result = await resolveProjects(transport, WS, prefetched);

    expect(result).to.equal(prefetched);
    expect(transport.listProjects).to.not.have.been.called;
  });

  it('returns [] when the listing has no items property (?.items handling)', async () => {
    const transport = { listProjects: sandbox.stub().resolves({}) };

    const result = await resolveProjects(transport, WS);

    expect(result).to.deep.equal([]);
    expect(transport.listProjects).to.have.been.calledOnceWith(WS);
  });

  it('returns [] when listProjects returns a non-array items value', async () => {
    const transport = { listProjects: sandbox.stub().resolves({ items: null }) };

    const result = await resolveProjects(transport, WS);

    expect(result).to.deep.equal([]);
    expect(transport.listProjects).to.have.been.calledOnceWith(WS);
  });
});
