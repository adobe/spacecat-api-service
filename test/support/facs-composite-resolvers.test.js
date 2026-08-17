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

  it('opportunity LIST route defers to the controller', async () => {
    const res = await mod.asoOpportunityComposite(context, {
      ...baseArgs, routePattern: 'GET /sites/:siteId/opportunities', routeParams: { siteId: 'site-1' },
    });
    expect(res).to.equal('defer');
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

  it('exposes asoOpportunityComposite in the compositeResolvers registry', () => {
    expect(mod.compositeResolvers.asoOpportunityComposite).to.equal(mod.asoOpportunityComposite);
  });
});
