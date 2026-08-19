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

import { propagateSiteUrlToSemrush } from '../../../src/support/serenity/site-url-propagation.js';
import { SerenityTransportError } from '../../../src/support/serenity/rest-transport.js';
import { ERROR_CODES } from '../../../src/support/serenity/errors.js';

use(chaiAsPromised);
use(sinonChai);

const WS = 'ws-1';
const BRAND_ID = 'brand-1';
const SITE_ID = 'site-1';

function fakeRow(projectId, { siteId = SITE_ID, deletedAt = null } = {}) {
  return {
    getSemrushProjectId: sinon.stub().returns(projectId),
    getSiteId: sinon.stub().returns(siteId),
    getDeletedAt: sinon.stub().returns(deletedAt),
  };
}

function dataAccessWithRows(rows) {
  return { BrandSemrushProject: { allByBrandId: sinon.stub().resolves(rows) } };
}

function makeTransport({ benchmarks = [] } = {}) {
  return {
    updateProject: sinon.stub().resolves({}),
    listBenchmarks: sinon.stub().resolves({ aio_benchmarks: benchmarks }),
    createBenchmarks: sinon.stub().resolves({ ids: [] }),
    updateBenchmark: sinon.stub().resolves(null),
    publishProject: sinon.stub().resolves({}),
  };
}

const BRAND_IDENTITY = { name: 'Acme', aliases: [{ name: 'Acme Inc', regions: [] }] };
const NEW_URL = 'https://site1.com/new-path';

describe('propagateSiteUrlToSemrush', () => {
  afterEach(() => sinon.restore());

  it('returns projectsUpdated: 0 and makes no transport calls when no project is mapped to the site', async () => {
    const transport = makeTransport();
    const log = { warn: sinon.spy() };

    const result = await propagateSiteUrlToSemrush({
      dataAccess: dataAccessWithRows([]),
      transport,
      workspaceId: WS,
      brandId: BRAND_ID,
      siteId: SITE_ID,
      brandIdentity: BRAND_IDENTITY,
      newBaseURL: NEW_URL,
      log,
    });

    expect(result).to.deep.equal({ projectsUpdated: 0 });
    expect(transport.updateProject).to.not.have.been.called;
    expect(log.warn).to.have.been.calledOnce;
  });

  it('re-points primary_url and the own-brand benchmark domain (full body), then republishes', async () => {
    const own = {
      id: 'bench-1', main_brand: true, brand_name: 'Acme', domain: 'site1.com', brand_aliases: ['acme inc'],
    };
    const transport = makeTransport({ benchmarks: [own] });
    const rows = [fakeRow('proj-1')];

    const result = await propagateSiteUrlToSemrush({
      dataAccess: dataAccessWithRows(rows),
      transport,
      workspaceId: WS,
      brandId: BRAND_ID,
      siteId: SITE_ID,
      brandIdentity: BRAND_IDENTITY,
      newBaseURL: NEW_URL,
    });

    expect(result).to.deep.equal({ projectsUpdated: 1 });
    expect(transport.updateProject).to.have.been.calledOnceWith(WS, 'proj-1', {
      type: 'ai',
      primary_url: 'site1.com/new-path',
      domain: 'site1.com',
    });
    expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, 'proj-1', 'bench-1', {
      brand_name: 'Acme',
      domain: 'site1.com',
      // The FULL alias list is carried forward — a field omitted from this PUT is
      // cleared upstream, not preserved (rest-transport.js updateBenchmark JSDoc).
      brand_aliases: ['acme inc'],
    });
    expect(transport.publishProject).to.have.been.calledOnceWith(WS, 'proj-1');
  });

  it('updates every live project mapped to the site (locale variants sharing one domain)', async () => {
    const transport = makeTransport({ benchmarks: [] });
    const rows = [fakeRow('proj-1'), fakeRow('proj-2')];

    const result = await propagateSiteUrlToSemrush({
      dataAccess: dataAccessWithRows(rows),
      transport,
      workspaceId: WS,
      brandId: BRAND_ID,
      siteId: SITE_ID,
      brandIdentity: BRAND_IDENTITY,
      newBaseURL: NEW_URL,
    });

    expect(result).to.deep.equal({ projectsUpdated: 2 });
    expect(transport.updateProject).to.have.been.calledTwice;
    expect(transport.updateProject).to.have.been.calledWith(WS, 'proj-1');
    expect(transport.updateProject).to.have.been.calledWith(WS, 'proj-2');
  });

  it('creates the own-brand benchmark when none exists yet, then updates the newly created one', async () => {
    const transport = makeTransport({ benchmarks: [] });
    transport.createBenchmarks.resolves({ ids: ['bench-new'] });
    transport.listBenchmarks
      .onFirstCall().resolves({ aio_benchmarks: [] })
      .onSecondCall().resolves({
        aio_benchmarks: [{
          id: 'bench-new', brand_name: 'Acme', domain: 'site1.com', brand_aliases: [],
        }],
      });
    const rows = [fakeRow('proj-1')];

    const result = await propagateSiteUrlToSemrush({
      dataAccess: dataAccessWithRows(rows),
      transport,
      workspaceId: WS,
      brandId: BRAND_ID,
      siteId: SITE_ID,
      brandIdentity: BRAND_IDENTITY,
      newBaseURL: NEW_URL,
    });

    expect(result).to.deep.equal({ projectsUpdated: 1 });
    expect(transport.createBenchmarks).to.have.been.calledOnce;
    expect(transport.updateBenchmark).to.have.been.calledOnceWith(WS, 'proj-1', 'bench-new');
  });

  it('propagates a quotaExceeded 409 when republish 405s on quota (SITES-49206), not swallowed', async () => {
    const transport = makeTransport({ benchmarks: [] });
    transport.publishProject.rejects(
      new SerenityTransportError(405, 'publish failed: 405', '<html>405 Not Allowed</html>'),
    );
    const rows = [fakeRow('proj-1')];

    const err = await propagateSiteUrlToSemrush({
      dataAccess: dataAccessWithRows(rows),
      transport,
      workspaceId: WS,
      brandId: BRAND_ID,
      siteId: SITE_ID,
      brandIdentity: BRAND_IDENTITY,
      newBaseURL: NEW_URL,
    }).then(() => null, (e) => e);

    expect(err).to.not.equal(null);
    expect(err.status).to.equal(409);
    expect(err.code).to.equal(ERROR_CODES.QUOTA_EXCEEDED);
  });

  it('propagates a non-quota transport error from updateProject', async () => {
    const transport = makeTransport({ benchmarks: [] });
    transport.updateProject.rejects(new SerenityTransportError(500, 'boom'));
    const rows = [fakeRow('proj-1')];
    const log = { error: sinon.spy() };

    await expect(propagateSiteUrlToSemrush({
      dataAccess: dataAccessWithRows(rows),
      transport,
      workspaceId: WS,
      brandId: BRAND_ID,
      siteId: SITE_ID,
      brandIdentity: BRAND_IDENTITY,
      newBaseURL: NEW_URL,
      log,
    })).to.be.rejectedWith('boom');
    expect(transport.publishProject).to.not.have.been.called;
    expect(log.error).to.have.been.calledOnceWith(
      'site-url-propagation: failed re-pointing a project mid fan-out',
      sinon.match({
        brandId: BRAND_ID, siteId: SITE_ID, projectId: 'proj-1', projectsUpdatedBeforeFailure: 0, totalProjects: 1,
      }),
    );
  });

  it('logs how many projects already succeeded before a mid-fan-out failure on the second project', async () => {
    const transport = makeTransport({ benchmarks: [] });
    transport.updateProject.onFirstCall().resolves({}).onSecondCall().rejects(
      new SerenityTransportError(500, 'boom'),
    );
    const rows = [fakeRow('proj-1'), fakeRow('proj-2')];
    const log = { error: sinon.spy() };

    await expect(propagateSiteUrlToSemrush({
      dataAccess: dataAccessWithRows(rows),
      transport,
      workspaceId: WS,
      brandId: BRAND_ID,
      siteId: SITE_ID,
      brandIdentity: BRAND_IDENTITY,
      newBaseURL: NEW_URL,
      log,
    })).to.be.rejectedWith('boom');
    expect(transport.publishProject).to.have.been.calledOnceWith(WS, 'proj-1');
    expect(log.error).to.have.been.calledOnceWith(
      'site-url-propagation: failed re-pointing a project mid fan-out',
      sinon.match({
        projectId: 'proj-2', projectsUpdatedBeforeFailure: 1, totalProjects: 2,
      }),
    );
  });
});
