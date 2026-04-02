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

/* eslint-env mocha */

import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);

describe('content-api-access handler', () => {
  const sandbox = sinon.createSandbox();
  const authorURL = 'https://author-p123-e456.adobeaemcloud.com';

  const loggerStub = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    warn: sandbox.stub(),
    debug: sandbox.stub(),
  };

  const mockSite = {
    getDeliveryType: () => 'aem_cs',
    getDeliveryConfig: () => ({ authorURL }),
  };

  const mockContext = {
    pathInfo: {
      headers: {
        authorization: 'Bearer test-ims-token',
      },
    },
  };

  let fetchStub;
  let contentApiAccessHandler;

  before(async () => {
    fetchStub = sandbox.stub();

    const mod = await esmock(
      '../../../../src/support/preflight-checks/handlers/content-api-access.js',
      {
        '@adobe/spacecat-shared-utils': {
          tracingFetch: fetchStub,
        },
      },
    );
    contentApiAccessHandler = mod.default;
  });

  afterEach(() => {
    sandbox.restore();
    fetchStub.reset();
  });

  it('returns PASSED for Edge Delivery sites', async () => {
    const site = { getDeliveryType: () => 'aem_edge', getDeliveryConfig: () => ({}) };
    const result = await contentApiAccessHandler(site, mockContext, loggerStub);

    expect(result.type).to.equal('content-api-access');
    expect(result.status).to.equal('PASSED');
    expect(result.message).to.include('Edge Delivery');
    expect(fetchStub).to.not.have.been.called;
  });

  it('returns FAILED when site has no authorURL', async () => {
    const site = { getDeliveryType: () => 'aem_cs', getDeliveryConfig: () => ({}) };
    const result = await contentApiAccessHandler(site, mockContext, loggerStub);

    expect(result.type).to.equal('content-api-access');
    expect(result.status).to.equal('FAILED');
    expect(result.message).to.include('no authorURL');
  });

  it('returns FAILED when authorization header is missing', async () => {
    const ctx = { pathInfo: { headers: {} } };
    const result = await contentApiAccessHandler(mockSite, ctx, loggerStub);

    expect(result.status).to.equal('FAILED');
    expect(result.message).to.include('authorization header');
  });

  it('returns PASSED when Content API responds 200', async () => {
    fetchStub.resolves({ ok: true, status: 200 });

    const result = await contentApiAccessHandler(mockSite, mockContext, loggerStub);

    expect(result.status).to.equal('PASSED');
    expect(result.message).to.equal('Content API is accessible');
    expect(fetchStub).to.have.been.calledOnce;

    const [url, opts] = fetchStub.firstCall.args;
    expect(url).to.equal(`${authorURL}/adobe/experimental/expires-20251231/pages?limit=1`);
    expect(opts.headers.Authorization).to.equal('Bearer test-ims-token');
  });

  it('returns FAILED with "not available" for 404', async () => {
    fetchStub.resolves({ ok: false, status: 404 });

    const result = await contentApiAccessHandler(mockSite, mockContext, loggerStub);

    expect(result.status).to.equal('FAILED');
    expect(result.message).to.include('not available');
  });

  it('returns FAILED with "permissions" for 401', async () => {
    fetchStub.resolves({ ok: false, status: 401 });

    const result = await contentApiAccessHandler(mockSite, mockContext, loggerStub);

    expect(result.status).to.equal('FAILED');
    expect(result.message).to.include('permissions');
  });

  it('returns FAILED with "permissions" for 403', async () => {
    fetchStub.resolves({ ok: false, status: 403 });

    const result = await contentApiAccessHandler(mockSite, mockContext, loggerStub);

    expect(result.status).to.equal('FAILED');
    expect(result.message).to.include('permissions');
  });

  it('returns FAILED with unexpected status for other codes', async () => {
    fetchStub.resolves({ ok: false, status: 500 });

    const result = await contentApiAccessHandler(mockSite, mockContext, loggerStub);

    expect(result.status).to.equal('FAILED');
    expect(result.message).to.include('unexpected status 500');
  });

  it('returns FAILED with "not reachable" on network error', async () => {
    fetchStub.rejects(new Error('ECONNREFUSED'));

    const result = await contentApiAccessHandler(mockSite, mockContext, loggerStub);

    expect(result.status).to.equal('FAILED');
    expect(result.message).to.include('not reachable');
    expect(loggerStub.error).to.have.been.calledOnce;
  });
});
