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
import esmock from 'esmock';
import { filterOpportunitiesByFacsComposite } from '../../src/support/facs-composite-resolvers.js';

describe('facs-composite-resolvers (asoOpportunityComposite)', () => {
  let sandbox;
  let listStub;
  let oppFindById;
  let mod;
  let context;

  const CAP = 'aso/can_edit';
  const baseArgs = {
    resourceId: 'site-1',
    capability: CAP,
    product: 'ASO',
    subjectId: 'user@example.com',
    orgId: 'CUST-ORG@AdobeOrg',
  };

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    listStub = sandbox.stub().resolves([]);
    oppFindById = sandbox.stub();
    mod = await esmock('../../src/support/facs-composite-resolvers.js', {
      '../../src/support/state-access-mapping-utils.js': { listFacsAccessMappings: listStub },
    });
    context = {
      log: { info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub() },
      dataAccess: {
        services: { postgrestClient: { from: () => {} } },
        Opportunity: { findById: oppFindById },
      },
    };
  });

  afterEach(() => sandbox.restore());

  it('fails closed (false) when the postgrest client is unavailable', async () => {
    context.dataAccess.services.postgrestClient = null;
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'POST /sites/:siteId/reports', routeParams: { siteId: 'site-1' },
    });
    expect(res).to.be.false;
    expect(context.log.warn.calledWithMatch({ tag: 'facs-composite', reason: 'no-postgrest' })).to.be.true;
    expect(listStub.called).to.be.false;
  });

  it('item route: grants on a site-wide (all) binding WITHOUT fetching the opportunity', async () => {
    listStub.resolves([{ composite_key_value_1: 'all', granted_capabilities: [CAP] }]);
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs,
      routePattern: 'PATCH /sites/:siteId/opportunities/:opportunityId',
      routeParams: { siteId: 'site-1', opportunityId: 'opp-1' },
    });
    expect(res).to.be.true;
    expect(oppFindById.called).to.be.false;
  });

  it('item route: grants on a typed binding matching the opportunity type', async () => {
    listStub.resolves([{ composite_key_value_1: 'security', granted_capabilities: [CAP] }]);
    oppFindById.resolves({ getSiteId: () => 'site-1', getType: () => 'security' });
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs,
      routePattern: 'PATCH /sites/:siteId/opportunities/:opportunityId',
      routeParams: { siteId: 'site-1', opportunityId: 'opp-1' },
    });
    expect(res).to.be.true;
    expect(oppFindById.calledOnceWith('opp-1')).to.be.true;
  });

  it('item route: denies when no binding matches the opportunity type', async () => {
    listStub.resolves([{ composite_key_value_1: 'metadata', granted_capabilities: [CAP] }]);
    oppFindById.resolves({ getSiteId: () => 'site-1', getType: () => 'security' });
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs,
      routePattern: 'PATCH /sites/:siteId/opportunities/:opportunityId',
      routeParams: { siteId: 'site-1', opportunityId: 'opp-1' },
    });
    expect(res).to.be.false;
  });

  it('item route: fails closed when the opportunity is not found', async () => {
    listStub.resolves([{ composite_key_value_1: 'security', granted_capabilities: [CAP] }]);
    oppFindById.resolves(null);
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs,
      routePattern: 'PATCH /sites/:siteId/opportunities/:opportunityId',
      routeParams: { siteId: 'site-1', opportunityId: 'opp-x' },
    });
    expect(res).to.be.false;
    expect(context.log.info.calledWithMatch({ tag: 'facs-composite', reason: 'opportunity-not-found' })).to.be.true;
  });

  it('item route: fails closed when the opportunity belongs to a different site', async () => {
    listStub.resolves([{ composite_key_value_1: 'security', granted_capabilities: [CAP] }]);
    oppFindById.resolves({ getSiteId: () => 'site-OTHER', getType: () => 'security' });
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs,
      routePattern: 'PATCH /sites/:siteId/opportunities/:opportunityId',
      routeParams: { siteId: 'site-1', opportunityId: 'opp-1' },
    });
    expect(res).to.be.false;
    expect(context.log.warn.calledWithMatch({ tag: 'facs-composite', reason: 'site-mismatch' })).to.be.true;
  });

  it('opportunity LIST route defers and stashes the caller\'s permitted types', async () => {
    listStub.resolves([{ composite_key_value_1: 'security', granted_capabilities: [CAP] }]);
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'GET /sites/:siteId/opportunities', routeParams: { siteId: 'site-1' },
    });
    expect(res).to.equal('defer');
    expect(context.attributes.facsComposite).to.deep.equal({
      product: 'ASO', resourceType: 'site', values: ['security'],
    });
  });

  it('LIST route stashes the WILDCARD sentinel for a site-wide binding', async () => {
    listStub.resolves([
      { composite_key_value_1: 'security', granted_capabilities: [CAP] },
      { composite_key_value_1: 'all', granted_capabilities: [CAP] },
    ]);
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'GET /sites/:siteId/opportunities', routeParams: { siteId: 'site-1' },
    });
    expect(res).to.equal('defer');
    expect(context.attributes.facsComposite.values).to.equal('all');
  });

  it('by-status LIST route defers and stashes permitted types', async () => {
    listStub.resolves([{ composite_key_value_1: 'security', granted_capabilities: [CAP] }]);
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs,
      routePattern: 'GET /sites/:siteId/opportunities/by-status/:status',
      routeParams: { siteId: 'site-1', status: 'NEW' },
    });
    expect(res).to.equal('defer');
    expect(context.attributes.facsComposite.values).to.deep.equal(['security']);
  });

  it('top-paid LIST route defers and stashes permitted types', async () => {
    listStub.resolves([{ composite_key_value_1: 'security', granted_capabilities: [CAP] }]);
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs,
      routePattern: 'GET /sites/:siteId/opportunities/top-paid',
      routeParams: { siteId: 'site-1' },
    });
    expect(res).to.equal('defer');
    expect(context.attributes.facsComposite.values).to.deep.equal(['security']);
  });

  it('site fixes collection defers and stashes permitted types (D4)', async () => {
    listStub.resolves([{ composite_key_value_1: 'security', granted_capabilities: [CAP] }]);
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'GET /sites/:siteId/fixes', routeParams: { siteId: 'site-1' },
    });
    expect(res).to.equal('defer');
    expect(context.attributes.facsComposite.values).to.deep.equal(['security']);
  });

  it('edge-deployed-urls collection defers and stashes permitted types (D4)', async () => {
    listStub.resolves([{ composite_key_value_1: 'security', granted_capabilities: [CAP] }]);
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'GET /sites/:siteId/edge-deployed-urls', routeParams: { siteId: 'site-1' },
    });
    expect(res).to.equal('defer');
    expect(context.attributes.facsComposite.values).to.deep.equal(['security']);
  });

  it('opportunity CREATE: grants when a binding matches the body opportunity type', async () => {
    listStub.resolves([{ composite_key_value_1: 'security', granted_capabilities: [CAP] }]);
    context.data = { type: 'security' };
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'POST /sites/:siteId/opportunities', routeParams: { siteId: 'site-1' },
    });
    expect(res).to.be.true;
  });

  it('opportunity CREATE: denies when the body type is not a permitted type', async () => {
    listStub.resolves([{ composite_key_value_1: 'security', granted_capabilities: [CAP] }]);
    context.data = { type: 'meta-tags' };
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'POST /sites/:siteId/opportunities', routeParams: { siteId: 'site-1' },
    });
    expect(res).to.be.false;
  });

  it('opportunity CREATE: a site-wide (all) binding grants any body type', async () => {
    listStub.resolves([{ composite_key_value_1: 'all', granted_capabilities: [CAP] }]);
    context.data = { type: 'meta-tags' };
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'POST /sites/:siteId/opportunities', routeParams: { siteId: 'site-1' },
    });
    expect(res).to.be.true;
  });

  it('opportunity CREATE: a missing body type grants only on a site-wide (all) binding', async () => {
    listStub.resolves([{ composite_key_value_1: 'security', granted_capabilities: [CAP] }]);
    context.data = {};
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'POST /sites/:siteId/opportunities', routeParams: { siteId: 'site-1' },
    });
    expect(res).to.be.false;
  });

  it('non-opportunity route: grants on ANY active site binding with the capability', async () => {
    listStub.resolves([{ composite_key_value_1: 'security', granted_capabilities: [CAP] }]);
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'POST /sites/:siteId/reports', routeParams: { siteId: 'site-1' },
    });
    expect(res).to.be.true;
    expect(oppFindById.called).to.be.false;
  });

  it('non-opportunity route: denies when no binding carries the capability', async () => {
    listStub.resolves([{ composite_key_value_1: 'security', granted_capabilities: ['aso/can_view'] }]);
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'POST /sites/:siteId/url-store', routeParams: { siteId: 'site-1' },
    });
    expect(res).to.be.false;
  });

  it('treats a missing/non-string routePattern as a non-opportunity route', async () => {
    listStub.resolves([{ composite_key_value_1: 'all', granted_capabilities: [CAP] }]);
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: undefined, routeParams: { siteId: 'site-1' },
    });
    expect(res).to.be.true;
  });

  it('queries both org and user scopes (deduped by subject)', async () => {
    await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'POST /sites/:siteId/reports', routeParams: { siteId: 'site-1' },
    });
    expect(listStub.callCount).to.equal(2);
    const scopes = listStub.getCalls().map((c) => c.args[1].subjectType);
    expect(scopes).to.have.members(['org', 'user']);
  });

  it('queries only the org scope when there is no subjectId', async () => {
    await mod.asoOpportunityComposite(context, {
      ...baseArgs, subjectId: undefined, routePattern: 'POST /sites/:siteId/reports', routeParams: { siteId: 'site-1' },
    });
    expect(listStub.callCount).to.equal(1);
    expect(listStub.firstCall.args[1].subjectType).to.equal('org');
  });

  it('tolerates a binding with no granted_capabilities array', async () => {
    listStub.resolves([{ composite_key_value_1: 'all' }]);
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'POST /sites/:siteId/reports', routeParams: { siteId: 'site-1' },
    });
    expect(res).to.be.false;
  });

  it('logs a cap-hit warning when a scope returns a full page (possible under-grant)', async () => {
    // A page filled to the cap may have dropped overflow bindings (fail-safe
    // under-grant); it must be detectable in logs, not silent.
    listStub.resolves(Array.from({ length: 500 }, () => ({
      composite_key_value_1: 'all', granted_capabilities: [CAP],
    })));
    await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'POST /sites/:siteId/reports', routeParams: { siteId: 'site-1' },
    });
    expect(context.log.warn.calledWithMatch({
      tag: 'facs-composite', reason: 'bindings-cap-hit',
    })).to.be.true;
  });

  it('does not log a cap-hit warning for a normal (under-cap) result', async () => {
    listStub.resolves([{ composite_key_value_1: 'all', granted_capabilities: [CAP] }]);
    await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'POST /sites/:siteId/reports', routeParams: { siteId: 'site-1' },
    });
    expect(context.log.warn.calledWithMatch({ reason: 'bindings-cap-hit' })).to.be.false;
  });

  it('propagates a state-layer read error (the wrapper treats a throw as deny)', async () => {
    listStub.rejects(new Error('postgrest down'));
    let threw;
    try {
      await mod.asoOpportunityComposite(context, {
        ...baseArgs, routePattern: 'POST /sites/:siteId/reports', routeParams: { siteId: 'site-1' },
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).to.be.an('error').with.property('message', 'postgrest down');
  });

  it('propagates an Opportunity.findById error on the typed item path (fail-closed)', async () => {
    listStub.resolves([{ composite_key_value_1: 'security', granted_capabilities: [CAP] }]);
    oppFindById.rejects(new Error('opp lookup failed'));
    let threw;
    try {
      await mod.asoOpportunityComposite(context, {
        ...baseArgs,
        routePattern: 'PATCH /sites/:siteId/opportunities/:opportunityId',
        routeParams: { siteId: 'site-1', opportunityId: 'opp-1' },
      });
    } catch (e) {
      threw = e;
    }
    expect(threw).to.be.an('error').with.property('message', 'opp lookup failed');
  });

  it('exposes asoOpportunityComposite in the compositeResolvers registry', () => {
    expect(mod.compositeResolvers.asoOpportunityComposite).to.equal(mod.asoOpportunityComposite);
  });
});

describe('filterOpportunitiesByFacsComposite (D4 list filter)', () => {
  const opp = (type) => ({ getType: () => type });

  it('returns the list unchanged when no facsComposite marker is set (non-FACS path)', () => {
    const list = [opp('security'), opp('alt-text')];
    expect(filterOpportunitiesByFacsComposite({ attributes: {} }, list)).to.equal(list);
  });

  it('fails closed (empty) when FACS governs the request but no marker was produced', () => {
    // Wrapper deferred (facs.enabled) but the composite resolver set no permitted
    // values — e.g. an uncovered opportunity-collection route. Must not leak the list.
    const ctx = { attributes: { facs: { enabled: true } } };
    expect(filterOpportunitiesByFacsComposite(ctx, [opp('security')])).to.deep.equal([]);
  });

  it('returns the list unchanged for a WILDCARD (all) grant', () => {
    const list = [opp('security'), opp('alt-text')];
    const ctx = { attributes: { facsComposite: { values: 'all' } } };
    expect(filterOpportunitiesByFacsComposite(ctx, list)).to.equal(list);
  });

  it('narrows to the permitted types', () => {
    const list = [opp('security'), opp('alt-text'), opp('meta-tags')];
    const ctx = { attributes: { facsComposite: { values: ['security', 'meta-tags'] } } };
    const out = filterOpportunitiesByFacsComposite(ctx, list);
    expect(out.map((o) => o.getType())).to.deep.equal(['security', 'meta-tags']);
  });

  it('returns an empty list when the permitted set is empty', () => {
    const ctx = { attributes: { facsComposite: { values: [] } } };
    expect(filterOpportunitiesByFacsComposite(ctx, [opp('security')])).to.deep.equal([]);
  });
});
