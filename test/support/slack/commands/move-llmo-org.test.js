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

import MoveLlmoOrgCommand from '../../../../src/support/slack/commands/move-llmo-org.js';

use(sinonChai);

describe('MoveLlmoOrgCommand', () => {
  let sandbox;
  let context;
  let slackContext;
  let siteStub;
  let organizationStub;
  let rpcStub;
  let site;

  const preview = (overrides = {}) => ({
    ok: true,
    source: { id: 'src-1', name: 'Source Org', ims_org_id: '111111111111111111111111@AdobeOrg' },
    destination: { id: 'dst-1', name: 'Dest Org', ims_org_id: 'ABCDEF1234567890ABCDEF12@AdobeOrg' },
    blocking_conflicts: [],
    auto_resolved: {
      categories_merged: 0, topics_disambiguated: 0, feature_flags_dropped: 0,
    },
    brands: [{
      id: 'b1', name: 'Acme', status: 'active', site_id: 's1',
    }],
    sites: [{ id: 's1', base_url: 'https://acme.com' }],
    counts: { brands: 1, prompts: 4 },
    ...overrides,
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    site = {
      getId: sandbox.stub().returns('site-1'),
      getOrganizationId: sandbox.stub().returns('src-1'),
    };

    siteStub = { findByBaseURL: sandbox.stub().resolves(site) };
    organizationStub = {
      findByImsOrgId: sandbox.stub().resolves({ getId: sandbox.stub().returns('dst-1') }),
    };
    rpcStub = sandbox.stub().resolves({ data: preview(), error: null });

    context = {
      dataAccess: {
        Site: siteStub,
        Organization: organizationStub,
        services: { postgrestClient: { rpc: rpcStub } },
      },
      log: { error: sandbox.spy(), info: sandbox.spy() },
      env: {},
    };

    slackContext = {
      say: sandbox.spy(),
      channelId: 'C123',
      threadTs: '111.222',
      client: {
        chat: {
          postMessage: sandbox.stub().resolves({ ts: '111.333' }),
          update: sandbox.stub().resolves(),
        },
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  const run = (args) => MoveLlmoOrgCommand(context).handleExecution(args, slackContext);

  it('is registered with the expected phrase and usage', () => {
    const command = MoveLlmoOrgCommand(context);
    expect(command.phrases).to.deep.equal(['move llmo org']);
    expect(command.usage()).to.contain('move llmo org');
  });

  it('rejects a missing or malformed site url', async () => {
    await run(['not-a-url', 'ABCDEF1234567890ABCDEF12@AdobeOrg']);
    expect(slackContext.say).to.have.been.calledWithMatch(/valid site base URL/);
    expect(rpcStub).to.not.have.been.called;
  });

  it('rejects an invalid destination IMS org id', async () => {
    await run(['https://acme.com', 'nonsense']);
    expect(slackContext.say).to.have.been.calledWithMatch(/valid destination IMS Org ID/);
    expect(rpcStub).to.not.have.been.called;
  });

  it('rejects a missing destination IMS org id', async () => {
    await run(['https://acme.com']);
    expect(slackContext.say).to.have.been.calledWithMatch(/valid destination IMS Org ID/);
  });

  it('reports when the site is unknown', async () => {
    siteStub.findByBaseURL.resolves(null);
    await run(['https://acme.com', 'ABCDEF1234567890ABCDEF12@AdobeOrg']);
    expect(slackContext.say).to.have.been.called;
    expect(rpcStub).to.not.have.been.called;
  });

  it('refuses when the destination org has no SpaceCat record', async () => {
    organizationStub.findByImsOrgId.resolves(null);
    await run(['https://acme.com', 'ABCDEF1234567890ABCDEF12@AdobeOrg']);
    expect(slackContext.say).to.have.been.calledWithMatch(/set imsorg/);
    expect(rpcStub).to.not.have.been.called;
  });

  it('surfaces an unevaluable preview without posting a confirm button', async () => {
    rpcStub.resolves({ data: { error: 'same_org' }, error: null });

    await run(['https://acme.com', 'ABCDEF1234567890ABCDEF12@AdobeOrg']);

    expect(slackContext.say).to.have.been.calledWithMatch(/already in that organization/);
    expect(slackContext.client.chat.postMessage).to.not.have.been.called;
  });

  it('refuses to offer a confirm button when the move is blocked', async () => {
    rpcStub.resolves({
      data: preview({
        ok: false,
        blocking_conflicts: [{ type: 'brand_name', detail: 'Acme' }],
      }),
      error: null,
    });

    await run(['https://acme.com', 'ABCDEF1234567890ABCDEF12@AdobeOrg']);

    expect(slackContext.say).to.have.been.calledWithMatch(/This move is blocked/);
    expect(slackContext.say).to.have.been.calledWithMatch(/Acme/);
    expect(slackContext.client.chat.postMessage).to.not.have.been.called;
  });

  it('posts a preview with a confirm button carrying the move payload', async () => {
    await run(['https://acme.com', 'ABCDEF1234567890ABCDEF12@AdobeOrg']);

    expect(rpcStub).to.have.been.calledOnceWith('rpc_org_move_preview', {
      p_src: 'src-1',
      p_dst: 'dst-1',
    });
    expect(slackContext.client.chat.postMessage).to.have.been.calledOnce;

    // The button payload is only complete after the update pass, which injects the
    // posted message's own timestamp so the action can edit it in place.
    const updateArgs = slackContext.client.chat.update.firstCall.args[0];
    const button = updateArgs.blocks[1].elements[0];
    expect(button.action_id).to.equal('open_move_llmo_org_modal');
    expect(JSON.parse(button.value)).to.deep.include({
      baseURL: 'https://acme.com',
      siteId: 'site-1',
      sourceOrgId: 'src-1',
      destOrgId: 'dst-1',
      imsOrgId: 'ABCDEF1234567890ABCDEF12@AdobeOrg',
      messageTs: '111.333',
    });
  });

  it('never writes: the command only ever calls the read-only preview RPC', async () => {
    await run(['https://acme.com', 'ABCDEF1234567890ABCDEF12@AdobeOrg']);
    expect(rpcStub).to.have.been.calledOnce;
    expect(rpcStub).to.not.have.been.calledWith('wrpc_move_brandalf_org');
  });

  it('reports the entitlement gotcha in the preview', async () => {
    await run(['https://acme.com', 'ABCDEF1234567890ABCDEF12@AdobeOrg']);
    const updateArgs = slackContext.client.chat.update.firstCall.args[0];
    expect(updateArgs.blocks[0].text.text).to.contain('Entitlements are not moved');
  });

  it('handles an unexpected failure gracefully', async () => {
    siteStub.findByBaseURL.rejects(new Error('db down'));

    await run(['https://acme.com', 'ABCDEF1234567890ABCDEF12@AdobeOrg']);

    expect(context.log.error).to.have.been.called;
    expect(slackContext.say).to.have.been.called;
  });
});
