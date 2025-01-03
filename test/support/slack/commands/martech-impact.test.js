/*
 * Copyright 2023 Adobe. All rights reserved.
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

import { CHARACTER_LIMIT } from '../../../../src/utils/slack/base.js';

import MartechImpactCommand, {
  calculateColumnWidths,
  formatThirdPartySummary,
  formatRows,
  formatTotalBlockingTime,
} from '../../../../src/support/slack/commands/martech-impact.js';

use(sinonChai);

/**
 * Generates a specified number of mock third-party summaries.
 *
 * @param {number} count - The number of mock summaries to generate.
 * @returns {Array<Object>} An array of mock third-party summary objects.
 */
function generateThirdPartySummaries(count) {
  return Array.from({ length: count }, (_, index) => ({
    entity: `Third Party ${index + 1}`,
    blockingTime: Math.floor(Math.random() * 100),
    mainThreadTime: Math.floor(Math.random() * 200),
    transferSize: Math.floor(Math.random() * 1024),
  }));
}

describe('MartechImpactCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;

  beforeEach(() => {
    dataAccessStub = {
      Site: { findByBaseURL: sinon.stub() },
    };
    context = { dataAccess: dataAccessStub, log: console };
    slackContext = { say: sinon.spy() };
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = MartechImpactCommand(context);
      expect(command.id).to.equal('get-site-martech-impact');
      expect(command.name).to.equal('Get Martech Impact for a site');
      // Additional assertions for other properties
    });
  });

  describe('Handle Execution Method', () => {
    it('executes command successfully with valid data', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
        getBaseURL: () => 'example.com',
        getDeliveryType: () => 'aem_edge',
        getGitHubURL: () => '',
        getIsLive: () => true,
        getIsLiveToggledAt: () => '2011-10-05T14:48:00.000Z',
        getAuditConfig: () => ({
          auditsDisabled: () => false,
          getAuditTypeConfig: () => ({ disabled: () => false }),
        }),
        getLatestAuditByAuditType: () => ({
          getAuditResult: () => (
            { totalBlockingTime: 12, thirdPartySummary: [/* Summary data */] }
          ),
        }),
      });

      const command = MartechImpactCommand(context);

      await command.handleExecution(['example.com'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('responds with usage instructions for invalid input', async () => {
      const args = [''];
      const command = MartechImpactCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith('Usage: _get martech impact or get third party impact {baseURL};_')).to.be.true;
    });

    it('notifies when no site is found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves(null);

      const args = ['nonexistent.com'];
      const command = MartechImpactCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':x: No site found with base URL \'https://nonexistent.com\'.')).to.be.true;
    });

    it('notifies when no audit is found', async () => {
      dataAccessStub.Site.findByBaseURL.resolves({
        getId: () => '123',
        getBaseURL: () => 'example.com',
        getGitHubURL: () => '',
        isLive: () => true,
        getLatestAuditByAuditType: () => null,
      });

      const args = ['example.com'];
      const command = MartechImpactCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':warning: No audit found for site: https://example.com')).to.be.true;
    });

    it('notifies when an error occurs', async () => {
      dataAccessStub.Site.findByBaseURL.rejects(new Error('Test error'));

      const args = ['nonexistent.com'];
      const command = MartechImpactCommand(context);

      await command.handleExecution(args, slackContext);

      expect(slackContext.say.calledWith(':nuclear-warning: Oops! Something went wrong: Test error')).to.be.true;
    });
  });

  describe('Formatting Functions', () => {
    it('formats rows correctly', () => {
      const row = ['Entity', '100 ms'];
      const columnWidths = [10, 10];
      const formattedRow = formatRows(row, columnWidths);

      expect(formattedRow).to.be.a('string');
      // Additional assertions for formatted row content
    });

    it('formats total blocking time correctly', () => {
      const formattedTBT = formatTotalBlockingTime(123);
      expect(formattedTBT).to.equal('123');
    });

    it('formats total blocking time when undefined', () => {
      const formattedTBT = formatTotalBlockingTime();
      expect(formattedTBT).to.equal('_unknown_');
    });

    it('formats third party summary correctly', () => {
      const summary = [{
        entity: 'Example',
        blockingTime: 100,
        mainThreadTime: 200,
        transferSize: 1024,
      }];
      const formattedSummary = formatThirdPartySummary(summary);

      expect(formattedSummary).to.be.a('string');
    });

    it('formats empty summary correctly', () => {
      const formattedSummary = formatThirdPartySummary();

      expect(formattedSummary).to.be.a('string');
      expect(formattedSummary).to.equal('    _No third party impact detected_');
    });

    it('adds ellipsis when the summary exceeds the character limit', () => {
      const summaries = generateThirdPartySummaries(100); // Generate a large number of summaries
      const formattedSummary = formatThirdPartySummary(summaries);

      expect(formattedSummary.length).to.be.at.most(CHARACTER_LIMIT);
      expect(formattedSummary.slice(-3)).to.equal('...');
    });

    it('correctly handles colspan case in table formatting', () => {
      // Create a row with exactly two columns
      const row = ['Entity Name', '100 ms'];
      const columnWidths = [15, 10]; // Mock column widths

      const formattedRow = formatRows(row, columnWidths);

      // The second column should take up the space of any remaining columns
      expect(formattedRow).to.include('Entity Name      100 ms');
    });

    it('correctly calculates column widths considering colspan cases', () => {
      const headers = ['Header1', 'Header2', 'Header3'];
      const table = [
        ['Data1', 'Data2', 'Data3'],
        ['ColspanData', ''], // This row has fewer columns than headers
      ];

      const columnWidths = calculateColumnWidths(table, headers);

      // In the colspan case, the first column should be wide enough to hold 'ColspanData'
      expect(columnWidths[0]).to.be.at.least('ColspanData'.length);

      // The second column's width should be calculated normally
      expect(columnWidths[1]).to.be.at.least('Data2'.length);

      // The columnWidths array should only have two entries as the second row only has two columns
      expect(columnWidths.length).to.equal(2);
    });
  });
});
