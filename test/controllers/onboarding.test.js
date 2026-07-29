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

describe('OnboardingController', () => {
  let sandbox;
  let notifyStub;
  let hasAccessStub;
  let OnboardingController;
  let mockOrg;

  const buildContext = (overrides = {}) => ({
    params: { spaceCatId: ORG_ID },
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
    hasAccessStub = sandbox.stub().resolves(true);

    // esmock returns a fresh module instance per call, so the controller's
    // module-scoped per-org cooldown Map starts empty for every test.
    OnboardingController = await esmock('../../src/controllers/onboarding.js', {
      '../../src/support/onboarding/slack-notifier.js': { notifyOnboarding: notifyStub },
      '../../src/support/access-control-util.js': {
        default: { fromContext: () => ({ hasAccess: hasAccessStub }) },
      },
    });
  });

  afterEach(() => sandbox.restore());

  it('returns 200 with { notified, workspaceId } on success', async () => {
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body).to.deep.equal({ notified: true, workspaceId: 'ws-123' });
    expect(notifyStub.calledOnce).to.equal(true);
    expect(notifyStub.firstCall.args[1]).to.include({
      email: 'jane@example.com',
      workspaceId: 'ws-123',
      spaceCatId: ORG_ID,
    });
  });

  it('returns 200 with workspaceId null when the org has no workspace', async () => {
    mockOrg.getSemrushWorkspaceId = () => null;
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body).to.deep.equal({ notified: true, workspaceId: null });
  });

  it('returns 404 when the organization does not exist', async () => {
    const ctx = buildContext();
    ctx.dataAccess.Organization.findById.resolves(null);
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(404);
    expect(notifyStub.called).to.equal(false);
  });

  it('returns 403 when the caller lacks access to the org', async () => {
    hasAccessStub.resolves(false);
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(403);
    expect(notifyStub.called).to.equal(false);
  });

  it('falls back to the alias email when trial_email is absent', async () => {
    const ctx = buildContext({
      attributes: { authInfo: { getProfile: () => ({ email: 'ABC123@AdobeID' }) } },
    });
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(200);
    expect(notifyStub.firstCall.args[1]).to.include({
      email: 'ABC123@AdobeID',
      workspaceId: 'ws-123',
      spaceCatId: ORG_ID,
    });
  });

  it('returns 400 when no email can be determined from the identity', async () => {
    const ctx = buildContext({
      attributes: { authInfo: { getProfile: () => ({}) } },
    });
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(400);
    expect(notifyStub.called).to.equal(false);
  });

  it('maps a 500 notifier error (webhook not configured) to 500', async () => {
    const err = new Error('onboarding notifications not configured');
    err.status = 500;
    notifyStub.rejects(err);
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(500);
  });

  it('maps a 502 notifier error (webhook failure) to 502', async () => {
    const err = new Error('onboarding notification rejected with status 500');
    err.status = 502;
    notifyStub.rejects(err);
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(502);
  });

  it('maps an unexpected error without a status to 500', async () => {
    notifyStub.rejects(new Error('something unexpected'));
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(500);
  });

  it('redacts the webhook URL from the error log even if the thrown message contains it', async () => {
    const webhookUrl = 'https://hooks.slack.test/x';
    const err = new Error(`connect failed to ${webhookUrl}?token=leak`);
    err.status = 502;
    notifyStub.rejects(err);
    const ctx = buildContext({ env: { SLACK_ONBOARDING_WEBHOOK_URL: webhookUrl } });
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(502);
    expect(ctx.log.error.calledOnce).to.equal(true);
    const logged = ctx.log.error.firstCall.args[0];
    expect(logged).to.not.contain(webhookUrl);
    expect(logged).to.contain('[redacted]');
  });

  it('reads the workspace id off the fetched org without a second findById', async () => {
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    await controller.triggerOnboarding(ctx);

    expect(ctx.dataAccess.Organization.findById.calledOnce).to.equal(true);
  });

  it('returns workspaceId null when the org has no getSemrushWorkspaceId getter', async () => {
    mockOrg = { getId: () => ORG_ID };
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);
    const res = await controller.triggerOnboarding(ctx);

    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body).to.deep.equal({ notified: true, workspaceId: null });
  });

  it('skips a duplicate notification for the same org within the cooldown window', async () => {
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);

    const first = await controller.triggerOnboarding(ctx);
    expect(first.status).to.equal(200);
    expect((await first.json()).notified).to.equal(true);

    const second = await controller.triggerOnboarding(ctx);
    expect(second.status).to.equal(200);
    expect(await second.json()).to.deep.equal({
      notified: false, workspaceId: 'ws-123', reason: 'recently notified',
    });
    expect(notifyStub.calledOnce).to.equal(true);
  });

  it('does not arm the cooldown when the send fails, keeping retries open', async () => {
    const err = new Error('onboarding notification rejected with status 500');
    err.status = 502;
    notifyStub.onFirstCall().rejects(err);
    notifyStub.onSecondCall().resolves();
    const ctx = buildContext();
    const controller = OnboardingController(ctx, ctx.log, ctx.env);

    const first = await controller.triggerOnboarding(ctx);
    expect(first.status).to.equal(502);

    const second = await controller.triggerOnboarding(ctx);
    expect(second.status).to.equal(200);
    expect((await second.json()).notified).to.equal(true);
    expect(notifyStub.calledTwice).to.equal(true);
  });
});
