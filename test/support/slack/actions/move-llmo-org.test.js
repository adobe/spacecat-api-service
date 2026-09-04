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
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('move-llmo-org action', () => {
  let sandbox;
  let lambdaContext;
  let siteStub;
  let organizationStub;
  let rpcStub;
  let site;
  let client;
  let ack;
  let body;
  let createEntitlementAndEnrollmentStub;
  let reparentSiteProjectStub;
  let openMoveLlmoOrgModal;

  const IMS_ORG = 'ABCDEF1234567890ABCDEF12@AdobeOrg';

  const preview = (overrides = {}) => ({
    ok: true,
    source: { id: 'src-1', name: 'Source Org', ims_org_id: '111111111111111111111111@AdobeOrg' },
    destination: { id: 'dst-1', name: 'Dest Org', ims_org_id: IMS_ORG },
    seed_site_id: 'site-1',
    blocking_conflicts: [],
    taxonomy: {
      categories_reused: 0,
      categories_copied: 0,
      topics_reused: 0,
      topics_copied: 0,
      org_feature_flags_copied: 0,
    },
    brands: [{
      id: 'b1', name: 'Acme', status: 'active', site_id: 'site-1',
    }],
    sites: [{ id: 'site-1', base_url: 'https://acme.com', is_seed: true }],
    counts: { brands: 1 },
    ...overrides,
  });

  const moveResult = {
    ok: true,
    source: 'src-1',
    destination: 'dst-1',
    brands_moved: 1,
    sites_moved: 1,
    prompts_moved: 9,
    brand_feature_flags_moved: 2,
  };

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    site = {
      getId: sandbox.stub().returns('site-1'),
      getOrganizationId: sandbox.stub().returns('src-1'),
      getBaseURL: sandbox.stub().returns('https://acme.com'),
      save: sandbox.stub().resolves(),
    };

    siteStub = { findById: sandbox.stub().resolves(site) };
    organizationStub = { findById: sandbox.stub().resolves({ getId: () => 'dst-1' }) };

    rpcStub = sandbox.stub().callsFake((fn) => {
      if (fn === 'rpc_org_move_preview') {
        return Promise.resolve({ data: preview(), error: null });
      }
      return Promise.resolve({ data: moveResult, error: null });
    });

    createEntitlementAndEnrollmentStub = sandbox.stub().resolves({});
    reparentSiteProjectStub = sandbox.stub().resolves();

    ({ openMoveLlmoOrgModal } = await esmock('../../../../src/support/slack/actions/move-llmo-org.js', {
      '../../../../src/controllers/llmo/llmo-onboarding.js': {
        createEntitlementAndEnrollment: createEntitlementAndEnrollmentStub,
      },
      '../../../../src/support/slack/actions/set-ims-org-modal.js': {
        reparentSiteProject: reparentSiteProjectStub,
      },
    }));

    lambdaContext = {
      dataAccess: {
        Site: siteStub,
        Organization: organizationStub,
        services: { postgrestClient: { rpc: rpcStub } },
      },
      log: { info: sandbox.spy(), warn: sandbox.spy(), error: sandbox.spy() },
    };

    ack = sandbox.stub().resolves();
    client = {
      chat: {
        update: sandbox.stub().resolves(),
        postMessage: sandbox.stub().resolves(),
      },
    };
    body = {
      user: { id: 'U123' },
      actions: [{
        value: JSON.stringify({
          baseURL: 'https://acme.com',
          siteId: 'site-1',
          sourceOrgId: 'src-1',
          destOrgId: 'dst-1',
          imsOrgId: IMS_ORG,
          channelId: 'C1',
          threadTs: 'T1',
          messageTs: 'M1',
        }),
      }],
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  const run = () => openMoveLlmoOrgModal(lambdaContext)({ ack, body, client });

  const lastUpdateText = () => client.chat.update.lastCall.args[0].text;

  it('acknowledges the interaction immediately', async () => {
    await run();
    expect(ack).to.have.been.calledOnce;
  });

  it('performs the move and provisions entitlement on the destination org', async () => {
    await run();

    expect(rpcStub).to.have.been.calledWith('wrpc_move_brandalf_org', {
      p_site_id: 'site-1',
      p_dst_org: 'dst-1',
      p_updated_by: 'slack:move-llmo-org:U123',
    });
    expect(reparentSiteProjectStub).to.have.been.calledOnce;
    expect(createEntitlementAndEnrollmentStub).to.have.been.calledOnce;
    expect(lastUpdateText()).to.contain('Moved LLMO organization');
  });

  it('re-reads the site after the move so entitlements target the new org', async () => {
    await run();

    // Once for the pre-flight check, once after the RPC rewrote sites.organization_id.
    expect(siteStub.findById).to.have.been.calledTwice;
    const entitlementSite = createEntitlementAndEnrollmentStub.firstCall.args[0];
    expect(entitlementSite).to.equal(site);
  });

  it('re-previews before writing so a newly-introduced conflict is caught', async () => {
    await run();
    expect(rpcStub.firstCall.args[0]).to.equal('rpc_org_move_preview');
  });

  it('aborts when the site no longer exists', async () => {
    siteStub.findById.resolves(null);
    await run();

    expect(lastUpdateText()).to.contain('no longer exists');
    expect(rpcStub).to.not.have.been.called;
  });

  it('aborts when the destination org no longer exists', async () => {
    organizationStub.findById.resolves(null);
    await run();

    expect(lastUpdateText()).to.contain('no longer exists');
    expect(rpcStub).to.not.have.been.called;
  });

  it('aborts when the site was moved by someone else since the preview', async () => {
    site.getOrganizationId.returns('somewhere-else');
    await run();

    expect(lastUpdateText()).to.contain('no longer in the organization');
    expect(rpcStub).to.not.have.been.called;
  });

  it('aborts when the re-preview is unevaluable', async () => {
    rpcStub.callsFake(() => Promise.resolve({ data: { error: 'same_org' }, error: null }));
    await run();

    expect(lastUpdateText()).to.contain('already in that organization');
    expect(rpcStub).to.have.been.calledOnce;
  });

  it('aborts when a blocking conflict appeared after the preview', async () => {
    rpcStub.callsFake(() => Promise.resolve({
      data: preview({ ok: false, blocking_conflicts: [{ type: 'brand_name', detail: 'Acme' }] }),
      error: null,
    }));

    await run();

    expect(lastUpdateText()).to.contain('now blocked');
    expect(lastUpdateText()).to.contain('Acme');
    // Only the preview ran; the write RPC was never reached.
    expect(rpcStub).to.have.been.calledOnce;
  });

  it('reports a failure from the write RPC', async () => {
    rpcStub.callsFake((fn) => {
      if (fn === 'rpc_org_move_preview') {
        return Promise.resolve({ data: preview(), error: null });
      }
      return Promise.resolve({ data: null, error: { message: 'deadlock' } });
    });

    await run();

    expect(lastUpdateText()).to.contain('Failed to move LLMO org');
    expect(lastUpdateText()).to.contain('deadlock');
    expect(lambdaContext.log.error).to.have.been.called;
    expect(createEntitlementAndEnrollmentStub).to.not.have.been.called;
  });

  it('reports a per-site follow-up failure without losing the successful move', async () => {
    createEntitlementAndEnrollmentStub.rejects(new Error('tier unavailable'));

    await run();

    expect(lastUpdateText()).to.contain('Moved LLMO organization');
    expect(lastUpdateText()).to.contain('post-move setup failed');
    expect(lastUpdateText()).to.contain('tier unavailable');
    expect(lambdaContext.log.error).to.have.been.called;
  });

  it('runs the follow-up for every site the closure moved, not just the seed', async () => {
    const siteB = {
      getId: sandbox.stub().returns('site-2'),
      getBaseURL: sandbox.stub().returns('https://acme.co.uk'),
      save: sandbox.stub().resolves(),
    };
    rpcStub.callsFake((fn) => {
      if (fn === 'rpc_org_move_preview') {
        return Promise.resolve({
          data: preview({
            sites: [
              { id: 'site-1', base_url: 'https://acme.com', is_seed: true },
              { id: 'site-2', base_url: 'https://acme.co.uk', is_seed: false },
            ],
          }),
          error: null,
        });
      }
      return Promise.resolve({ data: { ...moveResult, sites_moved: 2 }, error: null });
    });
    siteStub.findById.withArgs('site-2').resolves(siteB);

    await run();

    expect(reparentSiteProjectStub).to.have.been.calledTwice;
    expect(createEntitlementAndEnrollmentStub).to.have.been.calledTwice;
    expect(siteB.save).to.have.been.calledOnce;
    expect(lastUpdateText()).to.not.contain('post-move setup failed');
  });

  it('continues with the remaining sites when one site fails its follow-up', async () => {
    const siteB = {
      getId: sandbox.stub().returns('site-2'),
      getBaseURL: sandbox.stub().returns('https://acme.co.uk'),
      save: sandbox.stub().resolves(),
    };
    rpcStub.callsFake((fn) => {
      if (fn === 'rpc_org_move_preview') {
        return Promise.resolve({
          data: preview({
            sites: [
              { id: 'site-1', base_url: 'https://acme.com', is_seed: true },
              { id: 'site-2', base_url: 'https://acme.co.uk', is_seed: false },
            ],
          }),
          error: null,
        });
      }
      return Promise.resolve({ data: { ...moveResult, sites_moved: 2 }, error: null });
    });
    siteStub.findById.withArgs('site-2').resolves(siteB);
    reparentSiteProjectStub.onFirstCall().rejects(new Error('project gone'));

    await run();

    expect(createEntitlementAndEnrollmentStub).to.have.been.calledOnce;
    expect(siteB.save).to.have.been.calledOnce;
    expect(lastUpdateText()).to.contain('post-move setup failed');
    expect(lastUpdateText()).to.contain('https://acme.com');
    expect(lastUpdateText()).to.contain('project gone');
  });

  it('reports a moved site that has since disappeared', async () => {
    siteStub.findById.onSecondCall().resolves(null);

    await run();

    expect(lastUpdateText()).to.contain('post-move setup failed');
    expect(lastUpdateText()).to.contain('site no longer exists');
    expect(createEntitlementAndEnrollmentStub).to.not.have.been.called;
  });

  it('shows the org names from the preview rather than the result RPC uuids', async () => {
    await run();

    expect(lastUpdateText()).to.contain('Source Org');
    expect(lastUpdateText()).to.contain('Dest Org');
    expect(lastUpdateText()).to.not.contain('_unnamed_');
  });

  it('tolerates a preview with no site or brand lists', async () => {
    rpcStub.callsFake((fn) => {
      if (fn === 'rpc_org_move_preview') {
        const p = preview();
        delete p.sites;
        delete p.brands;
        return Promise.resolve({ data: p, error: null });
      }
      return Promise.resolve({ data: moveResult, error: null });
    });

    await run();

    expect(client.chat.update).to.have.been.calledWithMatch({ text: sinon.match(/0 sites, 0 brands/) });
    expect(createEntitlementAndEnrollmentStub).to.not.have.been.called;
    expect(lastUpdateText()).to.contain('Moved LLMO organization');
  });

  it('falls back to an unknown user id when the body carries no user', async () => {
    delete body.user;
    await run();

    expect(rpcStub).to.have.been.calledWith('wrpc_move_brandalf_org', sinon.match({
      p_updated_by: 'slack:move-llmo-org:unknown',
    }));
  });

  it('carries the entitlement gotcha into the result message', async () => {
    await run();
    expect(lastUpdateText()).to.contain('Entitlements are not moved');
  });
});
