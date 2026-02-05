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
import esmock from 'esmock';

use(sinonChai);

let RunA11yCodefixCommand;
let triggerA11yCodefixStub;
let buildAggregationKeyFromSuggestionStub;

before(async () => {
  triggerA11yCodefixStub = sinon.stub();
  buildAggregationKeyFromSuggestionStub = sinon.stub();

  RunA11yCodefixCommand = await esmock('../../../../src/support/slack/commands/run-a11y-codefix.js', {
    '../../../../src/support/utils.js': {
      triggerA11yCodefixForOpportunity: triggerA11yCodefixStub,
    },
    '@adobe/spacecat-shared-utils': {
      hasText: (val) => typeof val === 'string' && val.trim().length > 0,
      buildAggregationKeyFromSuggestion: buildAggregationKeyFromSuggestionStub,
    },
  });
});

describe('RunA11yCodefixCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let mockSite;
  let mockOpportunity;
  let mockSuggestions;

  beforeEach(() => {
    mockSuggestions = [
      { getId: () => 'sugg-1', getStatus: () => 'NEW', getData: () => ({ url: 'https://example.com/page1' }) },
      { getId: () => 'sugg-2', getStatus: () => 'NEW', getData: () => ({ url: 'https://example.com/page2' }) },
    ];

    mockOpportunity = {
      getId: () => 'opp-123',
      getType: () => 'a11y-assistive',
      getStatus: () => 'NEW',
      getUpdatedAt: () => '2025-01-20T10:00:00Z',
      getCreatedAt: () => '2025-01-15T10:00:00Z',
      getSuggestions: sinon.stub().resolves(mockSuggestions),
    };

    mockSite = {
      getId: () => 'site-123',
      getName: () => 'Test Site',
      getBaseURL: () => 'https://example.com',
    };

    dataAccessStub = {
      Site: {
        all: sinon.stub().resolves([mockSite]),
      },
      Opportunity: {
        allBySiteId: sinon.stub().resolves([mockOpportunity]),
      },
    };

    context = {
      dataAccess: dataAccessStub,
      log: {
        info: sinon.spy(),
        error: sinon.spy(),
        warn: sinon.spy(),
      },
      sqs: { sendMessage: sinon.stub().resolves() },
      env: { A11Y_CODEFIX_QUEUE_URL: 'testQueueUrl' },
    };

    slackContext = { say: sinon.spy() };

    triggerA11yCodefixStub.reset();
    triggerA11yCodefixStub.resolves();
    buildAggregationKeyFromSuggestionStub.reset();
    buildAggregationKeyFromSuggestionStub.returns('default-agg-key');
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = RunA11yCodefixCommand(context);
      expect(command.id).to.equal('run-a11y-codefix');
      expect(command.name).to.equal('Run A11y Codefix');
      expect(command.description).to.include('Triggers accessibility code fix flow');
    });
  });

  describe('Input Validation', () => {
    it('shows usage when no site name provided', async () => {
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution([], slackContext);

      expect(slackContext.say).to.have.been.calledWith(command.usage());
    });

    it('rejects invalid opportunity type', async () => {
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com', 'invalid-type'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        sinon.match(/Invalid opportunity type.*a11y-invalid-type/),
      );
    });
  });

  describe('Site Search', () => {
    it('reports when no site found', async () => {
      dataAccessStub.Site.all.resolves([]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['nonexistent'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/No site found matching/));
    });

    it('reports when multiple sites match', async () => {
      const secondSite = {
        getId: () => 'site-456',
        getName: () => 'Another Test Site',
        getBaseURL: () => 'https://test.example.com',
      };
      dataAccessStub.Site.all.resolves([mockSite, secondSite]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['test'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Multiple sites found/));
    });

    it('finds site by partial name match', async () => {
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['Test'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Found site.*example.com/));
    });

    it('finds site by partial URL match', async () => {
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Found site.*example.com/));
    });

    it('handles site with null name', async () => {
      const siteWithNullName = {
        getId: () => 'site-null-name',
        getName: () => null,
        getBaseURL: () => 'https://nullname.example.com',
      };
      dataAccessStub.Site.all.resolves([siteWithNullName]);
      dataAccessStub.Opportunity.allBySiteId.resolves([mockOpportunity]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['nullname'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Found site.*nullname.example.com/));
    });

    it('handles site with null baseURL in search', async () => {
      const siteWithNullUrl = {
        getId: () => 'site-null-url',
        getName: () => 'Null URL Site',
        getBaseURL: () => null,
      };
      dataAccessStub.Site.all.resolves([siteWithNullUrl]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['Null URL'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Found site/));
    });

    it('shows "No name" for sites without name in multiple matches list', async () => {
      const siteWithNoName = {
        getId: () => 'site-no-name',
        getName: () => null,
        getBaseURL: () => 'https://test1.example.com',
      };
      const secondSite = {
        getId: () => 'site-456',
        getName: () => 'Another Site',
        getBaseURL: () => 'https://test2.example.com',
      };
      dataAccessStub.Site.all.resolves([siteWithNoName, secondSite]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['test'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/No name/));
    });

    it('truncates list when more than 10 sites match', async () => {
      const manySites = Array.from({ length: 15 }, (_, i) => ({
        getId: () => `site-${i}`,
        getName: () => `Test Site ${i}`,
        getBaseURL: () => `https://test${i}.example.com`,
      }));
      dataAccessStub.Site.all.resolves(manySites);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['test'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/and 5 more/));
    });
  });

  describe('Opportunity Lookup', () => {
    it('reports when no valid opportunity found', async () => {
      dataAccessStub.Opportunity.allBySiteId.resolves([]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        sinon.match(/No valid.*opportunity found/),
      );
    });

    it('filters out opportunities with IGNORED status', async () => {
      const ignoredOpportunity = {
        getId: () => 'opp-ignored',
        getType: () => 'a11y-assistive',
        getStatus: () => 'IGNORED',
        getUpdatedAt: () => '2025-01-20T10:00:00Z',
      };
      dataAccessStub.Opportunity.allBySiteId.resolves([ignoredOpportunity]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        sinon.match(/No valid.*opportunity found/),
      );
    });

    it('filters out opportunities with RESOLVED status', async () => {
      const resolvedOpportunity = {
        getId: () => 'opp-resolved',
        getType: () => 'a11y-assistive',
        getStatus: () => 'RESOLVED',
        getUpdatedAt: () => '2025-01-20T10:00:00Z',
      };
      dataAccessStub.Opportunity.allBySiteId.resolves([resolvedOpportunity]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        sinon.match(/No valid.*opportunity found/),
      );
    });

    it('accepts IN_PROGRESS status', async () => {
      const inProgressOpportunity = {
        getId: () => 'opp-in-progress',
        getType: () => 'a11y-assistive',
        getStatus: () => 'IN_PROGRESS',
        getUpdatedAt: () => '2025-01-20T10:00:00Z',
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getSuggestions: sinon.stub().resolves([]),
      };
      dataAccessStub.Opportunity.allBySiteId.resolves([inProgressOpportunity]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(triggerA11yCodefixStub).to.have.been.calledOnce;
    });

    it('selects the most recent opportunity when multiple exist', async () => {
      const olderOpportunity = {
        getId: () => 'opp-older',
        getType: () => 'a11y-assistive',
        getStatus: () => 'NEW',
        getUpdatedAt: () => '2025-01-15T10:00:00Z',
        getCreatedAt: () => '2025-01-10T10:00:00Z',
        getSuggestions: sinon.stub().resolves([]),
      };
      const newerOpportunity = {
        getId: () => 'opp-newer',
        getType: () => 'a11y-assistive',
        getStatus: () => 'NEW',
        getUpdatedAt: () => '2025-01-20T10:00:00Z',
        getCreatedAt: () => '2025-01-18T10:00:00Z',
        getSuggestions: sinon.stub().resolves([]),
      };
      dataAccessStub.Opportunity.allBySiteId.resolves([olderOpportunity, newerOpportunity]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(triggerA11yCodefixStub).to.have.been.calledWith(
        mockSite,
        'opp-newer',
        'a11y-assistive',
        null,
        slackContext,
        context,
      );
    });

    it('falls back to createdAt when updatedAt is null for sorting', async () => {
      const oppWithNullUpdatedAt = {
        getId: () => 'opp-null-updated',
        getType: () => 'a11y-assistive',
        getStatus: () => 'NEW',
        getUpdatedAt: () => null,
        getCreatedAt: () => '2025-01-25T10:00:00Z', // Newer createdAt
        getSuggestions: sinon.stub().resolves([]),
      };
      const oppWithUpdatedAt = {
        getId: () => 'opp-with-updated',
        getType: () => 'a11y-assistive',
        getStatus: () => 'NEW',
        getUpdatedAt: () => '2025-01-20T10:00:00Z',
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getSuggestions: sinon.stub().resolves([]),
      };
      dataAccessStub.Opportunity.allBySiteId.resolves([oppWithUpdatedAt, oppWithNullUpdatedAt]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(triggerA11yCodefixStub).to.have.been.calledWith(
        mockSite,
        'opp-null-updated',
        'a11y-assistive',
        null,
        slackContext,
        context,
      );
    });

    it('falls back to createdAt for both opportunities when updatedAt is null', async () => {
      const olderOppNullUpdated = {
        getId: () => 'opp-older-null',
        getType: () => 'a11y-assistive',
        getStatus: () => 'NEW',
        getUpdatedAt: () => null,
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getSuggestions: sinon.stub().resolves([]),
      };
      const newerOppNullUpdated = {
        getId: () => 'opp-newer-null',
        getType: () => 'a11y-assistive',
        getStatus: () => 'NEW',
        getUpdatedAt: () => null,
        getCreatedAt: () => '2025-01-25T10:00:00Z',
        getSuggestions: sinon.stub().resolves([]),
      };
      dataAccessStub.Opportunity.allBySiteId.resolves([olderOppNullUpdated, newerOppNullUpdated]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(triggerA11yCodefixStub).to.have.been.calledWith(
        mockSite,
        'opp-newer-null',
        'a11y-assistive',
        null,
        slackContext,
        context,
      );
    });
  });

  describe('Opportunity Type Normalization', () => {
    it('defaults to a11y-assistive when no type provided', async () => {
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(triggerA11yCodefixStub).to.have.been.calledWith(
        mockSite,
        'opp-123',
        'a11y-assistive',
        null,
        slackContext,
        context,
      );
    });

    it('normalizes "assistive" to "a11y-assistive"', async () => {
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com', 'assistive'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        sinon.match(/Looking for.*a11y-assistive.*opportunity/),
      );
    });

    it('normalizes "color-contrast" to "a11y-color-contrast"', async () => {
      const colorContrastOpportunity = {
        getId: () => 'opp-color',
        getType: () => 'a11y-color-contrast',
        getStatus: () => 'NEW',
        getUpdatedAt: () => '2025-01-20T10:00:00Z',
        getCreatedAt: () => '2025-01-15T10:00:00Z',
        getSuggestions: sinon.stub().resolves([]),
      };
      dataAccessStub.Opportunity.allBySiteId.resolves([colorContrastOpportunity]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com', 'color-contrast'], slackContext);

      expect(triggerA11yCodefixStub).to.have.been.calledWith(
        mockSite,
        'opp-color',
        'a11y-color-contrast',
        null,
        slackContext,
        context,
      );
    });

    it('accepts full type name a11y-assistive', async () => {
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com', 'a11y-assistive'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        sinon.match(/Looking for.*a11y-assistive.*opportunity/),
      );
    });
  });

  describe('Codefix Trigger', () => {
    it('triggers codefix for valid site and opportunity', async () => {
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(triggerA11yCodefixStub).to.have.been.calledOnce;
      expect(triggerA11yCodefixStub).to.have.been.calledWith(
        mockSite,
        'opp-123',
        'a11y-assistive',
        null,
        slackContext,
        context,
      );
    });

    it('reports success message after triggering', async () => {
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        sinon.match(/codefix request sent successfully/),
      );
    });

    it('shows suggestion count in trigger message', async () => {
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        sinon.match(/Suggestions: 2/),
      );
    });
  });

  describe('Error Handling', () => {
    it('handles data access errors gracefully', async () => {
      dataAccessStub.Site.all.rejects(new Error('Database connection failed'));
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        sinon.match(/Something went wrong.*Database connection failed/),
      );
      expect(context.log.error).to.have.been.called;
    });

    it('handles trigger errors gracefully', async () => {
      triggerA11yCodefixStub.rejects(new Error('SQS send failed'));
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        sinon.match(/Something went wrong.*SQS send failed/),
      );
      expect(context.log.error).to.have.been.called;
    });
  });

  describe('Aggregation Key Filtering', () => {
    it('passes aggregation key to trigger function when provided', async () => {
      buildAggregationKeyFromSuggestionStub.returns('agg-key-123');
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com', 'assistive', 'agg-key-123'], slackContext);

      expect(triggerA11yCodefixStub).to.have.been.calledWith(
        mockSite,
        'opp-123',
        'a11y-assistive',
        'agg-key-123',
        slackContext,
        context,
      );
    });

    it('shows matching suggestion count when aggregation key provided', async () => {
      buildAggregationKeyFromSuggestionStub.returns('agg-key-123');
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com', 'assistive', 'agg-key-123'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        sinon.match(/Aggregation Key:.*agg-key-123/),
      );
    });

    it('reports error when no suggestions match aggregation key', async () => {
      buildAggregationKeyFromSuggestionStub.returns('different-key');
      mockOpportunity.getSuggestions = sinon.stub().resolves([
        { getId: () => 'sugg-1', getStatus: () => 'NEW', getData: () => ({ url: 'https://example.com/page1' }) },
      ]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com', 'assistive', 'nonexistent-key'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        sinon.match(/No suggestions found matching aggregation key/),
      );
      expect(triggerA11yCodefixStub).not.to.have.been.called;
    });

    it('excludes suggestions with FIXED status from count', async () => {
      mockOpportunity.getSuggestions = sinon.stub().resolves([
        { getId: () => 'sugg-1', getStatus: () => 'FIXED', getData: () => ({ url: 'https://example.com/page1' }) },
        { getId: () => 'sugg-2', getStatus: () => 'NEW', getData: () => ({ url: 'https://example.com/page2' }) },
      ]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Suggestions: 1/));
    });

    it('excludes suggestions with SKIPPED status from count', async () => {
      mockOpportunity.getSuggestions = sinon.stub().resolves([
        { getId: () => 'sugg-1', getStatus: () => 'SKIPPED', getData: () => ({ url: 'https://example.com/page1' }) },
        { getId: () => 'sugg-2', getStatus: () => 'APPROVED', getData: () => ({ url: 'https://example.com/page2' }) },
      ]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Suggestions: 1/));
    });

    it('excludes invalid status suggestions when filtering by aggregation key', async () => {
      buildAggregationKeyFromSuggestionStub.returns('agg-key-123');
      mockOpportunity.getSuggestions = sinon.stub().resolves([
        { getId: () => 'sugg-1', getStatus: () => 'FIXED', getData: () => ({ url: 'https://example.com/page1' }) },
        { getId: () => 'sugg-2', getStatus: () => 'NEW', getData: () => ({ url: 'https://example.com/page2' }) },
      ]);
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com', 'assistive', 'agg-key-123'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(sinon.match(/Matching Suggestions: 1/));
    });

    it('trims whitespace from aggregation key', async () => {
      buildAggregationKeyFromSuggestionStub.returns('agg-key-123');
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com', 'assistive', '  agg-key-123  '], slackContext);

      expect(triggerA11yCodefixStub).to.have.been.calledWith(
        mockSite,
        'opp-123',
        'a11y-assistive',
        'agg-key-123',
        slackContext,
        context,
      );
    });

    it('shows filter note in success message when aggregation key provided', async () => {
      buildAggregationKeyFromSuggestionStub.returns('agg-key-123');
      const command = RunA11yCodefixCommand(context);

      await command.handleExecution(['example.com', 'assistive', 'agg-key-123'], slackContext);

      expect(slackContext.say).to.have.been.calledWith(
        sinon.match(/Only suggestions matching aggregation key/),
      );
    });
  });
});
