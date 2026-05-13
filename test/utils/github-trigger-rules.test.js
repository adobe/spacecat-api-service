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
import { getSkipReason, EVENT_JOB_MAP } from '../../src/utils/github-trigger-rules.js';

describe('github-trigger-rules', () => {
  describe('EVENT_JOB_MAP', () => {
    it('maps pull_request to pr-review', () => {
      expect(EVENT_JOB_MAP.pull_request).to.equal('pr-review');
    });

    it('has no mapping for issue_comment', () => {
      expect(EVENT_JOB_MAP.issue_comment).to.be.undefined;
    });
  });

  describe('getSkipReason', () => {
    const defaultEnv = { GITHUB_APP_SLUG: 'mysticat' };

    const baseData = {
      pull_request: {
        draft: false,
        base: { ref: 'main' },
      },
      repository: { default_branch: 'main' },
      sender: { type: 'User' },
    };

    describe('review_requested trigger', () => {
      it('returns null when reviewer is the app', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'mysticat[bot]' },
        };
        expect(getSkipReason(data, 'review_requested', defaultEnv)).to.be.null;
      });

      it('returns skip reason when reviewer is not the app', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'some-human' },
        };
        const reason = getSkipReason(data, 'review_requested', defaultEnv);
        expect(reason).to.include('some-human');
        expect(reason).to.include('mysticat');
      });
    });

    describe('GITHUB_REVIEWER_LOGIN override', () => {
      it('returns null when reviewer matches GITHUB_REVIEWER_LOGIN (plain user)', () => {
        const env = { GITHUB_APP_SLUG: 'mysticat-bot-dev', GITHUB_REVIEWER_LOGIN: 'aighagent' };
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'aighagent' },
        };
        expect(getSkipReason(data, 'review_requested', env)).to.be.null;
      });

      it('returns skip reason when reviewer does not match GITHUB_REVIEWER_LOGIN', () => {
        const env = { GITHUB_APP_SLUG: 'mysticat-bot-dev', GITHUB_REVIEWER_LOGIN: 'aighagent' };
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'mysticat-bot-dev[bot]' },
        };
        const reason = getSkipReason(data, 'review_requested', env);
        expect(reason).to.include('mysticat-bot-dev[bot]');
        expect(reason).to.include('aighagent');
      });

      it('falls back to [bot] suffix when GITHUB_REVIEWER_LOGIN is absent', () => {
        const env = { GITHUB_APP_SLUG: 'mysticat-bot-dev' };
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'mysticat-bot-dev[bot]' },
        };
        expect(getSkipReason(data, 'review_requested', env)).to.be.null;
      });

      it('falls back to [bot] suffix when GITHUB_REVIEWER_LOGIN is empty string', () => {
        const env = { GITHUB_APP_SLUG: 'mysticat-bot-dev', GITHUB_REVIEWER_LOGIN: '' };
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'mysticat-bot-dev[bot]' },
        };
        expect(getSkipReason(data, 'review_requested', env)).to.be.null;
      });
    });

    describe('labeled trigger (disabled)', () => {
      // Labeled triggers were disabled because GitHub does not count
      // label-triggered reviews toward branch protection / merge
      // requirements. All labeled events now fall through to the
      // unsupported-action skip path.
      it('returns unsupported-action skip reason regardless of label name', () => {
        const data = {
          ...baseData,
          action: 'labeled',
          label: { name: 'mysticat:review-requested' },
        };
        expect(getSkipReason(data, 'labeled', defaultEnv)).to.include('unsupported action');
      });

      it('ignores MYSTICAT_REVIEW_LABEL env override', () => {
        // The env hook is left in place for future re-enable but is
        // currently a no-op.
        const devEnv = {
          ...defaultEnv,
          MYSTICAT_REVIEW_LABEL: 'mysticat-dev:review-requested',
        };
        const data = {
          ...baseData,
          action: 'labeled',
          label: { name: 'mysticat-dev:review-requested' },
        };
        expect(getSkipReason(data, 'labeled', devEnv)).to.include('unsupported action');
      });
    });

    describe('unsupported actions', () => {
      it('returns skip reason for opened (auto-trigger deferred)', () => {
        const data = { ...baseData, action: 'opened' };
        expect(getSkipReason(data, 'opened', defaultEnv)).to.include('auto-trigger');
      });

      it('returns skip reason for ready_for_review (auto-trigger deferred)', () => {
        const data = { ...baseData, action: 'ready_for_review' };
        expect(getSkipReason(data, 'ready_for_review', defaultEnv)).to.include('auto-trigger');
      });

      it('returns skip reason for closed', () => {
        const data = { ...baseData, action: 'closed' };
        expect(getSkipReason(data, 'closed', defaultEnv)).to.include('unsupported action');
      });
    });

    describe('skip rules (review_requested only — labeled is disabled)', () => {
      const scenarios = [
        {
          name: 'review_requested',
          action: 'review_requested',
          matchFields: { requested_reviewer: { login: 'mysticat[bot]' } },
        },
      ];

      scenarios.forEach(({ name, action, matchFields }) => {
        describe(`for action ${name}`, () => {
          it('returns skip reason for draft PR', () => {
            const data = {
              ...baseData,
              action,
              ...matchFields,
              pull_request: { ...baseData.pull_request, draft: true },
            };
            expect(getSkipReason(data, action, defaultEnv)).to.equal('draft PR');
          });

          it('returns skip reason for bot sender', () => {
            const data = {
              ...baseData,
              action,
              ...matchFields,
              sender: { type: 'Bot' },
            };
            expect(getSkipReason(data, action, defaultEnv)).to.equal('bot sender');
          });

          it('returns skip reason for non-default branch', () => {
            const data = {
              ...baseData,
              action,
              ...matchFields,
              pull_request: { ...baseData.pull_request, base: { ref: 'release/v2' } },
            };
            const reason = getSkipReason(data, action, defaultEnv);
            expect(reason).to.include('non-default branch');
          });
        });
      });
    });

    // Note: missing GITHUB_APP_SLUG is validated at controller entry (returns 500),
    // not by getSkipReason. The controller is the gate; this function only sees
    // calls with a validated appSlug.
  });
});
