/*
 * Copyright 2024 Adobe. All rights reserved.
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

import { expect } from 'chai';

import { Config } from '../../../../src/models/site/config.js';

describe('Config Tests', () => {
  describe('Config Creation', () => {
    it('creates an Config with defaults when no data is provided', () => {
      const config = Config();
      expect(config.slack).to.be.undefined;
      expect(config.handlers).to.be.undefined;
    });

    it('creates an Config with provided data when data is valid', () => {
      const data = {
        slack: {
          channel: 'channel1',
          workspace: 'workspace1',
          invitedUserCount: 3,
        },
        handlers: {
          404: {
            mentions: { slack: ['id1'] },
          },
        },
      };
      const config = Config(data);
      expect(config.getSlackConfig().channel).to.equal('channel1');
      expect(config.getSlackConfig().workspace).to.equal('workspace1');
      expect(config.getSlackConfig().invitedUserCount).to.equal(3);
      expect(config.getSlackMentions(404)).to.deep.equal(['id1']);
    });

    it('throws an error when data is invalid', () => {
      const data = {
        slack: {
          channel: 'channel1',
          workspace: 'workspace1',
        },
        handlers: {
          404: {
            mentions: [{ email: ['id1'] }],
          },
        },
      };
      expect(() => Config(data)).to.throw('Configuration validation error: "handlers.404.mentions" must be of type object');
    });

    it('throws an error when invitedUserCount is invalid', () => {
      const data = {
        slack: {
          channel: 'channel1',
          workspace: 'workspace1',
          invitedUserCount: -12,
        },
      };
      expect(() => Config(data)).to.throw('Configuration validation error: "slack.invitedUserCount" must be greater than or equal to 0');
    });
  });

  describe('Config Methods', () => {
    it('correctly updates the Slack configuration', () => {
      const config = Config();
      config.updateSlackConfig('newChannel', 'newWorkspace', 20);

      const slackConfig = config.getSlackConfig();
      expect(slackConfig.channel).to.equal('newChannel');
      expect(slackConfig.workspace).to.equal('newWorkspace');
      expect(slackConfig.invitedUserCount).to.equal(20);
    });

    it('correctly updates the Slack mentions', () => {
      const config = Config();
      config.updateSlackMentions('404', ['id1', 'id2']);

      const slackMentions = config.getSlackMentions('404');
      expect(slackMentions).to.deep.equal(['id1', 'id2']);
    });

    it('correctly updates the excluded URLs', () => {
      const config = Config();
      config.updateExcludedURLs('404', ['url1', 'url2']);

      const excludedURLs = config.getExcludedURLs('404');
      expect(excludedURLs).to.deep.equal(['url1', 'url2']);
    });

    it('correctly updates the manual overrides', () => {
      const config = Config();
      const manualOverwrites = [
        { brokenTargetURL: 'url1', targetURL: 'url2' },
        { brokenTargetURL: 'url3', targetURL: 'url4' },
      ];
      config.updateManualOverwrites('broken-backlinks', manualOverwrites);

      const updatedManualOverwrites = config.getManualOverwrites('broken-backlinks');
      expect(updatedManualOverwrites).to.deep.equal(manualOverwrites);
    });

    it('correctly updates the fixedURLs array to an empty array', () => {
      const fixedURLs = [
        { brokenTargetURL: 'https://broken.co', targetURL: 'https://fixed.co' },
        { brokenTargetURL: 'https://broken.link.co', targetURL: 'https://fixed.link.co' },
      ];
      const config = Config();
      config.updateFixedURLs('broken-backlinks', fixedURLs);
      config.updateFixedURLs('broken-backlinks', []);
      expect(config.getFixedURLs('broken-backlinks')).to.be.an('array').that.is.empty;
    });

    it('correctly updates the imports array', () => {
      const config = Config();
      const imports = [
        { type: 'import1' },
        { type: 'import2' },
      ];
      config.updateImports(imports);

      const updatedImports = config.getImports();
      expect(updatedImports).to.deep.equal(imports);
    });

    it('should fail gracefully if handler is not present in the configuration', () => {
      const config = Config();
      expect(config.getSlackMentions('404')).to.be.undefined;
      expect(config.getHandlerConfig('404')).to.be.undefined;
      expect(config.getExcludedURLs('404')).to.be.undefined;
      expect(config.getManualOverwrites('404')).to.be.undefined;
      expect(config.getFixedURLs('404')).to.be.undefined;
      expect(config.getIncludedURLs('404')).to.be.undefined;
      expect(config.getGroupedURLs('404')).to.be.undefined;
    });
  });

  describe('Grouped URLs option', () => {
    it('Config creation with the groupedURLs option', () => {
      const groupedURLs = [
        { name: 'catalog', pattern: '/products/' },
        { name: 'blog', pattern: '/post/' },
      ];
      const data = {
        handlers: {
          'broken-backlinks': {
            groupedURLs,
          },
        },
      };
      const config = Config(data);
      expect(config.getGroupedURLs('broken-backlinks')).to.deep.equal(groupedURLs);
    });

    it('Config creation with an incorrect groupedURLs option type', () => {
      const data = {
        handlers: {
          'broken-backlinks': {
            groupedURLs: 'invalid-type',
          },
        },
      };
      expect(() => Config(data))
        .to.throw('Configuration validation error: "handlers.broken-backlinks.groupedURLs" must be an array');
    });

    it('Config creation with an incorrect groupedURLs option structure', () => {
      const data = {
        handlers: {
          'broken-backlinks': {
            groupedURLs: [
              { wrong: 'wrong', structure: 'structure' },
            ],
          },
        },
      };
      expect(() => Config(data)).to.throw('Configuration validation error: "handlers.broken-backlinks.groupedURLs[0].wrong" is not allowed');
    });

    it('Config updates grouped URLs with the groupedURLs option', () => {
      const groupedURLs = [
        { name: 'catalog', pattern: '/products/' },
        { name: 'blog', pattern: '/post/' },
      ];
      const config = Config();
      config.updateGroupedURLs('broken-backlinks', groupedURLs);
      expect(config.getGroupedURLs('broken-backlinks')).to.deep.equal(groupedURLs);
    });

    it('Config update with an incorrect groupedURLs option type', () => {
      const groupedURLs = 'invalid-type';
      const config = Config();
      expect(() => config.updateGroupedURLs('broken-backlinks', groupedURLs))
        .to.throw('Configuration validation error: "handlers.broken-backlinks.groupedURLs" must be an array');
      expect(config.getGroupedURLs('broken-backlinks')).to.deep.equal(groupedURLs);
    });

    it('Config update with an incorrect groupedURLs option structure', () => {
      const groupedURLs = [
        { wrong: 'wrong', structure: 'structure' },
      ];
      const config = Config();
      expect(() => config.updateGroupedURLs('broken-backlinks', groupedURLs))
        .to.throw('Configuration validation error: "handlers.broken-backlinks.groupedURLs[0].wrong" is not allowed');
      expect(config.getGroupedURLs('broken-backlinks')).to.deep.equal(groupedURLs);
    });
  });

  describe('fromDynamoItem Static Method', () => {
    it('correctly converts from DynamoDB item', () => {
      const dynamoItem = {
        slack: {
          channel: 'channel1',
          workspace: 'internal',
        },
        handlers: {
          404: {
            mentions: { slack: ['id1'] },
          },
        },
      };
      const config = Config.fromDynamoItem(dynamoItem);
      const slackMentions = config.getSlackMentions(404);
      const slackConfig = config.getSlackConfig();
      const isInternal = config.isInternalCustomer();
      expect(slackConfig.channel).to.equal('channel1');
      expect(slackConfig.workspace).to.equal('internal');
      expect(isInternal).to.equal(true);
      expect(slackMentions[0]).to.equal('id1');
    });
  });

  describe('toDynamoItem Static Method', () => {
    it('correctly converts to DynamoDB item format', () => {
      const data = Config({
        slack: {
          channel: 'channel1',
          workspace: 'external',
        },
        handlers: {
          404: {
            mentions: { slack: ['id1'] },
          },
        },
      });
      const dynamoItem = Config.toDynamoItem(data);
      const slackConfig = dynamoItem.slack;
      const slackMentions = dynamoItem.handlers[404].mentions.slack;
      expect(slackConfig.channel).to.equal('channel1');
      expect(slackConfig.workspace).to.equal('external');
      expect(data.isInternalCustomer()).to.equal(false);
      expect(slackMentions[0]).to.equal('id1');
    });
  });
});
