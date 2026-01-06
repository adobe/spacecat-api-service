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
    it('formats blocked bot protection message for production', () => {
      const result = formatBotProtectionSlackMessage({
        siteUrl: 'https://example.com',
        botProtection: {
          type: 'cloudflare',
          confidence: 0.99,
          reason: 'Challenge page detected',
        },
        environment: 'prod',
      });

      expect(result).to.include('Bot Protection Detected');
      expect(result).to.include('https://example.com');
      expect(result).to.include('cloudflare');
      expect(result).to.include('99%');
      expect(result).to.include('Challenge page detected');
      expect(result).to.include('Production IPs');
      expect(result).to.include('Onboarding stopped');
      expect(result).to.include('`3.218.16.42`');
    });

    it('formats blocked bot protection message for development', () => {
      const result = formatBotProtectionSlackMessage({
        siteUrl: 'https://dev-example.com',
        botProtection: {
          type: 'imperva',
          confidence: 0.95,
        },
        environment: 'dev',
      });

      expect(result).to.include('Bot Protection Detected');
      expect(result).to.include('https://dev-example.com');
      expect(result).to.include('imperva');
      expect(result).to.include('95%');
      expect(result).to.include('Development IPs');
      expect(result).to.include('`44.218.57.115`');
    });

    it('formats allowed infrastructure message for production', () => {
      const result = formatBotProtectionSlackMessage({
        siteUrl: 'https://allowed.com',
        botProtection: {
          type: 'cloudflare-allowed',
          confidence: 1.0,
          reason: 'Infrastructure present but allowing requests',
        },
        environment: 'prod',
      });

      expect(result).to.include('Bot Protection Infrastructure Detected');
      expect(result).to.include('https://allowed.com');
      expect(result).to.include('cloudflare-allowed');
      expect(result).to.include('100%');
      expect(result).to.include('Infrastructure present but allowing requests');
      expect(result).to.include('SpaceCat can currently access the site');
      expect(result).to.include('Production IPs');
      expect(result).to.include('`3.218.16.42`');
      expect(result).to.not.include('Onboarding stopped');
    });

    it('formats allowed infrastructure message for development', () => {
      const result = formatBotProtectionSlackMessage({
        siteUrl: 'https://allowed-dev.com',
        botProtection: {
          type: 'akamai-allowed',
          confidence: 1.0,
        },
        environment: 'dev',
      });

      expect(result).to.include('Bot Protection Infrastructure Detected');
      expect(result).to.include('https://allowed-dev.com');
      expect(result).to.include('akamai-allowed');
      expect(result).to.include('100%');
      expect(result).to.include('SpaceCat can currently access the site');
      expect(result).to.include('Development IPs');
      expect(result).to.include('`44.218.57.115`');
    });

    it('formats message without reason', () => {
      const result = formatBotProtectionSlackMessage({
        siteUrl: 'https://no-reason.com',
        botProtection: {
          type: 'http2-block',
          confidence: 0.9,
        },
        environment: 'prod',
      });

      expect(result).to.include('Bot Protection Detected');
      expect(result).to.include('https://no-reason.com');
      expect(result).to.include('http2-block');
      expect(result).to.include('90%');
      expect(result).to.not.include('Reason:');
    });

    it('defaults to production environment when not specified', () => {
      const result = formatBotProtectionSlackMessage({
        siteUrl: 'https://default-env.com',
        botProtection: {
          type: 'cloudflare',
          confidence: 0.99,
        },
      });

      expect(result).to.include('Production IPs');
      expect(result).to.include('`3.218.16.42`');
    });
  });
});
