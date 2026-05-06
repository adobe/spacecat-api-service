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
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import {
  CUSTOMER_ANALYSIS_CHANGE_KINDS,
  dispatchCustomerAnalysisV2,
} from '../../src/support/llmo-customer-analysis-dispatch.js';

use(chaiAsPromised);
use(sinonChai);

describe('dispatchCustomerAnalysisV2', () => {
  const ORG_ID = '9033554c-de8a-44ac-a356-09b51af8cc28';
  const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789/audits-queue';

  let sandbox;
  let log;
  let sqs;
  let allByOrganizationId;
  let context;

  const makeSite = (id) => ({ getId: () => id });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    log = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
      debug: sandbox.stub(),
    };
    sqs = { sendMessage: sandbox.stub().resolves() };
    allByOrganizationId = sandbox.stub();
    context = {
      sqs,
      log,
      env: { AUDIT_JOBS_QUEUE_URL: QUEUE_URL },
      dataAccess: { Site: { allByOrganizationId } },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('exposes the canonical changeKind enum', () => {
    expect(CUSTOMER_ANALYSIS_CHANGE_KINDS).to.deep.equal({
      BRANDS: 'brands',
      COMPETITORS: 'competitors',
      CATEGORIES: 'categories',
      TOPICS: 'topics',
      ENTITIES: 'entities',
      PROMPTS: 'prompts',
    });
    // Frozen so callers cannot mutate.
    expect(Object.isFrozen(CUSTOMER_ANALYSIS_CHANGE_KINDS)).to.equal(true);
  });

  it('dispatches one message per site for the org with full payload', async () => {
    allByOrganizationId.resolves([makeSite('site-1'), makeSite('site-2')]);

    await dispatchCustomerAnalysisV2(context, ORG_ID, 'brands');

    expect(sqs.sendMessage).to.have.been.calledTwice;
    expect(sqs.sendMessage).to.have.been.calledWith(QUEUE_URL, {
      type: 'llmo-customer-analysis',
      siteId: 'site-1',
      auditContext: {
        onboardingMode: 'v2',
        organizationId: ORG_ID,
        changeKind: 'brands',
      },
    });
    expect(sqs.sendMessage).to.have.been.calledWith(QUEUE_URL, {
      type: 'llmo-customer-analysis',
      siteId: 'site-2',
      auditContext: {
        onboardingMode: 'v2',
        organizationId: ORG_ID,
        changeKind: 'brands',
      },
    });
    expect(log.info).to.have.been.calledWithMatch(/Dispatched 2\/2 message\(s\)/);
  });

  it('falls back to site.getSiteId() when getId is not present', async () => {
    allByOrganizationId.resolves([{ getSiteId: () => 'site-legacy' }]);

    await dispatchCustomerAnalysisV2(context, ORG_ID, 'topics');

    expect(sqs.sendMessage).to.have.been.calledOnceWith(QUEUE_URL, sinon.match({
      siteId: 'site-legacy',
      auditContext: sinon.match({ changeKind: 'topics' }),
    }));
  });

  it('skips sites that do not expose an id and continues with the rest', async () => {
    allByOrganizationId.resolves([
      { /* no getId / getSiteId */ },
      makeSite('site-ok'),
    ]);

    await dispatchCustomerAnalysisV2(context, ORG_ID, 'categories');

    expect(sqs.sendMessage).to.have.been.calledOnce;
    expect(sqs.sendMessage).to.have.been.calledWith(QUEUE_URL, sinon.match({ siteId: 'site-ok' }));
    expect(log.warn).to.have.been.calledWithMatch(/Site without id encountered/);
  });

  it('warns and returns when no sites exist for the org', async () => {
    allByOrganizationId.resolves([]);

    await dispatchCustomerAnalysisV2(context, ORG_ID, 'brands');

    expect(sqs.sendMessage).to.not.have.been.called;
    expect(log.warn).to.have.been.calledWithMatch(/No sites found/);
  });

  it('warns and returns when allByOrganizationId yields a non-array', async () => {
    allByOrganizationId.resolves(null);

    await dispatchCustomerAnalysisV2(context, ORG_ID, 'topics');

    expect(sqs.sendMessage).to.not.have.been.called;
    expect(log.warn).to.have.been.calledWithMatch(/No sites found/);
  });

  it('warns and never throws when changeKind is invalid', async () => {
    await dispatchCustomerAnalysisV2(context, ORG_ID, 'invalid-kind');

    expect(allByOrganizationId).to.not.have.been.called;
    expect(sqs.sendMessage).to.not.have.been.called;
    expect(log.warn).to.have.been.calledWithMatch(/invalid changeKind/);
  });

  it('warns when AUDIT_JOBS_QUEUE_URL is missing', async () => {
    context.env = {};

    await dispatchCustomerAnalysisV2(context, ORG_ID, 'brands');

    expect(allByOrganizationId).to.not.have.been.called;
    expect(sqs.sendMessage).to.not.have.been.called;
    expect(log.warn).to.have.been.calledWithMatch(/AUDIT_JOBS_QUEUE_URL not configured/);
  });

  it('does not throw when sendMessage rejects, but logs per-site warning', async () => {
    allByOrganizationId.resolves([makeSite('site-1'), makeSite('site-2')]);
    sqs.sendMessage.onFirstCall().rejects(new Error('SQS down'));
    sqs.sendMessage.onSecondCall().resolves();

    await dispatchCustomerAnalysisV2(context, ORG_ID, 'prompts');

    expect(sqs.sendMessage).to.have.been.calledTwice;
    expect(log.warn).to.have.been.calledWithMatch(/Failed to dispatch for site site-1/);
    // Final log reports successful sends out of total — site-1 failed, site-2 succeeded
    expect(log.info).to.have.been.calledWithMatch(/Dispatched 1\/2 message\(s\)/);
  });

  it('does not throw when Site lookup fails — logs unexpected error', async () => {
    allByOrganizationId.rejects(new Error('DDB unavailable'));

    await expect(dispatchCustomerAnalysisV2(context, ORG_ID, 'topics', log)).to.be.fulfilled;

    expect(sqs.sendMessage).to.not.have.been.called;
    expect(log.warn).to.have.been.calledWithMatch(/Unexpected error during dispatch/);
  });

  it('warns when dataAccess.Site is unavailable', async () => {
    context.dataAccess = {};

    await dispatchCustomerAnalysisV2(context, ORG_ID, 'brands', log);

    expect(sqs.sendMessage).to.not.have.been.called;
    expect(log.warn).to.have.been.calledWithMatch(/Site\.allByOrganizationId not available/);
  });

  it('warns when dataAccess is missing entirely', async () => {
    context.dataAccess = undefined;

    await dispatchCustomerAnalysisV2(context, ORG_ID, 'brands', log);

    expect(sqs.sendMessage).to.not.have.been.called;
    expect(log.warn).to.have.been.calledWithMatch(/Site\.allByOrganizationId not available/);
  });

  it('falls back to no-op logger when neither log argument nor context.log is provided', async () => {
    // No `log` argument, and no context.log
    delete context.log;
    allByOrganizationId.resolves([makeSite('site-1')]);

    // Should not throw despite no logger anywhere
    await expect(
      dispatchCustomerAnalysisV2(context, ORG_ID, 'brands'),
    ).to.be.fulfilled;

    expect(sqs.sendMessage).to.have.been.calledOnce;
  });

  it('prefers explicit log argument over context.log', async () => {
    const explicitLog = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
      debug: sandbox.stub(),
    };
    context.log = log; // shouldn't be used
    allByOrganizationId.resolves([makeSite('site-1')]);

    await dispatchCustomerAnalysisV2(context, ORG_ID, 'brands', explicitLog);

    expect(explicitLog.info).to.have.been.calledWithMatch(/Dispatched 1\/1 message/);
    expect(log.info).to.not.have.been.called;
  });

  it('accepts every documented changeKind', async () => {
    allByOrganizationId.resolves([makeSite('site-only')]);
    const kinds = Object.values(CUSTOMER_ANALYSIS_CHANGE_KINDS);

    for (const kind of kinds) {
      sqs.sendMessage.resetHistory();
      // eslint-disable-next-line no-await-in-loop
      await dispatchCustomerAnalysisV2(context, ORG_ID, kind);
      expect(sqs.sendMessage).to.have.been.calledOnce;
      expect(sqs.sendMessage.firstCall.args[1].auditContext.changeKind).to.equal(kind);
    }
  });
});
