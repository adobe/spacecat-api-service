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

import GetSitesCommand, { formatSitesToCSV } from '../../../../src/support/slack/commands/get-sites.js';

use(sinonChai);

/**
 * Generates a specified number of mock sites with mock audits.
 *
 * @param {number} count - The number of mock sites to generate.
 * @returns {Array<Object>} An array of mock site objects.
 */
function generateSites(count) {
  return Array.from({ length: count }, (_, index) => {
    const siteData = {
      getId: () => `site-${index}`,
      getBaseURL: () => `https://site-${index}.com`,
      getGitHubURL: () => ((index % 2 === 0) ? `https://github.com/site-${index}` : ''),
      getIsLive: () => (index % 2 === 0),
      getCreatedAt: () => 'createdAtDate',
      getIsLiveToggledAt: () => ((index % 2 === 0) ? 'istoggledLiveAtDate' : null),
      getDeliveryType: () => ((index % 2 === 0) ? 'aem_edge' : 'aem_cs'),
      getOrganizationId: () => 'some-org-id',
    };

    const runtimeError = index % 3 === 0 ? { code: 'NO_FCP', message: 'Test LH Error' } : null;
    const scores = {
      performance: 0.9,
      seo: 0.8,
      accessibility: 0.7,
      'best-practices': 0.6,
    };

    const auditData = {
      getSiteId: () => siteData.id,
      getAuditType: () => 'lhs-mobile',
      getAuditedAt: () => new Date().toISOString(),
      getFullAuditRef: () => 'https://example.com',
      getIsError: () => !!runtimeError,
      getIsLive: () => siteData.isLive,
      getScores: () => scores,
      getAuditResult: () => ({
        scores,
        runtimeError,
      }),
    };

    const site = siteData;
    site.getAudits = () => [auditData];

    return site;
  });
}

describe('GetSitesCommand', () => {
  let context;
  let slackContext;
  let dataAccessStub;
  let boltAppStub;
  let logStub;

  beforeEach(() => {
    dataAccessStub = {
      Site: {
        allWithLatestAudit: sinon.stub(),
      },
      Organization: {
        findByImsOrgId: sinon.stub().resolves(),
      },
    };
    boltAppStub = {
      action: sinon.stub(),
    };

    logStub = {
      error: sinon.stub(),
      info: sinon.stub(),
    };

    context = {
      dataAccess: dataAccessStub, boltApp: boltAppStub, log: logStub, env: { ORGANIZATION_ID_FRIENDS_FAMILY: 'F&F' },
    };
    slackContext = {
      say: sinon.spy(),
      client: {
        files: {
          uploadV2: sinon.stub().resolves(),
        },
      },
    };
  });

  describe('Initialization and BaseCommand Integration', () => {
    it('initializes correctly with base command properties', () => {
      const command = GetSitesCommand(context);

      expect(command.id).to.equal('get-all-sites');
      expect(command.name).to.equal('Get All Sites');
    });
  });

  describe('Handle Execution Method', () => {
    it('handles command execution with default parameters', async () => {
      dataAccessStub.Site.allWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution([], slackContext);

      expect(slackContext.say.called).to.be.true;
      // Additional assertions for message content
    });

    it('handles command execution with specific non-live and desktop', async () => {
      dataAccessStub.Site.allWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution(['non-live', 'desktop'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with live and mobile', async () => {
      dataAccessStub.Site.allWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution(['live', 'mobile'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with all', async () => {
      dataAccessStub.Site.allWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution(['all', 'mobile'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with no results', async () => {
      dataAccessStub.Site.allWithLatestAudit.resolves([]);
      const command = GetSitesCommand(context);

      await command.handleExecution(['all', 'mobile'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with delivery type aem_edge', async () => {
      dataAccessStub.Site.allWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution(['aem_edge'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with delivery type aem_cs', async () => {
      dataAccessStub.Site.allWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution(['aem_cs'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with delivery type aem_ams', async () => {
      dataAccessStub.Site.allWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution(['aem_ams'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with delivery type other', async () => {
      dataAccessStub.Site.allWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution(['other'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with non existing ims org id', async () => {
      dataAccessStub.Site.allWithLatestAudit.resolves(generateSites(3));
      const command = GetSitesCommand(context);

      await command.handleExecution(['ASASASASASASASASASASASAS@AdobeOrg'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with ims org id', async () => {
      const sites = generateSites(3);
      const org = {
        getId: () => 'some-org-id',
        getSites: () => sites,
      };
      dataAccessStub.Site.allWithLatestAudit.resolves(sites);
      dataAccessStub.Organization.findByImsOrgId.resolves(org);
      const command = GetSitesCommand(context);

      await command.handleExecution(['ASASASASASASASASASASASAS@AdobeOrg'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles command execution with unknown arg', async () => {
      dataAccessStub.Site.allWithLatestAudit.resolves(generateSites(2));
      const command = GetSitesCommand(context);

      await command.handleExecution(['unknown', 'unknown'], slackContext);

      expect(slackContext.say.called).to.be.true;
    });

    it('handles errors', async () => {
      dataAccessStub.Site.allWithLatestAudit.rejects(new Error('test error'));
      const command = GetSitesCommand(context);

      await command.handleExecution(['all', 'mobile'], slackContext);

      expect(slackContext.say.calledWith(':nuclear-warning: Oops! Something went wrong: test error')).to.be.true;
    });
  });

  describe('Site Formatting Logic', () => {
    it('formats a list of sites correctly', () => {
      const sites = generateSites(4);
      const formattedSites = formatSitesToCSV(sites).toString('utf-8');

      expect(formattedSites).to.equal('"Base URL","Delivery Type","Live Status","Go Live Date","GitHub URL","Performance Score","SEO Score","Accessibility Score","Best Practices Score","Error"\n'
        + '"https://site-0.com","aem_edge","Live","istoggledLiveAtDate","https://github.com/site-0","---","---","---","---","Lighthouse Error: No First Contentful Paint [NO_FCP]"\n'
        + '"https://site-1.com","aem_cs","Non-Live","createdAtDate","","90","80","70","60",""\n'
        + '"https://site-2.com","aem_edge","Live","istoggledLiveAtDate","https://github.com/site-2","90","80","70","60",""\n'
        + '"https://site-3.com","aem_cs","Non-Live","createdAtDate","","---","---","---","---","Lighthouse Error: No First Contentful Paint [NO_FCP]"');
    });
  });
});
