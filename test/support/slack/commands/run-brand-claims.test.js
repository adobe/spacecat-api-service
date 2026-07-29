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
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);

const SITE_ID = '9033554c-de8a-44ac-a356-09b51af8cc28';
const ORG_ID = '5f3b3626-029c-476e-924b-0c1bba2e871f';
const IMS_ORG_ID = 'ABC123@AdobeOrg';
const BRAND_ID = 'a1b2c3d4-5678-90ab-cdef-1234567890ab';
const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/640168421876/mysticat-bp-sheet-ready';

describe('RunBrandClaimsCommand', () => {
  let context;
  let slackContext;
  let mockSite;
  let mockOrganization;
  let getBrandBySiteStub;
  let s3SendStub;
  let sqsSendMessageStub;
  let RunBrandClaimsCommand;
  let sanitizePathComponent;

  before(async () => {
    getBrandBySiteStub = sinon.stub();
    ({ default: RunBrandClaimsCommand, sanitizePathComponent } = await esmock(
      '../../../../src/support/slack/commands/run-brand-claims.js',
      {
        '../../../../src/support/brands-storage.js': {
          getBrandBySite: getBrandBySiteStub,
        },
      },
    ));
  });

  beforeEach(() => {
    getBrandBySiteStub.reset();
    mockSite = {
      getId: () => SITE_ID,
      getBaseURL: () => 'https://example.com',
      getOrganizationId: () => ORG_ID,
    };
    mockOrganization = { getImsOrgId: () => IMS_ORG_ID };
    s3SendStub = sinon.stub();
    sqsSendMessageStub = sinon.stub().resolves();

    context = {
      dataAccess: {
        Site: {
          findById: sinon.stub().resolves(mockSite),
          findByBaseURL: sinon.stub().resolves(mockSite),
        },
        Organization: {
          findById: sinon.stub().resolves(mockOrganization),
        },
        services: { postgrestClient: { from: sinon.stub() } },
      },
      log: {
        info: sinon.stub(), error: sinon.stub(), warn: sinon.stub(), debug: sinon.stub(),
      },
      sqs: { sendMessage: sqsSendMessageStub },
      s3: { s3Client: { send: s3SendStub } },
      env: { SQS_BP_SHEET_READY_QUEUE_URL: QUEUE_URL, DRS_BP_BUCKET: 'test-bp-bucket' },
    };
    slackContext = { say: sinon.spy() };
  });

  const s3Page = (keys, isTruncated = false, nextToken = undefined) => ({
    Contents: keys.map((key) => ({ Key: key, LastModified: new Date('2026-07-27T00:00:00Z') })),
    IsTruncated: isTruncated,
    NextContinuationToken: nextToken,
  });

  describe('sanitizePathComponent', () => {
    it('matches DRS sanitization for common cases', () => {
      expect(sanitizePathComponent('Wilson.com')).to.equal('wilson-com');
      expect(sanitizePathComponent('example.co.uk')).to.equal('example-co-uk');
      // Spaces are stripped, not hyphenated (DRS's own docstring example is
      // stale relative to its actual regex — verified against the real code).
      expect(sanitizePathComponent('My Brand!')).to.equal('mybrand');
    });

    it('falls back to a sha256 prefix for fully non-ASCII input', () => {
      const result = sanitizePathComponent('日本語');
      expect(result).to.match(/^[0-9a-f]{16}$/);
    });

    it('returns an empty string for empty input', () => {
      expect(sanitizePathComponent('')).to.equal('');
    });
  });

  describe('Initialization', () => {
    it('registers the run-brand-claims phrase', () => {
      const command = RunBrandClaimsCommand(context);
      expect(command.id).to.equal('run-brand-claims');
      expect(command.phrases).to.deep.equal(['run-brand-claims']);
    });
  });

  describe('handleExecution', () => {
    it('publishes the ready-signal for the newest weekly sheet', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Acme', brandClaimsEnabled: true });
      s3SendStub.resolves(s3Page([
        `${SITE_ID}/acme/analytics/chatgpt_free/2026/07/20/brandpresence-chatgpt-w29-2026.xlsx`,
        `${SITE_ID}/acme/analytics/chatgpt_free/2026/07/27/brandpresence-chatgpt-w30-2026.xlsx`,
      ]));

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(sqsSendMessageStub).to.have.been.calledOnce;
      const [queueUrl, event] = sqsSendMessageStub.firstCall.args;
      expect(queueUrl).to.equal(QUEUE_URL);
      expect(event).to.deep.equal({
        event_type: 'BRAND_PRESENCE_SHEET_WRITTEN',
        schema_version: 1,
        organization_id: IMS_ORG_ID,
        brand_id: BRAND_ID,
        brand: 'acme',
        site_id: SITE_ID,
        week: 30,
        year: 2026,
        cadence: 'weekly',
        sheet_date: '2026-07-27',
        platform: 'chatgpt_free',
        s3_bucket: 'test-bp-bucket',
        s3_key: `${SITE_ID}/acme/analytics/chatgpt_free/2026/07/27/brandpresence-chatgpt-w30-2026.xlsx`,
        parent_job_id: null,
        batch_id: null,
      });
      expect(slackContext.say.calledWithMatch(/Requested a Brand Claims run/)).to.equal(true);
    });

    it('detects daily cadence from the DDMMYY filename suffix', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Acme', brandClaimsEnabled: true });
      s3SendStub.resolves(s3Page([
        `${SITE_ID}/acme/analytics/chatgpt_free/2026/07/27/brandpresence-chatgpt-w30-2026-270726.xlsx`,
      ]));

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      const [, event] = sqsSendMessageStub.firstCall.args;
      expect(event.cadence).to.equal('daily');
    });

    it('picks the newest key across paginated S3 listings', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Acme', brandClaimsEnabled: true });
      s3SendStub.onFirstCall().resolves(s3Page(
        [`${SITE_ID}/acme/analytics/chatgpt_free/2026/07/13/brandpresence-chatgpt-w28-2026.xlsx`],
        true,
        'token-1',
      ));
      s3SendStub.onSecondCall().resolves(s3Page(
        [`${SITE_ID}/acme/analytics/chatgpt_free/2026/07/20/brandpresence-chatgpt-w29-2026.xlsx`],
      ));

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(s3SendStub).to.have.been.calledTwice;
      const [, event] = sqsSendMessageStub.firstCall.args;
      expect(event.s3_key).to.equal(`${SITE_ID}/acme/analytics/chatgpt_free/2026/07/20/brandpresence-chatgpt-w29-2026.xlsx`);
      expect(event.week).to.equal(29);
    });

    it('ignores non-sheet keys (e.g. experiment runs) when picking latest', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Acme', brandClaimsEnabled: true });
      s3SendStub.resolves(s3Page([
        `${SITE_ID}/acme/analytics/chatgpt_free/2026/07/27/brandpresence-chatgpt-experiment-sched123-2026-07-27-run001.xlsx`,
        `${SITE_ID}/acme/analytics/chatgpt_free/2026/07/20/brandpresence-chatgpt-w29-2026.xlsx`,
      ]));

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      const [, event] = sqsSendMessageStub.firstCall.args;
      expect(event.s3_key).to.equal(`${SITE_ID}/acme/analytics/chatgpt_free/2026/07/20/brandpresence-chatgpt-w29-2026.xlsx`);
    });

    it('resolves a site by UUID as well as base URL', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Acme', brandClaimsEnabled: true });
      s3SendStub.resolves(s3Page([
        `${SITE_ID}/acme/analytics/chatgpt_free/2026/07/20/brandpresence-chatgpt-w29-2026.xlsx`,
      ]));

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution([SITE_ID], slackContext);

      expect(context.dataAccess.Site.findById).to.have.been.calledWith(SITE_ID);
      expect(context.dataAccess.Site.findByBaseURL).to.not.have.been.called;
    });

    it('warns on input that is neither a valid UUID nor a parseable URL, without querying', async () => {
      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['garbage!!!'], slackContext);

      expect(slackContext.say.calledWithMatch(/Could not parse a valid URL or site ID/)).to.equal(true);
      expect(context.dataAccess.Site.findById).to.not.have.been.called;
      expect(context.dataAccess.Site.findByBaseURL).to.not.have.been.called;
    });

    it('errors when the brand name sanitizes to an empty S3 path component', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: '   ', brandClaimsEnabled: true });

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.calledWithMatch(/sanitizes to an empty S3 path component/)).to.equal(true);
      expect(s3SendStub).to.not.have.been.called;
      expect(sqsSendMessageStub).to.not.have.been.called;
    });

    it('caps S3 listing pagination and returns the best candidate seen so far', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Acme', brandClaimsEnabled: true });
      for (let i = 0; i < 10; i += 1) {
        s3SendStub.onCall(i).resolves(s3Page(
          [`${SITE_ID}/acme/analytics/chatgpt_free/2026/07/${String(i + 1).padStart(2, '0')}/brandpresence-chatgpt-w${20 + i}-2026.xlsx`],
          true,
          `token-${i}`,
        ));
      }

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(s3SendStub.callCount).to.equal(10);
      const [, event] = sqsSendMessageStub.firstCall.args;
      expect(event.week).to.equal(29);
    });

    it('warns and does not send when no site argument is given', async () => {
      const command = RunBrandClaimsCommand(context);
      await command.handleExecution([], slackContext);

      expect(slackContext.say.calledWithMatch(/Usage/)).to.equal(true);
      expect(sqsSendMessageStub).to.not.have.been.called;
    });

    it('errors when the queue URL is not configured', async () => {
      context.env.SQS_BP_SHEET_READY_QUEUE_URL = undefined;

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.calledWithMatch(/not configured/)).to.equal(true);
      expect(context.dataAccess.Site.findByBaseURL).to.not.have.been.called;
    });

    it('errors when the DRS bucket is not configured', async () => {
      context.env.DRS_BP_BUCKET = undefined;

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.calledWithMatch(/DRS_BP_BUCKET is not configured/)).to.equal(true);
      expect(context.dataAccess.Site.findByBaseURL).to.not.have.been.called;
    });

    it('errors when the site is not found', async () => {
      context.dataAccess.Site.findByBaseURL.resolves(null);

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['https://unknown.example'], slackContext);

      expect(slackContext.say.calledWithMatch(/Site not found/)).to.equal(true);
      expect(sqsSendMessageStub).to.not.have.been.called;
    });

    it('errors when the org has no IMS org id', async () => {
      context.dataAccess.Organization.findById.resolves({ getImsOrgId: () => undefined });

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.calledWithMatch(/Could not resolve an IMS org/)).to.equal(true);
      expect(sqsSendMessageStub).to.not.have.been.called;
    });

    it('errors when the postgrest client is unavailable', async () => {
      context.dataAccess.services.postgrestClient = { from: undefined };

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.calledWithMatch(/Brand storage is not available/)).to.equal(true);
      expect(getBrandBySiteStub).to.not.have.been.called;
    });

    it('warns when no active brand is found for the site', async () => {
      getBrandBySiteStub.resolves(null);

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.calledWithMatch(/No active brand found/)).to.equal(true);
      expect(sqsSendMessageStub).to.not.have.been.called;
    });

    it('refuses to run when brand claims is not enabled, and names the enable command', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Acme', brandClaimsEnabled: false });

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.calledWithMatch(new RegExp(`enable-brand-claims ${BRAND_ID}`))).to.equal(true);
      expect(s3SendStub).to.not.have.been.called;
      expect(sqsSendMessageStub).to.not.have.been.called;
    });

    it('warns when no sheet exists yet for the site', async () => {
      getBrandBySiteStub.resolves({ id: BRAND_ID, name: 'Acme', brandClaimsEnabled: true });
      s3SendStub.resolves(s3Page([]));

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.calledWithMatch(/No Brand Presence sheet found/)).to.equal(true);
      expect(sqsSendMessageStub).to.not.have.been.called;
    });

    it('handles unexpected errors via postErrorMessage', async () => {
      getBrandBySiteStub.rejects(new Error('db down'));

      const command = RunBrandClaimsCommand(context);
      await command.handleExecution(['https://example.com'], slackContext);

      expect(slackContext.say.calledWithMatch(/Something went wrong: db down/)).to.equal(true);
    });
  });
});
