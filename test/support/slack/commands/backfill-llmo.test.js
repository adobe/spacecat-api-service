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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import BackfillLlmoCommand from '../../../../src/support/slack/commands/backfill-llmo.js';

use(sinonChai);

const AUDIT_TYPES = {
  CDN_LOGS_ANALYSIS: 'cdn-logs-analysis',
  CDN_LOGS_REPORT: 'cdn-logs-report',
  LLMO_REFERRAL_TRAFFIC: 'llmo-referral-traffic',
  LLM_ERROR_PAGES: 'llm-error-pages',
};

describe('BackfillLlmoCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let sqsStub;
  let configStub;
  let siteStub;
  let postgrestStub;

  beforeEach(() => {
    postgrestStub = {
      rpc: sinon.stub().resolves({ data: [], error: null }),
    };
    dataAccessStub = {
      Configuration: { findLatest: sinon.stub() },
      Site: { findByBaseURL: sinon.stub(), all: sinon.stub() },
      services: { postgrestClient: postgrestStub },
    };
    sqsStub = {
      sendMessage: sinon.stub().resolves(),
    };
    configStub = {
      getQueues: sinon.stub().returns({ audits: 'test-audits-queue-url' }),
      isHandlerEnabledForSite: sinon.stub().returns(true),
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
      expect(slackContext.say.firstCall.args[0]).to.include(`:rocket: Triggering ${AUDIT_TYPES.CDN_LOGS_ANALYSIS} for https://example.com (1 days)...`);
      expect(sqsStub.sendMessage.called).to.be.true;
      expect(sqsStub.sendMessage.callCount).to.equal(1);
    });

    it('triggers cdn-logs-report daily backfill with default weeks (last 2 completed ISO weeks)', async () => {
      const clock = sinon.useFakeTimers(new Date('2026-05-06T12:00:00Z').getTime()); // Wednesday
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`], slackContext);
      clock.restore();

      expect(slackContext.say.firstCall.args[0]).to.include(
        `:rocket: Triggering ${AUDIT_TYPES.CDN_LOGS_REPORT} for https://example.com (last 2 completed ISO weeks (2026-04-20..2026-05-03) → 14 daily DB imports)...`,
      );
      expect(sqsStub.sendMessage.callCount).to.equal(14);
    });

    it('triggers cdn-logs-report daily backfill for current week to date when weeks=0', async () => {
      const clock = sinon.useFakeTimers(new Date('2026-05-06T12:00:00Z').getTime()); // Wednesday
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`, 'weeks=0'], slackContext);
      clock.restore();

      // Mon 2026-05-04 + Tue 2026-05-05 (Wed is "today", still incomplete)
      expect(slackContext.say.firstCall.args[0]).to.include('current week to date');
      expect(sqsStub.sendMessage.callCount).to.equal(2);
    });

    it('warns when weeks=0 has no completed days yet (Monday)', async () => {
      const clock = sinon.useFakeTimers(new Date('2026-05-04T08:00:00Z').getTime()); // Monday
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`, 'weeks=0'], slackContext);
      clock.restore();

      expect(slackContext.say.calledWith(':warning: No completed traffic days to backfill for the requested range.')).to.be.true;
      expect(sqsStub.sendMessage).not.to.have.been.called;
    });

    it('triggers llmo-referral-traffic backfill with default weeks', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC}`], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(`:rocket: Triggering ${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC} for https://example.com (1 previous week)...`);
      expect(sqsStub.sendMessage.called).to.be.true;
      // Default weeks=1, so should send 1 message
      expect(sqsStub.sendMessage.callCount).to.equal(1);
    });

    it('triggers llmo-referral-traffic backfill with custom weeks', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC}`, 'weeks=2'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(`:rocket: Triggering ${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC} for https://example.com (2 previous weeks)...`);
      expect(sqsStub.sendMessage.called).to.be.true;
      // weeks=2, so should send 2 messages
      expect(sqsStub.sendMessage.callCount).to.equal(2);
    });

    it('triggers cdn-logs-analysis backfill with custom days', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`, 'days=2'], slackContext);

      expect(slackContext.say.called).to.be.true;
      expect(slackContext.say.firstCall.args[0]).to.include(`:rocket: Triggering ${AUDIT_TYPES.CDN_LOGS_ANALYSIS} for https://example.com (2 days)...`);
      expect(sqsStub.sendMessage.called).to.be.true;
      expect(sqsStub.sendMessage.callCount).to.equal(2);
    });

    it('adds a 5-second gap between multi-day cdn-logs-analysis messages for the same site', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`, 'days=3'], slackContext);

      expect(sqsStub.sendMessage.callCount).to.equal(3);
      expect(sqsStub.sendMessage.firstCall.args[3]).to.deep.equal({ delaySeconds: 0 });
      expect(sqsStub.sendMessage.secondCall.args[3]).to.deep.equal({ delaySeconds: 5 });
      expect(sqsStub.sendMessage.thirdCall.args[3]).to.deep.equal({ delaySeconds: 10 });
    });

    it('sends date-based per-day SQS messages for cdn-logs-report (traffic day + 1), staggered', async () => {
      const clock = sinon.useFakeTimers(new Date('2026-05-06T12:00:00Z').getTime()); // Wednesday
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`, 'weeks=1'], slackContext);
      clock.restore();

      // 1 ISO week = 7 days (Mon 2026-04-27 .. Sun 2026-05-03)
      expect(sqsStub.sendMessage.callCount).to.equal(7);
      const [queueUrl, message, group, opts] = sqsStub.sendMessage.firstCall.args;
      expect(queueUrl).to.equal('test-audits-queue-url');
      expect(message).to.deep.equal({
        type: AUDIT_TYPES.CDN_LOGS_REPORT,
        siteId: 'test-site-id',
        // oldest day first: Mon 2026-04-27 traffic → reference date 2026-04-28
        auditContext: { date: '2026-04-28' },
      });
      expect(group).to.equal(undefined);
      expect(opts).to.deep.equal({ delaySeconds: 0 });
      expect(sqsStub.sendMessage.secondCall.args[3]).to.deep.equal({ delaySeconds: 5 });
      expect(sqsStub.sendMessage.thirdCall.args[3]).to.deep.equal({ delaySeconds: 10 });
    });

    it('sends a single date-based message for a specific traffic day', async () => {
      const clock = sinon.useFakeTimers(new Date('2026-05-06T12:00:00Z').getTime());
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`,
        'date=2026-04-27',
      ], slackContext);
      clock.restore();

      expect(slackContext.say.firstCall.args[0]).to.include('traffic day 2026-04-27');
      expect(sqsStub.sendMessage.callCount).to.equal(1);
      const [queueUrl, message] = sqsStub.sendMessage.firstCall.args;
      expect(queueUrl).to.equal('test-audits-queue-url');
      expect(message).to.deep.equal({
        type: AUDIT_TYPES.CDN_LOGS_REPORT,
        siteId: 'test-site-id',
        auditContext: { date: '2026-04-28' },
      });
    });

    it('supports year/month/day for a specific traffic day', async () => {
      const clock = sinon.useFakeTimers(new Date('2026-05-06T12:00:00Z').getTime());
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`,
        'year=2026',
        'month=4',
        'day=27',
      ], slackContext);
      clock.restore();

      expect(sqsStub.sendMessage.callCount).to.equal(1);
      const [, message] = sqsStub.sendMessage.firstCall.args;
      expect(message.auditContext).to.deep.equal({ date: '2026-04-28' });
    });

    it('rejects a future traffic day', async () => {
      const clock = sinon.useFakeTimers(new Date('2026-05-06T12:00:00Z').getTime());
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`,
        'date=2026-05-06',
      ], slackContext);
      clock.restore();

      expect(slackContext.say.calledWith(':warning: date must be yesterday (UTC) or earlier.')).to.be.true;
      expect(sqsStub.sendMessage).not.to.have.been.called;
    });

    it('rejects an invalid traffic day', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`,
        'date=2026-04-31',
      ], slackContext);

      expect(slackContext.say.calledWith(':warning: Invalid date format. Use date=YYYY-MM-DD.')).to.be.true;
      expect(sqsStub.sendMessage).not.to.have.been.called;
    });

    it('rejects a malformed traffic day', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`,
        'date=2026/04/27',
      ], slackContext);

      expect(slackContext.say.calledWith(':warning: Invalid date format. Use date=YYYY-MM-DD.')).to.be.true;
      expect(sqsStub.sendMessage).not.to.have.been.called;
    });

    it('backfills a trailing window of days (oldest first)', async () => {
      const clock = sinon.useFakeTimers(new Date('2026-05-06T12:00:00Z').getTime());
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`,
        'days=10',
      ], slackContext);
      clock.restore();

      expect(slackContext.say.firstCall.args[0]).to.include('last 10 days');
      expect(sqsStub.sendMessage.callCount).to.equal(10);
      // yesterday = 2026-05-05; 10 days back → oldest traffic 2026-04-26 → reference 2026-04-27
      expect(sqsStub.sendMessage.firstCall.args[1].auditContext).to.deep.equal({ date: '2026-04-27' });
    });

    it('rejects too many days', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`,
        'days=40',
      ], slackContext);

      expect(slackContext.say.calledWith(`:warning: Max 31 days for ${AUDIT_TYPES.CDN_LOGS_REPORT}.`)).to.be.true;
      expect(sqsStub.sendMessage).not.to.have.been.called;
    });

    it('rejects non-positive days', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`,
        'days=0',
      ], slackContext);

      expect(slackContext.say.calledWith(':warning: days must be a positive integer.')).to.be.true;
      expect(sqsStub.sendMessage).not.to.have.been.called;
    });

    it('rejects non-numeric days', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`,
        'days=abc',
      ], slackContext);

      expect(slackContext.say.calledWith(':warning: days must be a positive integer.')).to.be.true;
      expect(sqsStub.sendMessage).not.to.have.been.called;
    });

    it('runs a cdn-logs-report weekly DB refresh through the weekly WRPC', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      postgrestStub.rpc.resolves({
        data: [{ week_start: '2026-04-27', rows_inserted: 42 }],
        error: null,
      });
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`,
        'mode=weekly-db',
        'date=2026-05-03',
      ], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include(
        `:rocket: Running ${AUDIT_TYPES.CDN_LOGS_REPORT} weekly DB refresh for https://example.com (2026-04-27..2026-05-03)...`,
      );
      expect(postgrestStub.rpc).to.have.been.calledOnceWith(
        'wrpc_refresh_agentic_traffic_weekly',
        {
          p_site_id: 'test-site-id',
          p_start_date: '2026-04-27',
          p_end_date: '2026-05-03',
          p_updated_by: 'slack:backfill-llmo-weekly-db',
        },
      );
      expect(slackContext.say.secondCall.args[0]).to.include('rows_inserted=42');
      expect(sqsStub.sendMessage).not.to.have.been.called;
    });

    it('infers cdn-logs-report for weekly DB refresh when audit is omitted', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      postgrestStub.rpc.resolves({
        data: [{ week_start: '2026-04-27', rows_inserted: 42 }],
        error: null,
      });
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        'mode=weekly-db',
        'date=2026-05-03',
      ], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include(
        `:rocket: Running ${AUDIT_TYPES.CDN_LOGS_REPORT} weekly DB refresh for https://example.com (2026-04-27..2026-05-03)...`,
      );
      expect(postgrestStub.rpc).to.have.been.calledOnce;
      expect(sqsStub.sendMessage).not.to.have.been.called;
    });

    it('handles a single-row weekly DB refresh response without rows_inserted', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      postgrestStub.rpc.resolves({
        data: { week_start: '2026-04-27' },
        error: null,
      });
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        'mode=weekly-db',
        'date=2026-05-03',
      ], slackContext);

      expect(slackContext.say.secondCall.args[0]).to.include('rows_inserted=0');
    });

    it('handles an empty weekly DB refresh response', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      postgrestStub.rpc.resolves({
        data: null,
        error: null,
      });
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        'mode=weekly-db',
        'date=2026-05-03',
      ], slackContext);

      expect(slackContext.say.secondCall.args[0]).to.include('rows_inserted=0');
    });

    it('rejects weekly DB refresh for the current incomplete ISO week', async () => {
      const clock = sinon.useFakeTimers(new Date('2026-05-05T12:00:00Z').getTime());
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        'mode=weekly-db',
        'date=2026-05-04',
      ], slackContext);
      clock.restore();

      expect(slackContext.say.calledWith(
        ':warning: mode=weekly-db only supports completed ISO weeks. Week 2026-05-04..2026-05-10 is not complete yet.',
      )).to.be.true;
      expect(postgrestStub.rpc).not.to.have.been.called;
      expect(sqsStub.sendMessage).not.to.have.been.called;
    });

    it('rejects cdn-logs-report weekly DB refresh without a date', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`,
        'mode=weekly-db',
      ], slackContext);

      expect(slackContext.say.calledWith(
        ':warning: mode=weekly-db requires date=YYYY-MM-DD within the ISO week to refresh.',
      )).to.be.true;
      expect(postgrestStub.rpc).not.to.have.been.called;
      expect(sqsStub.sendMessage).not.to.have.been.called;
    });

    it('rejects cdn-logs-report weekly DB refresh for all sites', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=all',
        `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`,
        'mode=weekly-db',
        'date=2026-05-03',
      ], slackContext);

      expect(slackContext.say.calledWith(
        ':warning: mode=weekly-db requires a specific baseurl. Run the weekly status check first, then refresh only the missing sites.',
      )).to.be.true;
      expect(dataAccessStub.Site.all).not.to.have.been.called;
      expect(postgrestStub.rpc).not.to.have.been.called;
      expect(sqsStub.sendMessage).not.to.have.been.called;
    });

    it('surfaces weekly WRPC errors through the generic Slack error handler', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      postgrestStub.rpc.resolves({
        data: null,
        error: { message: 'statement timeout' },
      });
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`,
        'mode=weekly-db',
        'date=2026-05-03',
      ], slackContext);

      expect(context.log.error).to.have.been.calledWith(
        'Error in LLMO backfill:',
        sinon.match.instanceOf(Error),
      );
      const output = slackContext.say.args.flat().join('\n');
      expect(output).to.include('statement timeout');
    });

    it('surfaces unavailable PostgREST when running weekly DB refresh', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      context.dataAccess.services = {};
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        'mode=weekly-db',
        'date=2026-05-03',
      ], slackContext);

      expect(context.log.error).to.have.been.calledWith(
        'Error in LLMO backfill:',
        sinon.match.instanceOf(Error),
      );
      const output = slackContext.say.args.flat().join('\n');
      expect(output).to.include(
        'PostgREST client is unavailable; cannot refresh agentic weekly rollup.',
      );
    });

    it('rejects unsupported cdn-logs-report mode', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        `audit=${AUDIT_TYPES.CDN_LOGS_REPORT}`,
        'mode=weekly',
      ], slackContext);

      expect(slackContext.say.calledWith(
        ':warning: Unsupported mode. Use mode=weekly-db for a weekly DB rollup refresh (daily DB import is the default — just pass weeks/days/date).',
      )).to.be.true;
      expect(sqsStub.sendMessage).not.to.have.been.called;
    });

    it('rejects mode=db for non-cdn-logs-report audits', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        `audit=${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC}`,
        'mode=db',
        'date=2026-04-27',
      ], slackContext);

      expect(slackContext.say.calledWith(
        `:warning: mode=db is only supported for audit=${AUDIT_TYPES.CDN_LOGS_REPORT}.`,
      )).to.be.true;
      expect(sqsStub.sendMessage).not.to.have.been.called;
    });

    it('rejects mode=weekly-db for non-cdn-logs-report audits', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        `audit=${AUDIT_TYPES.LLM_ERROR_PAGES}`,
        'mode=weekly-db',
        'date=2026-04-27',
      ], slackContext);

      expect(slackContext.say.calledWith(
        `:warning: mode=weekly-db is only supported for audit=${AUDIT_TYPES.CDN_LOGS_REPORT}.`,
      )).to.be.true;
      expect(sqsStub.sendMessage).not.to.have.been.called;
    });

    it('rejects unsupported mode without an audit type', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([
        'baseurl=https://example.com',
        'mode=foo',
        'date=2026-04-27',
      ], slackContext);

      expect(slackContext.say.calledWith(
        ':warning: Unsupported mode. Use mode=weekly-db for a weekly DB rollup refresh (daily DB import is the default — just pass weeks/days/date).',
      )).to.be.true;
      expect(sqsStub.sendMessage).not.to.have.been.called;
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

    it('triggers llm-error-pages backfill with default weeks', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.LLM_ERROR_PAGES}`], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include(`:rocket: Triggering ${AUDIT_TYPES.LLM_ERROR_PAGES} for https://example.com (4 previous weeks)...`);
      expect(sqsStub.sendMessage.callCount).to.equal(4);
    });

    it('triggers llm-error-pages backfill for current week only when weeks=0', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.LLM_ERROR_PAGES}`, 'weeks=0'], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include(`:rocket: Triggering ${AUDIT_TYPES.LLM_ERROR_PAGES} for https://example.com (current week only)...`);
      expect(sqsStub.sendMessage.callCount).to.equal(1);
      const [, message] = sqsStub.sendMessage.firstCall.args;
      expect(message.auditContext.weekOffset).to.equal(0);
    });

    it('sends correct SQS message structure for llm-error-pages', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(siteStub);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.LLM_ERROR_PAGES}`, 'weeks=2'], slackContext);

      expect(sqsStub.sendMessage.callCount).to.equal(2);
      const [queueUrl, message] = sqsStub.sendMessage.firstCall.args;
      expect(queueUrl).to.equal('test-audits-queue-url');
      expect(message).to.have.property('type', AUDIT_TYPES.LLM_ERROR_PAGES);
      expect(message).to.have.property('siteId', 'test-site-id');
      expect(message.auditContext).to.have.property('weekOffset', -1);
    });

    it('rejects weeks parameter greater than 4 for llm-error-pages', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.LLM_ERROR_PAGES}`, 'weeks=5'], slackContext);

      expect(slackContext.say.calledWith(`:warning: Max 4 weeks for ${AUDIT_TYPES.LLM_ERROR_PAGES}`)).to.be.true;
    });

    it('responds with usage when no arguments provided', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution([], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include(':warning: Required: baseurl={baseURL|all} audit={auditType}');
    });

    it('responds with usage when missing required arguments', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com'], slackContext);

      expect(slackContext.say.firstCall.args[0]).to.include(':warning: Required: baseurl={baseURL|all} audit={auditType}');
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

      expect(slackContext.say.calledWith(`:warning: weeks must be between 0 and 4 for ${AUDIT_TYPES.CDN_LOGS_REPORT}.`)).to.be.true;
    });

    it('rejects unsupported audit type', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', 'audit=unsupported'], slackContext);

      expect(slackContext.say.calledWith(`:warning: Supported audits: ${AUDIT_TYPES.CDN_LOGS_ANALYSIS}, ${AUDIT_TYPES.CDN_LOGS_REPORT}, ${AUDIT_TYPES.LLM_ERROR_PAGES}, ${AUDIT_TYPES.LLMO_REFERRAL_TRAFFIC}`)).to.be.true;
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
    });

    it('rejects days parameter greater than 14 for cdn-logs-analysis', async () => {
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=https://example.com', `audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`, 'days=15'], slackContext);

      expect(slackContext.say.calledWith(`:warning: Max 14 days for ${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`)).to.be.true;
    });

    it('triggers backfill for all enabled sites with baseurl=all', async () => {
      const site1 = { getId: () => 'site-1' };
      const site2 = { getId: () => 'site-2' };
      dataAccessStub.Site.all.resolves([site1, site2]);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=all', `audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`, 'days=1'], slackContext);

      expect(sqsStub.sendMessage.callCount).to.equal(2);
    });

    it('reports no sites enabled when baseurl=all and none enabled', async () => {
      dataAccessStub.Site.all.resolves([siteStub]);
      configStub.isHandlerEnabledForSite.returns(false);
      const command = BackfillLlmoCommand(context);

      await command.handleExecution(['baseurl=all', `audit=${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`, 'days=1'], slackContext);

      expect(slackContext.say.calledWith(`:x: No sites enabled for ${AUDIT_TYPES.CDN_LOGS_ANALYSIS}`)).to.be.true;
    });
  });
});
