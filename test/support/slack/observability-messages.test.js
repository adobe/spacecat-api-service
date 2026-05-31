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

import { expect } from 'chai';
import {
  enqueuedParentText,
  skippedStandaloneText,
} from '../../../src/support/slack/observability-messages.js';

describe('observability-messages', () => {
  describe('enqueuedParentText', () => {
    it('formats the enqueued parent message with a linked PR ref', () => {
      const text = enqueuedParentText({
        owner: 'adobe',
        repo: 'spacecat-api-service',
        prNumber: 456,
        action: 'review_requested',
        jobType: 'pr-review',
      });
      expect(text).to.equal(
        ':inbox_tray: *Review enqueued* '
        + '<https://github.com/adobe/spacecat-api-service/pull/456|adobe/spacecat-api-service #456>'
        + '\nreview_requested → pr-review',
      );
    });

    it('adds a requester/author line when both are known', () => {
      const text = enqueuedParentText({
        owner: 'adobe',
        repo: 'spacecat-api-service',
        prNumber: 456,
        action: 'review_requested',
        jobType: 'pr-review',
        requestedBy: 'alice',
        author: 'bob',
      });
      expect(text).to.include(
        '<https://github.com/adobe/spacecat-api-service/pull/456|adobe/spacecat-api-service #456>',
      );
      expect(text).to.include('requested by <https://github.com/alice|alice>');
      expect(text).to.include('author <https://github.com/bob|bob>');
    });

    it('adds only the requester when the author is absent', () => {
      const text = enqueuedParentText({
        owner: 'adobe',
        repo: 'foo',
        prNumber: 1,
        action: 'review_requested',
        jobType: 'pr-review',
        requestedBy: 'alice',
      });
      expect(text).to.include('requested by <https://github.com/alice|alice>');
      expect(text).to.not.include('author <');
    });

    it('omits the people line when neither requester nor author is known', () => {
      const text = enqueuedParentText({
        owner: 'adobe',
        repo: 'foo',
        prNumber: 1,
        action: 'review_requested',
        jobType: 'pr-review',
      });
      expect(text).to.not.include('requested by');
      expect(text).to.not.include('author');
    });

    it('escapes Slack-special characters in a login', () => {
      const text = enqueuedParentText({
        owner: 'adobe',
        repo: 'foo',
        prNumber: 1,
        action: 'review_requested',
        jobType: 'pr-review',
        requestedBy: 'a<b>c',
        author: 'bob',
      });
      expect(text).to.include('a&lt;b&gt;c'); // label escaped
      expect(text).to.not.include('|a<b>c>');
    });
  });

  describe('skippedStandaloneText', () => {
    it('formats the standalone skip message with reason', () => {
      const text = skippedStandaloneText({
        owner: 'adobe',
        repo: 'foo',
        prNumber: 12,
        reason: 'draft PR',
      });
      expect(text).to.equal(':fast_forward: *Skipped* `adobe/foo` #12 - draft PR');
    });

    it('escapes Slack-special characters in the skip reason', () => {
      const text = skippedStandaloneText({
        owner: 'adobe',
        repo: 'foo',
        prNumber: 12,
        reason: 'non-default branch: <!here>',
      });
      expect(text).to.include('&lt;!here&gt;');
      expect(text).to.not.include('<!here>');
    });
  });
});
