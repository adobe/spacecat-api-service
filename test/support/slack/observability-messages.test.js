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
    it('formats the enqueued parent message', () => {
      const text = enqueuedParentText({
        owner: 'adobe',
        repo: 'spacecat-api-service',
        prNumber: 456,
        action: 'review_requested',
        jobType: 'pr-review',
      });
      expect(text).to.equal(
        ':inbox_tray: *Review enqueued* `adobe/spacecat-api-service` #456\nreview_requested → pr-review',
      );
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
