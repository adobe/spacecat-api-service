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

import { expect } from 'chai';
import sinon from 'sinon';

import { ensureMarketSite, SERENITY_BRAND_SITE_TYPE } from '../../../src/support/serenity/site-linkage.js';

const ORG = 'org-1';
const BRAND = 'brand-1';

function siteModel(id, org = ORG) {
  return { getId: () => id, getOrganizationId: () => org };
}

describe('serenity site-linkage: ensureMarketSite', () => {
  let upsertStub;
  let fromStub;
  let postgrestClient;
  let Site;
  let log;
  let ctx;

  beforeEach(() => {
    upsertStub = sinon.stub().resolves({ error: null });
    fromStub = sinon.stub().returns({ upsert: upsertStub });
    postgrestClient = { from: fromStub };
    Site = { findByBaseURL: sinon.stub(), create: sinon.stub() };
    log = { warn: sinon.spy(), error: sinon.spy() };
    ctx = { dataAccess: { Site, services: { postgrestClient } } };
  });

  afterEach(() => sinon.restore());

  it('no-ops (returns null) when domain, organizationId, or brandId is missing', async () => {
    expect(await ensureMarketSite(ctx, { organizationId: ORG, brandId: BRAND, domain: '' })).to.equal(null);
    expect(await ensureMarketSite(ctx, { organizationId: '', brandId: BRAND, domain: 'x.com' })).to.equal(null);
    expect(await ensureMarketSite(ctx, { organizationId: ORG, brandId: '', domain: 'x.com' })).to.equal(null);
    expect(await ensureMarketSite(ctx, {})).to.equal(null);
    expect(Site.findByBaseURL).to.not.have.been.called;
  });

  it('warns and returns null when Site data-access is unavailable', async () => {
    ctx.dataAccess.Site = {}; // no findByBaseURL
    const result = await ensureMarketSite(ctx, {
      organizationId: ORG, brandId: BRAND, domain: 'acme.com', log,
    });
    expect(result).to.equal(null);
    expect(log.warn).to.have.been.calledOnce;
  });

  it('links an existing same-org site without creating a new one', async () => {
    Site.findByBaseURL.resolves(siteModel('site-9'));
    const result = await ensureMarketSite(ctx, {
      organizationId: ORG, brandId: BRAND, domain: 'acme.com', updatedBy: 'tester', log,
    });
    expect(result).to.equal('site-9');
    expect(Site.findByBaseURL).to.have.been.calledOnceWith('https://acme.com');
    expect(Site.create).to.not.have.been.called;
    expect(fromStub).to.have.been.calledOnceWith('brand_sites');
    const [row, opts] = upsertStub.firstCall.args;
    expect(row).to.deep.equal({
      organization_id: ORG,
      brand_id: BRAND,
      site_id: 'site-9',
      paths: ['/'],
      type: SERENITY_BRAND_SITE_TYPE,
      updated_by: 'tester',
    });
    expect(SERENITY_BRAND_SITE_TYPE).to.equal('serenity');
    expect(opts).to.deep.equal({ onConflict: 'brand_id,site_id' });
  });

  it('creates the site (deliveryType other) when none exists, then links it', async () => {
    Site.findByBaseURL.resolves(null);
    Site.create.resolves(siteModel('site-new'));
    const result = await ensureMarketSite(ctx, {
      organizationId: ORG, brandId: BRAND, domain: 'acme.com', log,
    });
    expect(result).to.equal('site-new');
    expect(Site.create).to.have.been.calledOnceWith({
      baseURL: 'https://acme.com', organizationId: ORG, deliveryType: 'other',
    });
    expect(upsertStub).to.have.been.calledOnce;
    // default audit actor
    expect(upsertStub.firstCall.args[0].updated_by).to.equal('serenity-market');
  });

  it('returns null (no link) when an existing site belongs to another org', async () => {
    Site.findByBaseURL.resolves(siteModel('site-other', 'org-2'));
    const result = await ensureMarketSite(ctx, {
      organizationId: ORG, brandId: BRAND, domain: 'acme.com', log,
    });
    // Site exists but no brand_sites link was written → null, not the site id.
    expect(result).to.equal(null);
    expect(fromStub).to.not.have.been.called;
    expect(log.warn).to.have.been.calledOnce;
  });

  it('treats a brand_sites upsert error as non-fatal and still returns the site id', async () => {
    Site.findByBaseURL.resolves(siteModel('site-9'));
    upsertStub.resolves({ error: { message: 'conflict' } });
    const result = await ensureMarketSite(ctx, {
      organizationId: ORG, brandId: BRAND, domain: 'acme.com', log,
    });
    expect(result).to.equal('site-9');
    expect(log.warn).to.have.been.calledOnce;
  });

  it('returns the site id without linking when no postgrest client is available', async () => {
    ctx.dataAccess.services = {}; // no postgrestClient
    Site.findByBaseURL.resolves(siteModel('site-9'));
    const result = await ensureMarketSite(ctx, {
      organizationId: ORG, brandId: BRAND, domain: 'acme.com', log,
    });
    expect(result).to.equal('site-9');
  });

  it('swallows a Site.create failure (returns null, logs error)', async () => {
    Site.findByBaseURL.resolves(null);
    Site.create.rejects(new Error('db down'));
    const result = await ensureMarketSite(ctx, {
      organizationId: ORG, brandId: BRAND, domain: 'acme.com', log,
    });
    expect(result).to.equal(null);
    expect(log.error).to.have.been.calledOnce;
  });

  it('swallows a Site.findByBaseURL rejection (returns null, logs error)', async () => {
    Site.findByBaseURL.rejects(new Error('timeout'));
    const result = await ensureMarketSite(ctx, {
      organizationId: ORG, brandId: BRAND, domain: 'acme.com', log,
    });
    expect(result).to.equal(null);
    expect(log.error).to.have.been.calledOnce;
  });

  it('normalizes a full URL (scheme + path) to the hostname base URL', async () => {
    Site.findByBaseURL.resolves(siteModel('site-9'));
    const result = await ensureMarketSite(ctx, {
      organizationId: ORG, brandId: BRAND, domain: 'https://www.acme.com/markets/fr?x=1', log,
    });
    expect(result).to.equal('site-9');
    // Path/scheme/query/www stripped → same base URL as a bare-hostname caller.
    expect(Site.findByBaseURL).to.have.been.calledOnceWith('https://acme.com');
  });

  it('returns null when the domain does not resolve to a hostname', async () => {
    const result = await ensureMarketSite(ctx, {
      organizationId: ORG, brandId: BRAND, domain: 'http://', log,
    });
    expect(result).to.equal(null);
    expect(Site.findByBaseURL).to.not.have.been.called;
    expect(log.warn).to.have.been.calledOnce;
  });

  it('returns null (does not throw) when ctx is null', async () => {
    const result = await ensureMarketSite(null, {
      organizationId: ORG, brandId: BRAND, domain: 'acme.com', log,
    });
    expect(result).to.equal(null);
    expect(log.warn).to.have.been.calledOnce;
  });
});
