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

import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';
import { computeAuditCompletion } from '../../../../src/support/slack/commands/onboard-status.js';

use(sinonChai);

describe('OnboardStatusCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let extractURLFromSlackInputStub;
  let OnboardStatusCommand;

  const siteUrl = 'https://example.com';
  const siteId = 'test-site-id';
  const onboardTime = Date.now() - 3600000; // 1 hour ago

  function makeAudit(type, auditedAt) {
    return {
      getAuditType: sinon.stub().returns(type),
      getAuditedAt: sinon.stub().returns(auditedAt),
    };
  }

  function makeSite(overrides = {}) {
    return {
      getId: sinon.stub().returns(siteId),
      getCreatedAt: sinon.stub().returns(new Date(onboardTime).toISOString()),
      getOpportunities: sinon.stub().resolves([]),
      ...overrides,
    };
  }

  beforeEach(async () => {
    extractURLFromSlackInputStub = sinon.stub().callsFake((url) => url.trim().replace(/\/$/, ''));

    dataAccessStub = {
      Site: { findByBaseURL: sinon.stub() },
      LatestAudit: { allBySiteId: sinon.stub() },
    };

    context = {
      dataAccess: dataAccessStub,
      log: {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
      },
    };

    slackContext = {
      say: sinon.stub().resolves(),
      channelId: 'test-channel',
      threadTs: 'test-thread',
    };

    OnboardStatusCommand = await esmock(
      '../../../../src/support/slack/commands/onboard-status.js',
      {
        '../../../../src/utils/slack/base.js': {
          extractURLFromSlackInput: extractURLFromSlackInputStub,
        },
      },
    );
  });

  afterEach(() => {
    sinon.restore();
    esmock.purge(OnboardStatusCommand);
  });

  describe('Initialization', () => {
    it('initializes with correct base command properties', () => {
      const command = OnboardStatusCommand(context);
      expect(command.id).to.equal('onboard-status');
      expect(command.name).to.equal('Onboard Status');
      expect(command.description).to.include('Re-checks');
      expect(command.phrases).to.deep.equal(['onboard status']);
    });
  });

  describe('handleExecution — argument validation', () => {
    it('says error when args is empty', async () => {
      const command = OnboardStatusCommand(context);
      await command.handleExecution([], slackContext);
      expect(slackContext.say).to.have.been.calledWith(
        ':x: Please provide a site URL. Usage: `onboard status <site-url>`',
      );
    });

    it('says error when args is null', async () => {
      const command = OnboardStatusCommand(context);
      await command.handleExecution(null, slackContext);
      expect(slackContext.say).to.have.been.calledWith(
        ':x: Please provide a site URL. Usage: `onboard status <site-url>`',
      );
    });

    it('says error when URL cannot be parsed', async () => {
      extractURLFromSlackInputStub.returns(null);
      const command = OnboardStatusCommand(context);
      await command.handleExecution(['/'], slackContext);
      expect(slackContext.say).to.have.been.calledWith(
        ':x: Could not parse a valid URL. Usage: `onboard status <site-url>`',
      );
    });
  });

  describe('handleExecution — site lookup', () => {
    it('says error when site not found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);
      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);
      expect(slackContext.say).to.have.been.calledWith(
        `:x: No site found for \`${siteUrl}\`. Please verify the URL and try again.`,
      );
    });

    it('sends hourglass message immediately after site found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(makeSite());
      dataAccessStub.LatestAudit.allBySiteId.resolves([]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        `:hourglass_flowing_sand: Re-checking audit and opportunity status for \`${siteUrl}\`...`,
      );
    });
  });

  describe('handleExecution — opportunity statuses', () => {
    it('shows "No opportunities found" when site has no opportunities', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(makeSite());
      dataAccessStub.LatestAudit.allBySiteId.resolves([]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      expect(slackContext.say).to.have.been.calledWith('No opportunities found');
    });

    it('shows checkmark for opportunity with suggestions when audit is complete', async () => {
      const opp = { getType: sinon.stub().returns('cwv'), getSuggestions: sinon.stub().resolves([{ id: 's1' }]) };
      const siteWithOpp = makeSite({ getOpportunities: sinon.stub().resolves([opp]) });
      dataAccessStub.Site.findByBaseURL.resolves(siteWithOpp);
      // audit completed after onboardStartTime
      dataAccessStub.LatestAudit.allBySiteId.resolves([
        makeAudit('cwv', new Date(onboardTime + 1000).toISOString()),
      ]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      expect(slackContext.say).to.have.been.calledWith('Core Web Vitals :white_check_mark:');
    });

    it('shows info icon for opportunity with no suggestions when audit is complete', async () => {
      const opp = { getType: sinon.stub().returns('cwv'), getSuggestions: sinon.stub().resolves([]) };
      const siteWithOpp = makeSite({ getOpportunities: sinon.stub().resolves([opp]) });
      dataAccessStub.Site.findByBaseURL.resolves(siteWithOpp);
      dataAccessStub.LatestAudit.allBySiteId.resolves([
        makeAudit('cwv', new Date(onboardTime + 1000).toISOString()),
      ]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      expect(slackContext.say).to.have.been.calledWith('Core Web Vitals :information_source:');
    });

    it('shows hourglass for opportunity whose source audit is still pending', async () => {
      const opp = { getType: sinon.stub().returns('cwv'), getSuggestions: sinon.stub().resolves([{ id: 's1' }]) };
      const siteWithOpp = makeSite({ getOpportunities: sinon.stub().resolves([opp]) });
      dataAccessStub.Site.findByBaseURL.resolves(siteWithOpp);
      // audit predates onboardStartTime → pending
      dataAccessStub.LatestAudit.allBySiteId.resolves([
        makeAudit('cwv', new Date(onboardTime - 1000).toISOString()),
      ]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      expect(slackContext.say).to.have.been.calledWith('Core Web Vitals :hourglass_flowing_sand:');
      // getSuggestions should NOT be called — no point fetching for a pending audit
      expect(opp.getSuggestions).to.not.have.been.called;
    });

    it('does not fetch suggestions for pending opportunity', async () => {
      const opp = { getType: sinon.stub().returns('sitemap'), getSuggestions: sinon.stub().resolves([]) };
      const siteWithOpp = makeSite({ getOpportunities: sinon.stub().resolves([opp]) });
      dataAccessStub.Site.findByBaseURL.resolves(siteWithOpp);
      dataAccessStub.LatestAudit.allBySiteId.resolves([
        makeAudit('sitemap', new Date(onboardTime - 500).toISOString()),
      ]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      expect(opp.getSuggestions).to.not.have.been.called;
    });

    it('processes each duplicate opportunity type only once', async () => {
      const opp1 = { getType: sinon.stub().returns('cwv'), getSuggestions: sinon.stub().resolves([{ id: 's1' }]) };
      const opp2 = { getType: sinon.stub().returns('cwv'), getSuggestions: sinon.stub().resolves([{ id: 's2' }]) };
      const siteWithDupes = makeSite({ getOpportunities: sinon.stub().resolves([opp1, opp2]) });
      dataAccessStub.Site.findByBaseURL.resolves(siteWithDupes);
      dataAccessStub.LatestAudit.allBySiteId.resolves([
        makeAudit('cwv', new Date(onboardTime + 1000).toISOString()),
      ]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      expect(opp1.getSuggestions).to.have.been.calledOnce;
      expect(opp2.getSuggestions).to.not.have.been.called;
    });

    it('skips opportunity not in expected audit types', async () => {
      const opp = { getType: sinon.stub().returns('meta-tags'), getSuggestions: sinon.stub().resolves([]) };
      const siteWithMetaTags = makeSite({ getOpportunities: sinon.stub().resolves([opp]) });
      dataAccessStub.Site.findByBaseURL.resolves(siteWithMetaTags);
      // auditTypes = ['cwv'], meta-tags opportunity is filtered out
      dataAccessStub.LatestAudit.allBySiteId.resolves([
        makeAudit('cwv', new Date(onboardTime + 1000).toISOString()),
      ]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      expect(opp.getSuggestions).to.not.have.been.called;
      expect(slackContext.say).to.have.been.calledWith('No opportunities found');
    });

    it('does not filter when auditTypes contain unknown types', async () => {
      const opp = { getType: sinon.stub().returns('some-opp'), getSuggestions: sinon.stub().resolves([]) };
      const siteWithUnknown = makeSite({ getOpportunities: sinon.stub().resolves([opp]) });
      dataAccessStub.Site.findByBaseURL.resolves(siteWithUnknown);
      dataAccessStub.LatestAudit.allBySiteId.resolves([
        makeAudit('unknown-audit-type', new Date(onboardTime + 1000).toISOString()),
      ]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      expect(opp.getSuggestions).to.have.been.called;
    });
  });

  describe('handleExecution — audit completion disclaimer', () => {
    it('shows "all complete" when all audits ran after onboardStartTime', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(makeSite());
      dataAccessStub.LatestAudit.allBySiteId.resolves([
        makeAudit('cwv', new Date(onboardTime + 1000).toISOString()),
      ]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        ':white_check_mark: All audits have completed. The statuses above are up to date.',
      );
    });

    it('shows pending warning when audit predates onboardStartTime', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(makeSite());
      dataAccessStub.LatestAudit.allBySiteId.resolves([
        makeAudit('cwv', new Date(onboardTime - 1000).toISOString()),
      ]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      const calls = slackContext.say.args.map((a) => a[0]);
      const disclaimer = calls.find((m) => m.includes('may still be in progress'));
      expect(disclaimer).to.include('Core Web Vitals');
      expect(disclaimer).to.include(`Run \`onboard status ${siteUrl}\``);
    });

    it('uses singular "audit" grammar when one audit is pending', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(makeSite());
      dataAccessStub.LatestAudit.allBySiteId.resolves([
        makeAudit('cwv', new Date(onboardTime - 1000).toISOString()),
      ]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      const calls = slackContext.say.args.map((a) => a[0]);
      const disclaimer = calls.find((m) => m.includes('may still be in progress'));
      expect(disclaimer).to.match(/audit may still be in progress/);
    });

    it('uses plural "audits" grammar when multiple audits are pending', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(makeSite());
      dataAccessStub.LatestAudit.allBySiteId.resolves([
        makeAudit('cwv', new Date(onboardTime - 1000).toISOString()),
        makeAudit('sitemap', new Date(onboardTime - 1000).toISOString()),
      ]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      const calls = slackContext.say.args.map((a) => a[0]);
      const disclaimer = calls.find((m) => m.includes('may still be in progress'));
      expect(disclaimer).to.match(/audits may still be in progress/);
    });

    it('falls back to LOOKBACK_MS when getCreatedAt returns null', async () => {
      const site = makeSite({ getCreatedAt: sinon.stub().returns(null) });
      dataAccessStub.Site.findByBaseURL.resolves(site);
      // Recent audit beats LOOKBACK_MS anchor → all complete
      dataAccessStub.LatestAudit.allBySiteId.resolves([
        makeAudit('cwv', new Date().toISOString()),
      ]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        ':white_check_mark: All audits have completed. The statuses above are up to date.',
      );
    });

    it('skips disclaimer when no audit types found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(makeSite());
      dataAccessStub.LatestAudit.allBySiteId.resolves([]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      const calls = slackContext.say.args.map((a) => a[0]);
      expect(calls.some((m) => m.includes('may still be in progress'))).to.be.false;
      expect(calls.some((m) => m.includes('All audits have completed'))).to.be.false;
    });

    it('excludes infrastructure audit types not in AUDIT_OPPORTUNITY_MAP from disclaimer', async () => {
      // cwv is in the map; scrape-top-pages is not
      dataAccessStub.Site.findByBaseURL.resolves(makeSite());
      dataAccessStub.LatestAudit.allBySiteId.resolves([
        makeAudit('cwv', new Date(onboardTime - 1000).toISOString()),
        makeAudit('scrape-top-pages', new Date(onboardTime - 1000).toISOString()),
      ]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      const calls = slackContext.say.args.map((a) => a[0]);
      const disclaimer = calls.find((m) => m.includes('may still be in progress'));
      expect(disclaimer).to.exist;
      expect(disclaimer).to.include('Core Web Vitals');
      expect(disclaimer).to.not.include('Scrape Top Pages');
    });

    it('uses kebab-to-Title-Case conversion for audit types not in the title map', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(makeSite());
      dataAccessStub.LatestAudit.allBySiteId.resolves([
        makeAudit('forms-opportunities', new Date(onboardTime - 1000).toISOString()),
      ]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      const calls = slackContext.say.args.map((a) => a[0]);
      const disclaimer = calls.find((m) => m.includes('may still be in progress'));
      expect(disclaimer).to.include('Forms Opportunities');
    });
  });

  describe('handleExecution — error handling', () => {
    it('warns and continues when audit fetch fails', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(makeSite());
      dataAccessStub.LatestAudit.allBySiteId.rejects(new Error('timeout'));

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      expect(context.log.warn).to.have.been.calledWith(
        sinon.match(/Could not fetch audit types for site test-site-id: timeout/),
      );
      expect(slackContext.say).to.have.been.calledWith(
        `*Opportunity Statuses for site ${siteUrl}*`,
      );
    });

    it('falls back to LOOKBACK_MS when getCreatedAt throws', async () => {
      const site = makeSite({ getCreatedAt: sinon.stub().throws(new Error('no field')) });
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.LatestAudit.allBySiteId.resolves([]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        `*Opportunity Statuses for site ${siteUrl}*`,
      );
    });

    it('logs error and says error when getOpportunities throws', async () => {
      const site = makeSite({ getOpportunities: sinon.stub().rejects(new Error('DB error')) });
      dataAccessStub.Site.findByBaseURL.resolves(site);
      dataAccessStub.LatestAudit.allBySiteId.resolves([]);

      const command = OnboardStatusCommand(context);
      await command.handleExecution([siteUrl], slackContext);

      expect(context.log.error).to.have.been.calledWith(
        sinon.match(/\[onboard-status\] Error for https:\/\/example\.com: DB error/),
      );
      expect(slackContext.say).to.have.been.calledWith(
        sinon.match(/:x: Error checking status for `https:\/\/example\.com`: DB error/),
      );
    });
  });
});

describe('computeAuditCompletion', () => {
  it('marks audit type as pending when no record exists in latestAudits', () => {
    const onboardStartTime = Date.now() - 3600000;
    // Pass auditTypes that include 'cwv', but latestAudits has no cwv record
    const latestAudits = [];
    const { pendingAuditTypes, completedAuditTypes } = computeAuditCompletion(
      ['cwv'],
      onboardStartTime,
      latestAudits,
    );
    expect(pendingAuditTypes).to.deep.equal(['cwv']);
    expect(completedAuditTypes).to.deep.equal([]);
  });
});
