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
import { composeReply, extractURLFromSlackMessage } from '../../../../src/support/slack/actions/commons.js';
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
});
