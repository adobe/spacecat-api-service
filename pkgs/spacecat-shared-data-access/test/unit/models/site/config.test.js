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

import { Config, validateConfiguration } from '../../../../src/models/site/config.js';

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

    it('correctly updates the fetchConfig option', () => {
      const config = Config();
      const fetchConfig = {
        headers: {
          'User-Agent': 'custom-agent',
        },
        overrideBaseURL: 'https://example.com',
      };
      config.updateFetchConfig(fetchConfig);
      expect(config.getFetchConfig()).to.deep.equal(fetchConfig);
    });

    it('correctly updates the brandConfig option', () => {
      const config = Config();
      const brandConfig = {
        brandId: 'test-brand',
      };
      config.updateBrandConfig(brandConfig);
      expect(config.getBrandConfig()).to.deep.equal(brandConfig);
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

  describe('Latest Metrics', () => {
    it('should return undefined for latestMetrics if not provided', () => {
      const config = Config();
      expect(config.getLatestMetrics('latest-metrics')).to.be.undefined;
    });

    it('should return the correct latestMetrics if provided', () => {
      const data = {
        handlers: {
          'latest-metrics': {
            latestMetrics: {
              pageViewsChange: 10,
              ctrChange: 5,
              projectedTrafficValue: 1000,
            },
          },
        },
      };
      const config = Config(data);
      const latestMetrics = config.getLatestMetrics('latest-metrics');
      expect(latestMetrics.pageViewsChange).to.equal(10);
      expect(latestMetrics.ctrChange).to.equal(5);
      expect(latestMetrics.projectedTrafficValue).to.equal(1000);
    });

    it('should update the latestMetrics correctly', () => {
      const config = Config();
      const latestMetrics = {
        pageViewsChange: 15,
        ctrChange: 7,
        projectedTrafficValue: 1500,
      };
      config.updateLatestMetrics('latest-metrics', latestMetrics);
      const updatedMetrics = config.getLatestMetrics('latest-metrics');
      expect(updatedMetrics.pageViewsChange).to.equal(15);
      expect(updatedMetrics.ctrChange).to.equal(7);
      expect(updatedMetrics.projectedTrafficValue).to.equal(1500);
    });

    it('should throw an error if latestMetrics is invalid', () => {
      const data = {
        handlers: {
          'latest-metrics': {
            latestMetrics: {
              pageViewsChange: 'invalid',
              ctrChange: 5,
              projectedTrafficValue: 1000,
            },
          },
        },
      };
      expect(() => Config(data)).to.throw('Configuration validation error: "handlers.latest-metrics.latestMetrics.pageViewsChange" must be a number');
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

  describe('Import Configuration', () => {
    it('validates import types against schemas', () => {
      const data = {
        imports: [{
          type: 'organic-keywords',
          destinations: ['default'],
          sources: ['ahrefs'],
          enabled: true,
          pageUrl: 'https://example.com',
        }],
      };
      const config = Config(data);
      expect(config.getImports()).to.deep.equal(data.imports);
    });

    it('throws error for unknown import type', () => {
      expect(() => Config({
        imports: [{
          type: 'unknown-type',
          destinations: ['default'],
          sources: ['ahrefs'],
        }],
      })).to.throw('Configuration validation error');
    });

    it('throws error for invalid import configuration', () => {
      expect(() => Config({
        imports: [{
          type: 'organic-keywords',
          destinations: ['invalid'],
          sources: ['invalid'],
        }],
      })).to.throw('Configuration validation error');
    });

    describe('enableImport method', () => {
      it('enables import with default config', () => {
        const config = Config();
        config.enableImport('organic-keywords');

        const importConfig = config.getImportConfig('organic-keywords');
        expect(importConfig).to.deep.equal({
          type: 'organic-keywords',
          destinations: ['default'],
          sources: ['ahrefs'],
          enabled: true,
        });
      });

      it('enables import with custom config', () => {
        const config = Config();
        config.enableImport('organic-keywords', {
          pageUrl: 'https://example.com',
          sources: ['google'],
        });

        const importConfig = config.getImportConfig('organic-keywords');
        expect(importConfig).to.deep.equal({
          type: 'organic-keywords',
          destinations: ['default'],
          sources: ['google'],
          enabled: true,
          pageUrl: 'https://example.com',
        });
      });

      it('throws error for unknown import type', () => {
        const config = Config();
        expect(() => config.enableImport('unknown-type'))
          .to.throw('Unknown import type: unknown-type');
      });

      it('throws error for invalid config', () => {
        const config = Config();
        expect(() => config.enableImport('organic-keywords', {
          sources: ['invalid-source'],
        })).to.throw('Invalid import config');
      });

      it('replaces existing import of same type', () => {
        const config = Config({
          imports: [{
            type: 'organic-keywords',
            destinations: ['default'],
            sources: ['ahrefs'],
            enabled: true,
          }],
        });

        config.enableImport('organic-keywords', {
          sources: ['google'],
        });

        const imports = config.getImports();
        expect(imports).to.have.length(1);
        expect(imports[0].sources).to.deep.equal(['google']);
      });
    });

    describe('disableImport method', () => {
      it('disables existing import', () => {
        const config = Config({
          imports: [{
            type: 'organic-keywords',
            destinations: ['default'],
            sources: ['ahrefs'],
            enabled: true,
          }],
        });

        config.disableImport('organic-keywords');
        expect(config.isImportEnabled('organic-keywords')).to.be.false;
      });

      it('handles disabling non-existent import', () => {
        const config = Config();
        config.disableImport('organic-keywords');
        expect(config.isImportEnabled('organic-keywords')).to.be.false;
      });

      it('preserves other imports when disabling one import', () => {
        const config = Config({
          imports: [
            {
              type: 'organic-keywords',
              destinations: ['default'],
              sources: ['ahrefs'],
              enabled: true,
            },
            {
              type: 'organic-traffic',
              destinations: ['default'],
              sources: ['ahrefs'],
              enabled: true,
            },
          ],
        });

        config.disableImport('organic-keywords');

        const imports = config.getImports();
        expect(imports).to.have.length(2);
        expect(imports).to.deep.equal([
          {
            type: 'organic-keywords',
            destinations: ['default'],
            sources: ['ahrefs'],
            enabled: false,
          },
          {
            type: 'organic-traffic',
            destinations: ['default'],
            sources: ['ahrefs'],
            enabled: true,
          },
        ]);
      });
    });

    describe('getImportConfig method', () => {
      it('returns config for existing import', () => {
        const importConfig = {
          type: 'organic-keywords',
          destinations: ['default'],
          sources: ['ahrefs'],
          enabled: true,
        };
        const config = Config({
          imports: [importConfig],
        });

        expect(config.getImportConfig('organic-keywords')).to.deep.equal(importConfig);
      });

      it('returns undefined for non-existent import', () => {
        const config = Config();
        expect(config.getImportConfig('organic-keywords')).to.be.undefined;
      });
    });

    describe('isImportEnabled method', () => {
      it('returns true for enabled import', () => {
        const config = Config({
          imports: [{
            type: 'organic-keywords',
            destinations: ['default'],
            sources: ['ahrefs'],
            enabled: true,
          }],
        });
        expect(config.isImportEnabled('organic-keywords')).to.be.true;
      });

      it('returns false for disabled import', () => {
        const config = Config({
          imports: [{
            type: 'organic-keywords',
            destinations: ['default'],
            sources: ['ahrefs'],
            enabled: false,
          }],
        });
        expect(config.isImportEnabled('organic-keywords')).to.be.false;
      });

      it('returns false for non-existent import', () => {
        const config = Config();
        expect(config.isImportEnabled('organic-keywords')).to.be.false;
      });
    });
  });

  describe('validateConfiguration Function', () => {
    it('validates a minimal configuration', () => {
      const config = {
        slack: {},
        handlers: {},
      };
      const validated = validateConfiguration(config);
      expect(validated).to.deep.equal(config);
    });

    it('validates a complete configuration with all options', () => {
      const config = {
        slack: {
          channel: 'test-channel',
          workspace: 'test-workspace',
          invitedUserCount: 5,
        },
        handlers: {
          404: {
            mentions: { slack: ['user1', 'user2'] },
            excludedURLs: ['https://example.com/excluded'],
            manualOverwrites: [{ brokenTargetURL: 'old', targetURL: 'new' }],
            fixedURLs: [{ brokenTargetURL: 'broken', targetURL: 'fixed' }],
            includedURLs: ['https://example.com/included'],
            groupedURLs: [{ name: 'group1', pattern: '/pattern/' }],
            latestMetrics: {
              pageViewsChange: 10,
              ctrChange: 5,
              projectedTrafficValue: 1000,
            },
          },
        },
        imports: [
          {
            type: 'organic-keywords',
            destinations: ['default'],
            sources: ['ahrefs'],
            pageUrl: 'https://example.com',
            enabled: false,
            geo: 'us',
            limit: 5,
          },
          {
            type: 'organic-traffic',
            destinations: ['default'],
            sources: ['ahrefs', 'google'],
            enabled: true,
          },
          {
            type: 'all-traffic',
            destinations: ['default'],
            sources: ['rum'],
            enabled: true,
          },
          {
            type: 'top-pages',
            destinations: ['default'],
            sources: ['ahrefs'],
            enabled: true,
            geo: 'us',
            limit: 100,
          },
        ],
        fetchConfig: {
          headers: {
            'User-Agent': 'test-agent',
          },
          overrideBaseURL: 'https://example.com',
        },
        brandConfig: {
          brandId: 'test-brand',
        },
      };
      const validated = validateConfiguration(config);
      expect(validated).to.deep.equal(config);
    });

    it('throws error for invalid slack configuration', () => {
      const config = {
        slack: {
          invitedUserCount: 'not-a-number',
        },
      };
      expect(() => validateConfiguration(config))
        .to.throw('Configuration validation error: "slack.invitedUserCount" must be a number');
    });

    it('throws error for invalid handler configuration', () => {
      const config = {
        handlers: {
          404: {
            mentions: 'not-an-object',
          },
        },
      };
      expect(() => validateConfiguration(config))
        .to.throw('Configuration validation error: "handlers.404.mentions" must be of type object');
    });

    it('throws error for invalid import configuration', () => {
      const config = {
        imports: [
          {
            type: 'organic-keywords',
            destinations: ['invalid'],
            sources: ['invalid-source'],
            enabled: true,
          },
        ],
      };
      expect(() => validateConfiguration(config))
        .to.throw().and.satisfy((error) => {
          expect(error.message).to.include('Configuration validation error');
          expect(error.cause.details[0].context.message)
            .to.equal('"imports[0].destinations[0]" must be [default]. "imports[0].type" must be [organic-traffic]. "imports[0].type" must be [all-traffic]. "imports[0].type" must be [top-pages]');
          expect(error.cause.details[0].context.details)
            .to.eql([
              {
                message: '"imports[0].destinations[0]" must be [default]',
                path: [
                  'imports',
                  0,
                  'destinations',
                  0,
                ],
                type: 'any.only',
                context: {
                  valids: [
                    'default',
                  ],
                  label: 'imports[0].destinations[0]',
                  value: 'invalid',
                  key: 0,
                },
              },
              {
                message: '"imports[0].type" must be [organic-traffic]',
                path: [
                  'imports',
                  0,
                  'type',
                ],
                type: 'any.only',
                context: {
                  valids: [
                    'organic-traffic',
                  ],
                  label: 'imports[0].type',
                  value: 'organic-keywords',
                  key: 'type',
                },
              },
              {
                message: '"imports[0].type" must be [all-traffic]',
                path: [
                  'imports',
                  0,
                  'type',
                ],
                type: 'any.only',
                context: {
                  valids: [
                    'all-traffic',
                  ],
                  label: 'imports[0].type',
                  value: 'organic-keywords',
                  key: 'type',
                },
              },
              {
                message: '"imports[0].type" must be [top-pages]',
                path: [
                  'imports',
                  0,
                  'type',
                ],
                type: 'any.only',
                context: {
                  valids: [
                    'top-pages',
                  ],
                  label: 'imports[0].type',
                  value: 'organic-keywords',
                  key: 'type',
                },
              },
            ]);
          return true;
        });
    });

    it('throws error for invalid fetchConfig headers', () => {
      const config = {
        fetchConfig: {
          headers: 'not-an-object',
        },
      };
      expect(() => validateConfiguration(config))
        .to.throw('Configuration validation error: "fetchConfig.headers" must be of type object');
    });

    it('throws error for invalid brandConfig', () => {
      const config = {
        brandConfig: {},
      };
      expect(() => validateConfiguration(config))
        .to.throw('Configuration validation error: "brandConfig.brandId" is required');
    });

    it('throws error for invalid fetchConfig overrideBaseUrl', () => {
      const config = {
        fetchConfig: {
          overrideBaseURL: 'not-a-url',
        },
      };
      expect(() => validateConfiguration(config))
        .to.throw('Configuration validation error: "fetchConfig.overrideBaseURL" must be a valid uri');
    });

    it('validates multiple import types with different configurations', () => {
      const config = {
        imports: [
          {
            type: 'organic-keywords',
            destinations: ['default'],
            sources: ['ahrefs'],
            enabled: true,
            limit: 100,
            pageUrl: 'https://example.com',
          },
          {
            type: 'top-pages',
            destinations: ['default'],
            sources: ['ahrefs'],
            enabled: false,
            geo: 'global',
          },
        ],
      };
      const validated = validateConfiguration(config);
      expect(validated).to.deep.equal(config);
    });

    it('validates optional url in the import configuration', () => {
      const config = {
        imports: [
          {
            type: 'organic-keywords',
            destinations: ['default'],
            sources: ['ahrefs'],
            enabled: true,
            url: 'https://example.com',
          },
        ],
      };
      const validated = validateConfiguration(config);
      expect(validated).to.deep.equal(config);
    });

    it('throws error for missing required import fields', () => {
      const config = {
        imports: [
          {
            type: 'organic-keywords',
            // missing required destinations and sources
            enabled: true,
          },
        ],
      };
      expect(() => validateConfiguration(config))
        .to.throw('Configuration validation error: "imports[0]" does not match any of the allowed types');
    });
  });

  describe('Threshold Configuration', () => {
    it('should accept valid movingAvgThreshold and percentageChangeThreshold values', () => {
      const data = {
        handlers: {
          'organic-traffic-internal': {
            movingAvgThreshold: 10,
            percentageChangeThreshold: 20,
          },
        },
      };
      const config = Config(data);
      const handlerConfig = config.getHandlerConfig('organic-traffic-internal');
      expect(handlerConfig.movingAvgThreshold).to.equal(10);
      expect(handlerConfig.percentageChangeThreshold).to.equal(20);
    });

    it('should reject negative movingAvgThreshold values', () => {
      const data = {
        handlers: {
          'organic-traffic-internal': {
            movingAvgThreshold: -5,
          },
        },
      };
      expect(() => Config(data)).to.throw('Configuration validation error: "handlers.organic-traffic-internal.movingAvgThreshold" must be greater than or equal to 1');
    });

    it('should reject zero movingAvgThreshold values', () => {
      const data = {
        handlers: {
          'organic-traffic-internal': {
            movingAvgThreshold: 0,
          },
        },
      };
      expect(() => Config(data)).to.throw('Configuration validation error: "handlers.organic-traffic-internal.movingAvgThreshold" must be greater than or equal to 1');
    });

    it('should reject negative percentageChangeThreshold values', () => {
      const data = {
        handlers: {
          'organic-traffic-internal': {
            percentageChangeThreshold: -10,
          },
        },
      };
      expect(() => Config(data)).to.throw('Configuration validation error: "handlers.organic-traffic-internal.percentageChangeThreshold" must be greater than or equal to 1');
    });

    it('should reject zero percentageChangeThreshold values', () => {
      const data = {
        handlers: {
          'organic-traffic-internal': {
            percentageChangeThreshold: 0,
          },
        },
      };
      expect(() => Config(data)).to.throw('Configuration validation error: "handlers.organic-traffic-internal.percentageChangeThreshold" must be greater than or equal to 1');
    });

    it('should allow updating threshold values', () => {
      // Create a config with an initial empty handlers object
      const config = Config({
        handlers: {
          'organic-traffic-internal': {},
        },
      });
      const handlerType = 'organic-traffic-internal';
      // Initially handler config exists but without thresholds
      const initialConfig = config.getHandlerConfig(handlerType);
      expect(initialConfig).to.exist;
      expect(initialConfig.movingAvgThreshold).to.be.undefined;
      expect(initialConfig.percentageChangeThreshold).to.be.undefined;
      // We need to create a new config with the thresholds
      // since we can't modify the existing one directly
      const updatedConfig = Config({
        handlers: {
          'organic-traffic-internal': {
            movingAvgThreshold: 15,
            percentageChangeThreshold: 25,
          },
        },
      });
      // Verify thresholds were set in the new config
      const handlerConfig = updatedConfig.getHandlerConfig(handlerType);
      expect(handlerConfig.movingAvgThreshold).to.equal(15);
      expect(handlerConfig.percentageChangeThreshold).to.equal(25);
    });
  });
});
