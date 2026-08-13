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
import esmock from 'esmock';

use(chaiAsPromised);

const ENV = { SEMRUSH_PROJECTS_BASE_URL: 'https://adobe-hackathon.semrush.com' };
const IMS_TOKEN = 'ims-access-token-abc';

describe('provisionWorkspaceMember', () => {
  let sandbox;
  let fetchStub;
  let provisionWorkspaceMember;
  let SerenityTransportError;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    fetchStub = sandbox.stub();
    ({ provisionWorkspaceMember } = await esmock('../../../src/support/onboarding/workspace-provisioning.js', {
      '@adobe/spacecat-shared-utils': { tracingFetch: fetchStub },
    }));
    ({ SerenityTransportError } = await import('../../../src/support/serenity/serenity-transport-error.js'));
  });

  afterEach(() => sandbox.restore());

  it('POSTs to the workspace-members endpoint with the IMS token on both the header and body', async () => {
    fetchStub.resolves({
      ok: true,
      status: 200,
      json: async () => ({
        email: 'jane@example.com', organization_id: 'org-abc', workspace_id: 'ws-123', role: 'admin',
      }),
    });

    const result = await provisionWorkspaceMember(ENV, IMS_TOKEN);

    expect(fetchStub.calledOnce).to.equal(true);
    const [url, opts] = fetchStub.firstCall.args;
    expect(url).to.equal('https://adobe-hackathon.semrush.com/enterprise/users/api/v1/adobe-ims/workspace-members');
    expect(opts.method).to.equal('POST');
    expect(opts.headers.authorization).to.equal(`Bearer ${IMS_TOKEN}`);
    expect(JSON.parse(opts.body)).to.deep.equal({ token: IMS_TOKEN });

    expect(result).to.deep.equal({
      email: 'jane@example.com',
      organizationId: 'org-abc',
      workspaceId: 'ws-123',
      role: 'admin',
    });
  });

  it('throws a SerenityTransportError carrying the upstream status on a non-2xx response', async () => {
    fetchStub.resolves({ ok: false, status: 409, json: async () => ({ message: 'already a member' }) });

    let thrown;
    try {
      await provisionWorkspaceMember(ENV, IMS_TOKEN);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).to.be.instanceOf(SerenityTransportError);
    expect(thrown.status).to.equal(409);
    expect(thrown.body).to.deep.equal({ message: 'already a member' });
  });

  it('treats an unparseable body as null on a non-2xx response (empty/non-JSON upstream body)', async () => {
    fetchStub.resolves({
      ok: false,
      status: 500,
      json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
    });

    let thrown;
    try {
      await provisionWorkspaceMember(ENV, IMS_TOKEN);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).to.be.instanceOf(SerenityTransportError);
    expect(thrown.status).to.equal(500);
    expect(thrown.body).to.equal(null);
  });

  it('throws a 502 SerenityTransportError rather than returning undefined fields when a 2xx response has an unparseable body', async () => {
    fetchStub.resolves({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
    });

    await expect(provisionWorkspaceMember(ENV, IMS_TOKEN))
      .to.be.rejectedWith(SerenityTransportError, /invalid response/)
      .and.eventually.have.property('status', 502);
  });

  it('throws a 502 SerenityTransportError when a 2xx response is missing workspace_id', async () => {
    fetchStub.resolves({
      ok: true,
      status: 200,
      json: async () => ({ email: 'jane@example.com', organization_id: 'org-abc', role: 'admin' }),
    });

    await expect(provisionWorkspaceMember(ENV, IMS_TOKEN))
      .to.be.rejectedWith(SerenityTransportError, /invalid response/)
      .and.eventually.have.property('status', 502);
  });

  it('throws a 502 SerenityTransportError when a 2xx response is missing role', async () => {
    fetchStub.resolves({
      ok: true,
      status: 200,
      json: async () => ({ email: 'jane@example.com', organization_id: 'org-abc', workspace_id: 'ws-123' }),
    });

    await expect(provisionWorkspaceMember(ENV, IMS_TOKEN))
      .to.be.rejectedWith(SerenityTransportError, /invalid response/)
      .and.eventually.have.property('status', 502);
  });

  it('throws a 502 SerenityTransportError when the request to Semrush fails (network error)', async () => {
    fetchStub.rejects(new Error('ECONNREFUSED'));

    await expect(provisionWorkspaceMember(ENV, IMS_TOKEN))
      .to.be.rejectedWith(SerenityTransportError)
      .and.eventually.have.property('status', 502);
  });

  it('propagates a 503 configuration error when SEMRUSH_PROJECTS_BASE_URL is unset', async () => {
    let thrown;
    try {
      await provisionWorkspaceMember({}, IMS_TOKEN);
    } catch (e) {
      thrown = e;
    }

    expect(thrown.status).to.equal(503);
    expect(fetchStub.called).to.equal(false);
  });

  it('passes an AbortSignal with the shared 15s Semrush timeout on the fetch call', async () => {
    fetchStub.resolves({
      ok: true,
      status: 200,
      json: async () => ({
        email: 'jane@example.com', organization_id: 'org-abc', workspace_id: 'ws-123', role: 'admin',
      }),
    });

    await provisionWorkspaceMember(ENV, IMS_TOKEN);

    const [, opts] = fetchStub.firstCall.args;
    expect(opts.signal).to.be.instanceOf(AbortSignal);
  });

  it('maps an AbortError from a timed-out request to a 502 SerenityTransportError', async () => {
    const abortError = new Error('This operation was aborted');
    abortError.name = 'TimeoutError';
    fetchStub.rejects(abortError);

    await expect(provisionWorkspaceMember(ENV, IMS_TOKEN))
      .to.be.rejectedWith(SerenityTransportError, /TimeoutError/)
      .and.eventually.have.property('status', 502);
  });
});
