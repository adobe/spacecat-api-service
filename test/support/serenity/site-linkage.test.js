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

import {
  ensureMarketSite,
  resolveSiteDomain,
  unlinkMarketSiteIfOrphaned,
  SERENITY_BRAND_SITE_TYPE,
} from '../../../src/support/serenity/site-linkage.js';

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
    Site = { findByBaseURL: sinon.stub(), findById: sinon.stub(), create: sinon.stub() };
    log = { warn: sinon.spy(), error: sinon.spy(), info: sinon.spy() };
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

  it('treats a brand_sites upsert error as non-fatal but returns null (link not established)', async () => {
    Site.findByBaseURL.resolves(siteModel('site-9'));
    upsertStub.resolves({ error: { message: 'conflict' } });
    const result = await ensureMarketSite(ctx, {
      organizationId: ORG, brandId: BRAND, domain: 'acme.com', log,
    });
    // Non-null means "linked"; a failed link write returns null.
    expect(result).to.equal(null);
    expect(log.warn).to.have.been.calledOnce;
  });

  it('logs the SERENITY_MARKET_LINK_REJECTED alert token on a CHECK-constraint violation (migration not deployed)', async () => {
    Site.findByBaseURL.resolves(siteModel('site-9'));
    // Postgres 23514 = check_violation → the brand_sites.type='serenity'
    // migration is not deployed in this env (a persistent, alertable condition).
    upsertStub.resolves({ error: { code: '23514', message: 'violates check constraint "brand_sites_type_check"' } });
    const result = await ensureMarketSite(ctx, {
      organizationId: ORG, brandId: BRAND, domain: 'acme.com', log,
    });
    expect(result).to.equal(null);
    // Distinct ERROR token (not a bare warn) so on-call can tell migration-missing
    // from a transient blip.
    expect(log.warn).to.not.have.been.called;
    expect(log.error).to.have.been.calledWithMatch('SERENITY_MARKET_LINK_REJECTED');
  });

  it('returns null (site ensured, not linked) when no postgrest client is available', async () => {
    ctx.dataAccess.services = {}; // no postgrestClient
    Site.findByBaseURL.resolves(siteModel('site-9'));
    const result = await ensureMarketSite(ctx, {
      organizationId: ORG, brandId: BRAND, domain: 'acme.com', log,
    });
    expect(result).to.equal(null);
    expect(log.warn).to.have.been.calledOnce;
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

  it('refuses to mirror a non-public hostname (SSRF guard) without creating a Site', async () => {
    // Internal/private hosts must never become a Site base_url (downstream
    // workers fetch Sites). Each is skipped (null) before any Site write.
    const internalHosts = [
      'localhost',
      'http://127.0.0.1/x',
      '169.254.169.254',
      '10.0.0.5',
      'http://192.168.1.10:8080',
      'metadata',
      'db.internal',
    ];
    for (const domain of internalHosts) {
      // eslint-disable-next-line no-await-in-loop
      const result = await ensureMarketSite(ctx, {
        organizationId: ORG, brandId: BRAND, domain, log,
      });
      expect(result, `expected ${domain} to be refused`).to.equal(null);
    }
    expect(Site.findByBaseURL).to.not.have.been.called;
    expect(Site.create).to.not.have.been.called;
    expect(fromStub).to.not.have.been.called;
    expect(log.warn.callCount).to.equal(internalHosts.length);
  });

  it('returns null (does not throw) when ctx is null', async () => {
    const result = await ensureMarketSite(null, {
      organizationId: ORG, brandId: BRAND, domain: 'acme.com', log,
    });
    expect(result).to.equal(null);
    expect(log.warn).to.have.been.calledOnce;
  });

  describe('siteId fast path (LLMO-6405)', () => {
    it('links a known same-org site directly, skipping the domain find-or-create', async () => {
      Site.findById.resolves(siteModel('site-known'));
      const result = await ensureMarketSite(ctx, {
        organizationId: ORG, brandId: BRAND, siteId: 'site-known', updatedBy: 'tester', log,
      });
      expect(result).to.equal('site-known');
      expect(Site.findById).to.have.been.calledOnceWith('site-known');
      expect(Site.findByBaseURL).to.not.have.been.called;
      expect(Site.create).to.not.have.been.called;
      const [row] = upsertStub.firstCall.args;
      expect(row).to.include({ site_id: 'site-known', type: SERENITY_BRAND_SITE_TYPE, brand_id: BRAND });
    });

    it('takes precedence over domain (ignores domain when siteId is present)', async () => {
      Site.findById.resolves(siteModel('site-known'));
      const result = await ensureMarketSite(ctx, {
        organizationId: ORG, brandId: BRAND, siteId: 'site-known', domain: 'other.com', log,
      });
      expect(result).to.equal('site-known');
      expect(Site.findByBaseURL).to.not.have.been.called;
    });

    it('warns + null when Site.findById is unavailable', async () => {
      ctx.dataAccess.Site = { findByBaseURL: sinon.stub() }; // no findById
      const result = await ensureMarketSite(ctx, {
        organizationId: ORG, brandId: BRAND, siteId: 'site-x', log,
      });
      expect(result).to.equal(null);
      expect(log.warn).to.have.been.calledOnce;
    });

    it('warns + null when the supplied site is not found', async () => {
      Site.findById.resolves(null);
      const result = await ensureMarketSite(ctx, {
        organizationId: ORG, brandId: BRAND, siteId: 'site-missing', log,
      });
      expect(result).to.equal(null);
      expect(log.warn).to.have.been.calledOnce;
      expect(upsertStub).to.not.have.been.called;
    });

    it('warns + null (no link) when the supplied site belongs to another org', async () => {
      Site.findById.resolves(siteModel('site-x', 'org-2'));
      const result = await ensureMarketSite(ctx, {
        organizationId: ORG, brandId: BRAND, siteId: 'site-x', log,
      });
      expect(result).to.equal(null);
      expect(upsertStub).to.not.have.been.called;
      expect(log.warn).to.have.been.calledOnce;
    });

    it('swallows a Site.findById rejection (null, logs error)', async () => {
      Site.findById.rejects(new Error('timeout'));
      const result = await ensureMarketSite(ctx, {
        organizationId: ORG, brandId: BRAND, siteId: 'site-x', log,
      });
      expect(result).to.equal(null);
      expect(log.error).to.have.been.calledOnce;
    });

    it('returns null (link not written) when the brand_sites upsert errors on the siteId path', async () => {
      Site.findById.resolves(siteModel('site-known'));
      upsertStub.resolves({ error: { message: 'conflict' } });
      const result = await ensureMarketSite(ctx, {
        organizationId: ORG, brandId: BRAND, siteId: 'site-known', log,
      });
      expect(result).to.equal(null);
      expect(log.warn).to.have.been.calledOnce;
    });
  });
});

describe('serenity site-linkage: resolveSiteDomain', () => {
  let Site;
  let log;
  let dataAccess;

  beforeEach(() => {
    Site = { findById: sinon.stub() };
    log = { warn: sinon.spy(), error: sinon.spy() };
    dataAccess = { Site };
  });

  afterEach(() => sinon.restore());

  it('resolves a site id to its bare hostname (strips scheme/path)', async () => {
    Site.findById.resolves({ getBaseURL: () => 'https://www.acme.com/markets/fr' });
    const result = await resolveSiteDomain(dataAccess, 'site-1', log);
    expect(result).to.equal('www.acme.com');
    expect(Site.findById).to.have.been.calledOnceWith('site-1');
  });

  it('returns null for missing siteId', async () => {
    expect(await resolveSiteDomain(dataAccess, '', log)).to.equal(null);
    expect(await resolveSiteDomain(dataAccess, null, log)).to.equal(null);
    expect(Site.findById).to.not.have.been.called;
  });

  it('warns + null when Site data-access is unavailable', async () => {
    const result = await resolveSiteDomain({ Site: {} }, 'site-1', log);
    expect(result).to.equal(null);
    expect(log.warn).to.have.been.calledOnce;
  });

  it('warns + null when the site is not found', async () => {
    Site.findById.resolves(null);
    const result = await resolveSiteDomain(dataAccess, 'site-missing', log);
    expect(result).to.equal(null);
    expect(log.warn).to.have.been.calledOnce;
  });

  it('swallows a lookup rejection (null, logs warn)', async () => {
    Site.findById.rejects(new Error('timeout'));
    const result = await resolveSiteDomain(dataAccess, 'site-1', log);
    expect(result).to.equal(null);
    expect(log.warn).to.have.been.calledOnce;
  });
});

describe('serenity site-linkage: unlinkMarketSiteIfOrphaned', () => {
  let deleteEq;
  let fromStub;
  let postgrestClient;
  let allByBrandId;
  let log;
  let ctx;

  // Chainable brand_sites delete: .delete().eq().eq().eq() → awaitable { error }.
  function makeDeleteChain(result = { error: null }) {
    const chain = {};
    chain.eq = sinon.stub().returns(chain);
    chain.then = (resolve) => resolve(result);
    return chain;
  }

  function row({ siteId, deletedAt = null }) {
    return { getSiteId: () => siteId, getDeletedAt: () => deletedAt };
  }

  beforeEach(() => {
    const chain = makeDeleteChain();
    deleteEq = chain.eq;
    fromStub = sinon.stub().returns({ delete: sinon.stub().returns(chain) });
    postgrestClient = { from: fromStub };
    allByBrandId = sinon.stub();
    log = { warn: sinon.spy(), error: sinon.spy(), info: sinon.spy() };
    ctx = { dataAccess: { BrandSemrushProject: { allByBrandId }, services: { postgrestClient } } };
  });

  afterEach(() => sinon.restore());

  it('removes the link when the deleted market was the LAST live one on the site', async () => {
    // Only a tombstoned row remains for this site → zero live references.
    allByBrandId.resolves([row({ siteId: 'site-x', deletedAt: '2026-01-01T00:00:00Z' })]);
    const removed = await unlinkMarketSiteIfOrphaned(ctx, { brandId: BRAND, siteId: 'site-x', primarySiteId: 'primary-1' }, log);
    expect(removed).to.equal(true);
    expect(fromStub).to.have.been.calledOnceWith('brand_sites');
    // brand_id, site_id, type='serenity'
    expect(deleteEq).to.have.been.calledWith('brand_id', BRAND);
    expect(deleteEq).to.have.been.calledWith('site_id', 'site-x');
    expect(deleteEq).to.have.been.calledWith('type', SERENITY_BRAND_SITE_TYPE);
    expect(log.info).to.have.been.calledOnce;
  });

  it('keeps the link when another LIVE market still shares the site', async () => {
    allByBrandId.resolves([row({ siteId: 'site-x' })]); // a live row still points at it
    const removed = await unlinkMarketSiteIfOrphaned(ctx, { brandId: BRAND, siteId: 'site-x', primarySiteId: 'primary-1' }, log);
    expect(removed).to.equal(false);
    expect(fromStub).to.not.have.been.called;
  });

  it('never unlinks the brand PRIMARY site', async () => {
    const removed = await unlinkMarketSiteIfOrphaned(ctx, { brandId: BRAND, siteId: 'primary-1', primarySiteId: 'primary-1' }, log);
    expect(removed).to.equal(false);
    expect(allByBrandId).to.not.have.been.called;
    expect(fromStub).to.not.have.been.called;
  });

  it('no-ops (false) when siteId or brandId is missing', async () => {
    expect(await unlinkMarketSiteIfOrphaned(ctx, { brandId: BRAND, siteId: '' }, log)).to.equal(false);
    expect(await unlinkMarketSiteIfOrphaned(ctx, { brandId: '', siteId: 'site-x' }, log)).to.equal(false);
    expect(await unlinkMarketSiteIfOrphaned(ctx, undefined, log)).to.equal(false);
    expect(fromStub).to.not.have.been.called;
  });

  it('no-ops (false) when data-access or postgrest client is unavailable', async () => {
    const noModel = { dataAccess: { services: { postgrestClient } } };
    expect(await unlinkMarketSiteIfOrphaned(noModel, { brandId: BRAND, siteId: 'site-x' }, log)).to.equal(false);
    const noClient = { dataAccess: { BrandSemrushProject: { allByBrandId }, services: {} } };
    expect(await unlinkMarketSiteIfOrphaned(noClient, { brandId: BRAND, siteId: 'site-x' }, log)).to.equal(false);
  });

  it('returns false + warns when the delete write errors', async () => {
    allByBrandId.resolves([]);
    const chain = makeDeleteChain({ error: { message: 'boom' } });
    fromStub.returns({ delete: sinon.stub().returns(chain) });
    const removed = await unlinkMarketSiteIfOrphaned(ctx, { brandId: BRAND, siteId: 'site-x', primarySiteId: null }, log);
    expect(removed).to.equal(false);
    expect(log.warn).to.have.been.calledWithMatch('SERENITY_MARKET_UNLINK_FAILED');
  });

  it('returns false + logs (never throws) when the reference-count read throws', async () => {
    allByBrandId.rejects(new Error('db down'));
    const removed = await unlinkMarketSiteIfOrphaned(ctx, { brandId: BRAND, siteId: 'site-x', primarySiteId: null }, log);
    expect(removed).to.equal(false);
    expect(log.error).to.have.been.calledWithMatch('SERENITY_MARKET_UNLINK_FAILED');
  });
});
