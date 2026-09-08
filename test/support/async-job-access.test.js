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

import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import { loadJobScopedToCaller } from '../../src/support/async-job-access.js';

use(sinonChai);

describe('loadJobScopedToCaller', () => {
  const sandbox = sinon.createSandbox();
  const jobId = '123e4567-e89b-12d3-a456-426614174000';
  const siteId = 'test-site-123';

  const makeJob = (metadata) => ({
    getId: () => jobId,
    getMetadata: () => metadata,
  });

  const makeSite = () => ({
    getId: () => siteId,
    getOrganization: () => ({ getImsOrgId: () => 'ims-org-123' }),
  });

  // A caller who belongs to the owning org.
  const ownerAuthInfo = {
    getProfile: () => ({ email: 'user@example.com' }),
    getType: () => 'ims',
    getScopes: () => [],
    isAdmin: () => false,
    isReadOnlyAdmin: () => false,
    hasOrganization: () => true,
  };

  const makeContext = (overrides = {}) => ({
    log: {
      info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub(), debug: sandbox.stub(),
    },
    attributes: { authInfo: ownerAuthInfo },
    pathInfo: { method: 'GET', suffix: `/preflight/jobs/${jobId}`, headers: {} },
    dataAccess: {
      AsyncJob: { findById: sandbox.stub() },
      Site: { findById: sandbox.stub() },
    },
    ...overrides,
  });

  afterEach(() => sandbox.restore());

  it('returns the job when jobType matches and caller owns the site', async () => {
    const context = makeContext();
    const job = makeJob({ jobType: 'preflight', payload: { siteId } });
    context.dataAccess.AsyncJob.findById.resolves(job);
    context.dataAccess.Site.findById.resolves(makeSite());

    const result = await loadJobScopedToCaller(context, {
      jobId,
      allowedJobTypes: ['preflight'],
      resolveOwnerSiteId: (j) => j.getMetadata().payload.siteId,
    });

    expect(result.job).to.equal(job);
    expect(result.error).to.be.undefined;
  });

  it('returns 404 when the job does not exist', async () => {
    const context = makeContext();
    context.dataAccess.AsyncJob.findById.resolves(null);

    const result = await loadJobScopedToCaller(context, {
      jobId,
      allowedJobTypes: ['preflight'],
      resolveOwnerSiteId: () => siteId,
    });

    expect(result.job).to.be.undefined;
    expect(result.error.status).to.equal(404);
  });

  it('returns 404 (no existence disclosure) when the jobType is not allowed', async () => {
    const context = makeContext();
    // A token-bearing job of another type must be indistinguishable from "not found".
    context.dataAccess.AsyncJob.findById.resolves(
      makeJob({ jobType: 'serenity-classify-prompts', promiseToken: 'SECRET', payload: { siteId } }),
    );

    const result = await loadJobScopedToCaller(context, {
      jobId,
      allowedJobTypes: ['preflight'],
      resolveOwnerSiteId: (j) => j.getMetadata().payload.siteId,
    });

    expect(result.job).to.be.undefined;
    expect(result.error.status).to.equal(404);
    // The site lookup / access check must never run for a disallowed type.
    expect(context.dataAccess.Site.findById).to.not.have.been.called;
  });

  it('returns 404 when the caller does not own the job\'s site', async () => {
    const nonOwner = { ...ownerAuthInfo, hasOrganization: () => false };
    const context = makeContext({ attributes: { authInfo: nonOwner } });
    context.dataAccess.AsyncJob.findById.resolves(makeJob({ jobType: 'preflight', payload: { siteId } }));
    context.dataAccess.Site.findById.resolves(makeSite());

    const result = await loadJobScopedToCaller(context, {
      jobId,
      allowedJobTypes: ['preflight'],
      resolveOwnerSiteId: (j) => j.getMetadata().payload.siteId,
    });

    expect(result.job).to.be.undefined;
    expect(result.error.status).to.equal(404);
  });

  it('returns 404 when the resolved site no longer exists', async () => {
    const context = makeContext();
    context.dataAccess.AsyncJob.findById.resolves(makeJob({ jobType: 'preflight', payload: { siteId } }));
    context.dataAccess.Site.findById.resolves(null);

    const result = await loadJobScopedToCaller(context, {
      jobId,
      allowedJobTypes: ['preflight'],
      resolveOwnerSiteId: (j) => j.getMetadata().payload.siteId,
    });

    expect(result.error.status).to.equal(404);
  });

  it('scopes by jobType only (no ownership) when no resolver is supplied', async () => {
    const context = makeContext();
    const job = makeJob({ jobType: 'site-detection', payload: { domain: 'www.example.com' } });
    context.dataAccess.AsyncJob.findById.resolves(job);

    const result = await loadJobScopedToCaller(context, {
      jobId,
      allowedJobTypes: ['site-detection'],
    });

    expect(result.job).to.equal(job);
    // Ownerless job types never touch the Site table or the access-control layer.
    expect(context.dataAccess.Site.findById).to.not.have.been.called;
  });

  it('skips the ownership check when the resolver returns no siteId', async () => {
    const context = makeContext();
    const job = makeJob({ jobType: 'site-detection', payload: {} });
    context.dataAccess.AsyncJob.findById.resolves(job);

    const result = await loadJobScopedToCaller(context, {
      jobId,
      allowedJobTypes: ['site-detection'],
      resolveOwnerSiteId: (j) => j.getMetadata().payload.siteId, // undefined
    });

    expect(result.job).to.equal(job);
    expect(context.dataAccess.Site.findById).to.not.have.been.called;
  });
});
