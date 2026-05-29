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
import { getSkipReason, EVENT_JOB_MAP, isMysticatTargetedSkip } from '../../src/utils/github-trigger-rules.js';

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

    it('uses the explicit appSlug arg over env.GITHUB_APP_SLUG when provided', () => {
      // A ghec target whose appSlug differs from env.GITHUB_APP_SLUG: the explicit
      // arg must form the expected bot reviewer login.
      const data = {
        pull_request: { draft: false, base: { ref: 'main' } },
        requested_reviewer: { login: 'ghec-bot[bot]' },
        repository: { default_branch: 'main' },
        sender: { type: 'User' },
      };
      const env = { GITHUB_APP_SLUG: 'mysticat' };
      // Without the override, expected reviewer is mysticat[bot] -> would skip.
      expect(getSkipReason(data, 'review_requested', env)).to.match(/is not mysticat\[bot\]/);
      // With the override, expected reviewer is ghec-bot[bot] -> matches -> null.
      expect(getSkipReason(data, 'review_requested', env, 'ghec-bot')).to.be.null;
    });
  });

  describe('isMysticatTargetedSkip', () => {
    it('returns false for null', () => {
      expect(isMysticatTargetedSkip(null)).to.be.false;
    });

    it('returns false for undefined', () => {
      expect(isMysticatTargetedSkip(undefined)).to.be.false;
    });

    it('returns true for draft PR', () => {
      expect(isMysticatTargetedSkip('draft PR')).to.be.true;
    });

    it('returns true for bot sender', () => {
      expect(isMysticatTargetedSkip('bot sender')).to.be.true;
    });

    it('returns true for non-default branch (with ref suffix)', () => {
      expect(isMysticatTargetedSkip('non-default branch: release/v2')).to.be.true;
    });

    it('returns false for foreign reviewer', () => {
      expect(isMysticatTargetedSkip('reviewer some-human is not mysticat[bot]')).to.be.false;
    });

    it('returns false for unsupported action', () => {
      expect(isMysticatTargetedSkip('unsupported action: closed')).to.be.false;
    });

    it('returns false for auto-trigger', () => {
      expect(isMysticatTargetedSkip('auto-trigger not yet supported: opened')).to.be.false;
    });

    // Drift guard: the classifier must agree with what getSkipReason actually emits.
    describe('stays in lockstep with getSkipReason', () => {
      const env = { GITHUB_APP_SLUG: 'mysticat' };
      const base = {
        action: 'review_requested',
        requested_reviewer: { login: 'mysticat[bot]' },
        repository: { default_branch: 'main' },
        sender: { type: 'User' },
        pull_request: { draft: false, base: { ref: 'main' } },
      };

      it('classifies the draft-PR reason as postable', () => {
        const data = { ...base, pull_request: { draft: true, base: { ref: 'main' } } };
        const reason = getSkipReason(data, 'review_requested', env);
        expect(isMysticatTargetedSkip(reason)).to.be.true;
      });

      it('classifies the bot-sender reason as postable', () => {
        const data = { ...base, sender: { type: 'Bot' } };
        const reason = getSkipReason(data, 'review_requested', env);
        expect(isMysticatTargetedSkip(reason)).to.be.true;
      });

      it('classifies the non-default-branch reason as postable', () => {
        const data = { ...base, pull_request: { draft: false, base: { ref: 'release/v2' } } };
        const reason = getSkipReason(data, 'review_requested', env);
        expect(isMysticatTargetedSkip(reason)).to.be.true;
      });

      it('classifies the foreign-reviewer reason as silent', () => {
        const data = { ...base, requested_reviewer: { login: 'some-human' } };
        const reason = getSkipReason(data, 'review_requested', env);
        expect(isMysticatTargetedSkip(reason)).to.be.false;
      });

      it('classifies the unsupported-action reason as silent', () => {
        const data = { ...base, action: 'closed' };
        const reason = getSkipReason(data, 'closed', env);
        expect(reason).to.include('unsupported action');
        expect(isMysticatTargetedSkip(reason)).to.be.false;
      });

      it('classifies the auto-trigger reason as silent', () => {
        const data = { ...base, action: 'opened' };
        const reason = getSkipReason(data, 'opened', env);
        expect(reason).to.include('auto-trigger');
        expect(isMysticatTargetedSkip(reason)).to.be.false;
      });
    });
  });
});
