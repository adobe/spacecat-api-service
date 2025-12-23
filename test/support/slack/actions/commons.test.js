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
import {
  composeReply,
  extractURLFromSlackMessage,
  formatBotProtectionSlackMessage,
} from '../../../../src/support/slack/actions/commons.js';
import {
  slackActionResponse,
  slackApprovedFriendsFamilyReply,
  slackApprovedReply,
  slackIgnoredReply,
} from './slack-fixtures.js';

describe('Slack action commons', () => {
  describe('extractURLFromSlackMessage', () => {
    it('should extract URL from slack message', () => {
      const slackMessage = 'I discovered a new site on Edge Delivery Services: *<https://easablecare.com|https://easablecare.com>*. Would you like me to include it in the Star Catalogue? (Source: *CDN*';

      expect(extractURLFromSlackMessage(slackMessage)).to.equal('https://easablecare.com');
    });
  });

  describe('compose reply', () => {
    it('composes the approved as customer reply', () => {
      const { blocks } = slackActionResponse.message;
      expect(composeReply({
        blocks,
        username: 'some-user',
        approved: true,
      })).to.eql(slackApprovedReply);
    });

    it('composes the approved as friends and family reply', () => {
      const { blocks } = slackActionResponse.message;
      expect(composeReply({
        blocks,
        username: 'some-user',
        isFnF: true,
        approved: true,
      })).to.eql(slackApprovedFriendsFamilyReply);
    });

    it('composes the ignored reply', () => {
      const { blocks } = slackActionResponse.message;
      expect(composeReply({
        blocks,
        username: 'some-user',
        approved: false,
      })).to.eql(slackIgnoredReply);
    });
  });

  describe('formatBotProtectionSlackMessage', () => {
    it('formats bot protection message for production environment', () => {
      const result = formatBotProtectionSlackMessage({
        siteUrl: 'https://example.com',
        botProtection: {
          type: 'cloudflare',
          confidence: 0.95,
          reason: 'Challenge page detected',
        },
        environment: 'prod',
      });

      expect(result).to.be.a('string');
      expect(result).to.include('Bot Protection Detected');
      expect(result).to.include('https://example.com');
      expect(result).to.include('cloudflare');
      expect(result).to.include('95%');
      expect(result).to.include('Challenge page detected');
      expect(result).to.include('Production IPs to allowlist');
      expect(result).to.include('Spacecat/1.0');
      expect(result).to.include('Onboarding stopped due to the following reasons:');
      expect(result).to.include('Action Required:');
    });

    it('formats bot protection message for development environment', () => {
      const result = formatBotProtectionSlackMessage({
        siteUrl: 'https://example.com',
        botProtection: {
          type: 'imperva',
          confidence: 0.85,
        },
        environment: 'dev',
      });

      expect(result).to.include('Bot Protection Detected');
      expect(result).to.include('imperva');
      expect(result).to.include('85%');
      expect(result).to.include('Development IPs to allowlist');
    });

    it('defaults to production environment when not specified', () => {
      const result = formatBotProtectionSlackMessage({
        siteUrl: 'https://example.com',
        botProtection: {
          type: 'akamai',
          confidence: 0.9,
        },
      });

      expect(result).to.include('Production IPs to allowlist');
    });

    it('handles missing reason gracefully', () => {
      const result = formatBotProtectionSlackMessage({
        siteUrl: 'https://example.com',
        botProtection: {
          type: 'datadome',
          confidence: 0.8,
        },
        environment: 'prod',
      });

      expect(result).to.include('datadome');
      expect(result).to.include('80%');
      expect(result).not.to.include('*Reason:*');
    });

    it('includes all required sections', () => {
      const result = formatBotProtectionSlackMessage({
        siteUrl: 'https://example.com',
        botProtection: {
          type: 'cloudflare',
          confidence: 0.95,
        },
        environment: 'prod',
      });

      expect(result).to.include('*Site:*');
      expect(result).to.include('*Protection Type:*');
      expect(result).to.include('*Confidence:*');
      expect(result).to.include('*Onboarding stopped due to the following reasons:*');
      expect(result).to.include('cannot access the site');
      expect(result).to.include('*Action Required:*');
      expect(result).to.include('*User-Agent to allowlist:*');
      expect(result).to.include('re-run the onboard command');
    });

    it('should format informational message for allowed bot protection', () => {
      const result = formatBotProtectionSlackMessage({
        siteUrl: 'https://example.com',
        botProtection: {
          type: 'cloudflare-allowed',
          confidence: 1.0,
          reason: 'Cloudflare detected but allowing requests',
        },
        environment: 'dev',
      });

      expect(result).to.include('*Site:*');
      expect(result).to.include('cloudflare-allowed');
      expect(result).to.include('*Current Status:*');
      expect(result).to.include('can currently access the site');
      expect(result).to.include('Bot protection infrastructure is present');
      expect(result).to.include('AWS Lambda IPs may be allowlisted');
      expect(result).to.include('If audits fail');
      expect(result).to.include('*User-Agent to allowlist:*');
      expect(result).to.not.include('*Onboarding stopped');
      expect(result).to.not.include('*Action Required:*');
    });

    it('should format message for imperva-allowed', () => {
      const result = formatBotProtectionSlackMessage({
        siteUrl: 'https://example.com',
        botProtection: {
          type: 'imperva-allowed',
          confidence: 1.0,
        },
        environment: 'prod',
      });

      expect(result).to.include('imperva-allowed');
      expect(result).to.include('*Current Status:*');
      expect(result).to.include('can currently access');
      expect(result).to.not.include('*Onboarding stopped');
    });
  });
});
