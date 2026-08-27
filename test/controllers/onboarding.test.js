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

const ORG_ID = '11111111-1111-4111-b111-111111111111';
const IMS_TOKEN = 'ims-access-token-abc';

describe('OnboardingController', () => {
  let sandbox;
  let notifyStub;
  let provisionStub;
  let resolveImsTokenStub;
  let hasAccessStub;
  let OnboardingController;
  let mockOrg;

  const buildContext = (overrides = {}) => ({
    params: { spaceCatId: ORG_ID },
    pathInfo: { headers: { 'x-promise-token': 'promise-token-abc' } },
    dataAccess: { Organization: { findById: sandbox.stub().resolves(mockOrg) } },
    attributes: {
      authInfo: {
        getProfile: () => ({ email: 'ABC123@AdobeID', trial_email: 'jane@example.com' }),
      },
    },
    env: { SLACK_ONBOARDING_WEBHOOK_URL: 'https://hooks.slack.test/x' },
    log: { info: sandbox.stub(), error: sandbox.stub() },
    ...overrides,
  });

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    mockOrg = { getId: () => ORG_ID, getSemrushWorkspaceId: () => 'ws-123' };
    notifyStub = sandbox.stub().resolves();
    provisionStub = sandbox.stub().resolves({
      email: 'jane@example.com', organizationId: 'org-abc', workspaceId: 'ws-123', role: 'admin',
    });
    resolveImsTokenStub = sandbox.stub().resolves(IMS_TOKEN);
    hasAccessStub = sandbox.stub().resolves(true);

    OnboardingController = await esmock('../../src/controllers/onboarding.js', {
      '../../src/support/onboarding/slack-notifier.js': { notifyProvisioningFailure: notifyStub },
      '../../src/support/onboarding/workspace-provisioning.js': { provisionWorkspaceMember: provisionStub },
      '../../src/support/utils.js': { resolveSemrushImsToken: resolveImsTokenStub },
      '../../src/support/access-control-util.js': {
        default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
      },
    });
  });

  afterEach(() => sandbox.restore());

  it('returns 200 with { provisioned, workspaceId, role } on success and sends no Slack alert', async () => {
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body).to.deep.equal({ provisioned: true, workspaceId: 'ws-123', role: 'admin' });
    expect(provisionStub.calledOnceWith(ctx.env, IMS_TOKEN)).to.equal(true);
    expect(notifyStub.called).to.equal(false);
  });

  it('returns 404 when the organization does not exist', async () => {
    const ctx = buildContext();
    ctx.dataAccess.Organization.findById.resolves(null);
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(404);
    expect(resolveImsTokenStub.called).to.equal(false);
    expect(provisionStub.called).to.equal(false);
  });

  it('returns 403 when the caller lacks access to the org', async () => {
    hasAccessStub.resolves(false);
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(403);
    expect(resolveImsTokenStub.called).to.equal(false);
    expect(provisionStub.called).to.equal(false);
  });

  it('returns 401 when the x-promise-token header is missing (no IMS auth fallback)', async () => {
    const err = new Error('IMS authentication required; send the x-promise-token header instead');
    err.status = 401;
    resolveImsTokenStub.rejects(err);
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(401);
    const body = await res.json();
    expect(body.message).to.contain('x-promise-token');
    expect(provisionStub.called).to.equal(false);
    expect(notifyStub.called).to.equal(false);
  });

  it('sends a Slack failure alert and maps the upstream status when provisioning fails', async () => {
    const err = new Error('workspace-members request failed with status 422');
    err.status = 422;
    provisionStub.rejects(err);
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(422);
    expect(notifyStub.calledOnce).to.equal(true);
    expect(notifyStub.firstCall.args[1]).to.include({
      email: 'jane@example.com',
      workspaceId: 'ws-123',
      spaceCatId: ORG_ID,
    });
    expect(notifyStub.firstCall.args[1].reason).to.contain('422');
  });

  it('treats a 409 (already a member) as success: 200 with alreadyMember, and sends no Slack alert', async () => {
    const err = Object.assign(new Error('workspace-members request failed with status 409'), {
      status: 409,
      body: { workspace_id: 'ws-123', role: 'admin' },
    });
    provisionStub.rejects(err);
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body).to.deep.equal({
      provisioned: true, alreadyMember: true, workspaceId: 'ws-123', role: 'admin',
    });
    expect(notifyStub.called).to.equal(false);
  });

  it('falls back to the org workspaceId and a default admin role on 409 when the error body lacks them', async () => {
    const err = Object.assign(new Error('workspace-members request failed with status 409'), { status: 409 });
    provisionStub.rejects(err);
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body).to.deep.equal({
      provisioned: true, alreadyMember: true, workspaceId: 'ws-123', role: 'admin',
    });
    expect(notifyStub.called).to.equal(false);
  });

  it('maps an unexpected provisioning error without a status to 500 and still alerts Slack', async () => {
    provisionStub.rejects(new Error('something unexpected'));
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(500);
    expect(notifyStub.calledOnce).to.equal(true);
  });

  it('falls back to the alias email in the Slack alert when trial_email is absent', async () => {
    provisionStub.rejects(Object.assign(new Error('boom'), { status: 500 }));
    const ctx = buildContext({
      attributes: { authInfo: { getProfile: () => ({ email: 'ABC123@AdobeID' }) } },
    });
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    await controller.triggerOnboarding(ctx);

    expect(notifyStub.firstCall.args[1]).to.include({ email: 'ABC123@AdobeID' });
  });

  it('reports email as unknown in the Slack alert when no email can be determined', async () => {
    provisionStub.rejects(Object.assign(new Error('boom'), { status: 500 }));
    const ctx = buildContext({
      attributes: { authInfo: { getProfile: () => ({}) } },
    });
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(500);
    expect(notifyStub.firstCall.args[1]).to.include({ email: 'unknown' });
  });

  it('returns the mapped error status even when the Slack alert itself fails (does not mask the original failure)', async () => {
    provisionStub.rejects(Object.assign(new Error('boom'), { status: 502 }));
    notifyStub.rejects(new Error('webhook unreachable'));
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(502);
  });

  it('reads the workspace id off the fetched org without a second findById', async () => {
    provisionStub.rejects(Object.assign(new Error('boom'), { status: 500 }));
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    await controller.triggerOnboarding(ctx);

    expect(ctx.dataAccess.Organization.findById.calledOnce).to.equal(true);
    expect(notifyStub.firstCall.args[1]).to.include({ workspaceId: 'ws-123' });
  });

  it('passes workspaceId null in the Slack alert when the org has no getSemrushWorkspaceId getter', async () => {
    mockOrg = { getId: () => ORG_ID };
    provisionStub.rejects(Object.assign(new Error('boom'), { status: 500 }));
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    await controller.triggerOnboarding(ctx);

    expect(notifyStub.firstCall.args[1]).to.include({ workspaceId: null });
  });
});
