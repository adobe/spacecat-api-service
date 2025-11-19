/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-env mocha */

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import BackfillLlmoCommand from '../../../../src/support/slack/commands/backfill-llmo.js';

use(sinonChai);

const AUDIT_TYPES = {
  CDN_LOGS_ANALYSIS: 'cdn-logs-analysis',
  CDN_LOGS_REPORT: 'cdn-logs-report',
  LLMO_REFERRAL_TRAFFIC: 'llmo-referral-traffic',
};

describe('BackfillLlmoCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;
  let configStub;
  let siteStub;

  beforeEach(() => {
    dataAccessStub = {
      Configuration: { findLatest: sinon.stub() },
      Site: { findByBaseURL: sinon.stub() },
    };
    sqsStub = {
      sendMessage: sinon.stub().resolves(),
    };
    configStub = {
      getQueues: sinon.stub().returns({ audits: 'test-audits-queue-url' }),
    };
    siteStub = {
      getId: sinon.stub().returns('test-site-id'),
      getBaseURL: sinon.stub().returns('https://example.com'),
    };
    context = {
      dataAccess: dataAccessStub,
      log: { info: sinon.stub(), error: sinon.stub() },
      sqs: sqsStub,
    };
    slackContext = { say: sinon.spy() };

    dataAccessStub.Configuration.findLatest.resolves(configStub);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = BackfillLlmoCommand(context);
      expect(command.id).to.equal('backfill-llmo');
      expect(command.name).to.equal('Backfill LLMO');
      expect(command.description).to.equal('Backfills LLMO audits.');
    });
  });

  describe('Handle Execution Method', () => {
    it('triggers cdn-logs-analysis backfill with default days', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(`:gear: Starting ${AUDIT_TYPES.CDN_LOGS_ANALYSIS} backfill for https://example.com (1 days)...`);
      expect(sqsStub.sendMessage.called).to.be.true;
      expect(sqsStub.sendMessage.callCount).to.equal(1);
    });

    it('triggers cdn-logs-report backfill with default weeks', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(`:gear: Starting ${AUDIT_TYPES.CDN_LOGS_REPORT} backfill for https://example.com (4 previous weeks)...`);
      expect(sqsStub.sendMessage.called).to.be.true;
      expect(sqsStub.sendMessage.callCount).to.equal(4);
    });

    it('triggers cdn-logs-report backfill for current week only when weeks=0', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`, 'weeks=0'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(`:gear: Starting ${AUDIT_TYPES.CDN_LOGS_REPORT} backfill for https://example.com (current week only)...`);
      expect(sqsStub.sendMessage.called).to.be.true;
      expect(sqsStub.sendMessage.callCount).to.equal(1);
    });

    it('triggers llmo-referral-traffic backfill with default weeks', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC}`], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(`:gear: Starting ${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC} backfill for https://example.com (1 previous week)...`);
      expect(sqsStub.sendMessage.called).to.be.true;
      // Default weeks=1, so should send 1 message
      expect(sqsStub.sendMessage.callCount).to.equal(1);
    });

    it('triggers llmo-referral-traffic backfill with custom weeks', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC}`, 'weeks=2'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(`:gear: Starting ${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC} backfill for https://example.com (2 previous weeks)...`);
      expect(sqsStub.sendMessage.called).to.be.true;
      // weeks=2, so should send 2 messages
      expect(sqsStub.sendMessage.callCount).to.equal(2);
    });

    it('triggers cdn-logs-analysis backfill with custom days', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`, 'days=2'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(`:gear: Starting ${AUDIT_TYPES.CDN_LOGS_ANALYSIS} backfill for https://example.com (2 days)...`);
      expect(sqsStub.sendMessage.called).to.be.true;
      expect(sqsStub.sendMessage.callCount).to.equal(2);
    });

    it('sends correct SQS message structure for cdn-logs-report', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`, 'weeks=1'], slackContext);

      expect(sqsStub.sendMessage.called).to.be.true;
      const [queueUrl, message] = sqsStub.sendMessage.firstCall.args;
      expect(queueUrl).to.equal('test-audits-queue-url');
      expect(message).to.have.property('type', AUDIT_TYPES.CDN_LOGS_REPORT);
      expect(message).to.have.property('siteId', 'test-site-id');
      expect(message).to.have.property('auditContext');
      expect(message.auditContext).to.have.property('weekOffset', -1);
    });

    it('sends correct SQS message structure for current week (weeks=0)', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`, 'weeks=0'], slackContext);

      expect(sqsStub.sendMessage.called).to.be.true;
      const [queueUrl, message] = sqsStub.sendMessage.firstCall.args;
      expect(queueUrl).to.equal('test-audits-queue-url');
      expect(message).to.have.property('type', AUDIT_TYPES.CDN_LOGS_REPORT);
      expect(message).to.have.property('siteId', 'test-site-id');
      expect(message).to.have.property('auditContext');
      expect(message.auditContext).to.have.property('weekOffset', 0);
    });

    it('sends correct SQS message structure for cdn-logs-analysis', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`, 'days=1'], slackContext);

      expect(sqsStub.sendMessage.called).to.be.true;
      const [queueUrl, message] = sqsStub.sendMessage.firstCall.args;
      expect(queueUrl).to.equal('test-audits-queue-url');
      expect(message).to.have.property('type', AUDIT_TYPES.CDN_LOGS_ANALYSIS);
      expect(message).to.have.property('siteId', 'test-site-id');
      expect(message).to.have.property('auditContext');
      expect(message.auditContext).to.have.all.keys('year', 'month', 'day', 'hour', 'processFullDay');
      expect(message.auditContext.hour).to.equal(23);
      expect(message.auditContext.processFullDay).to.be.true;
    });

    it('sends correct SQS message structure for llmo-referral-traffic', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC}`, 'weeks=1'], slackContext);

      expect(sqsStub.sendMessage.called).to.be.true;
      const [queueUrl, message] = sqsStub.sendMessage.firstCall.args;
      expect(queueUrl).to.equal('test-audits-queue-url');
      expect(message).to.have.property('type', AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC);
      expect(message).to.have.property('siteId', 'test-site-id');
      expect(message).to.have.property('auditContext');
      expect(message.auditContext).to.have.all.keys('week', 'year');
      expect(message.auditContext.week).to.be.a('number');
      expect(message.auditContext.year).to.be.a('number');
      expect(message.auditContext.week).to.be.at.least(1);
      expect(message.auditContext.week).to.be.at.most(53);
      expect(message.auditContext.year).to.be.at.least(2024);
    });

    it('responds with usage when no arguments provided', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include(':warning: Required: baseurl={baseURL} audit={auditType}');
    });

    it('responds with usage when missing required arguments', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com'], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include(':warning: Required: baseurl={baseURL} audit={auditType}');
    });

    it('responds with error for invalid site url', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=invalid-url', 'audit=cdn-logs-analysis'], slackContext);

      expect(slackContext.say.calledWith(':warning: Invalid URL provided')).to.be.true;
    });

    it('informs user if the site was not found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://unknownsite.com', `audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`], slackContext);

      expect(slackContext.say.calledWith(':x: Site \'https://unknownsite.com\' not found')).to.be.true;
    });

    it('rejects weeks parameter greater than 4 for cdn-logs-report', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`, 'weeks=5'], slackContext);

      expect(slackContext.say.calledWith(`:warning: Max 4 weeks for ${AUDIT_TYPES.CDN_LOGS_REPORT}`)).to.be.true;
    });

    it('rejects unsupported audit type', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', 'audit=unsupported'], slackContext);

      expect(slackContext.say.calledWith(`:warning: Supported audits: ${AUDIT_TYPES.CDN_LOGS_ANALYSIS}, ${AUDIT_TYPES.CDN_LOGS_REPORT}, ${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC}`)).to.be.true;
    });

    it('logs errors when they occur', async () => {
      const error = new Error('Test Error');
      dataAccessStub.Site.findByBaseURL.rejects(error);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`], slackContext);

      expect(context.log.error.calledWith('Error in LLMO backfill:', error)).to.be.true;
    });

    it('triggers cdn-logs-analysis for specific date and hour', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`, 'year=2024', 'month=11', 'day=15', 'hour=14'], slackContext);

      expect(sqsStub.sendMessage.callCount).to.equal(1);
      const [, message] = sqsStub.sendMessage.firstCall.args;
      expect(message.auditContext.year).to.equal(2024);
      expect(message.auditContext.month).to.equal(11);
      expect(message.auditContext.day).to.equal(15);
      expect(message.auditContext.hour).to.equal(14);
      expect(message.auditContext.processFullDay).to.be.false;
    });

    it('rejects days parameter greater than 14 for cdn-logs-analysis', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`, 'days=15'], slackContext);

      expect(slackContext.say.calledWith(`:warning: Max 14 days for ${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`)).to.be.true;
    });
  });
});
