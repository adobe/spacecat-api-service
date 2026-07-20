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
  getSkipReason, EVENT_JOB_MAP, isMysticatTargetedSkip, skipReasonLabel,
} from '../../src/utils/github-trigger-rules.js';

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
    // The reviewer login is resolved per destination from the consolidated
    // GITHUB_DESTINATIONS registry and passed by the controller. It can be a
    // plain user, an EMU user, or an App bot (slug[bot]).
    const REVIEWER = 'MysticatBot';

    const baseData = {
      pull_request: {
        draft: false,
        base: { ref: 'main' },
      },
      repository: { default_branch: 'main' },
      sender: { type: 'User' },
    };

    describe('review_requested trigger', () => {
      it('returns null when the requested reviewer matches reviewerLogin', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: REVIEWER },
        };
        expect(getSkipReason(data, 'review_requested', REVIEWER)).to.be.null;
      });

      it('returns a skip reason when the requested reviewer differs from reviewerLogin', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'some-human' },
        };
        const reason = getSkipReason(data, 'review_requested', REVIEWER);
        expect(reason).to.include('some-human');
        expect(reason).to.include(REVIEWER);
      });

      it('accepts an App-bot reviewer login (slug[bot])', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'mysticat-bot[bot]' },
        };
        expect(getSkipReason(data, 'review_requested', 'mysticat-bot[bot]')).to.be.null;
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
        expect(getSkipReason(data, 'labeled', REVIEWER)).to.include('unsupported action');
      });
    });

    describe('unsupported actions', () => {
      it('returns skip reason for opened (auto-trigger deferred)', () => {
        const data = { ...baseData, action: 'opened' };
        expect(getSkipReason(data, 'opened', REVIEWER)).to.include('auto-trigger');
      });

      it('returns skip reason for ready_for_review (auto-trigger deferred)', () => {
        const data = { ...baseData, action: 'ready_for_review' };
        expect(getSkipReason(data, 'ready_for_review', REVIEWER)).to.include('auto-trigger');
      });

      it('returns skip reason for closed', () => {
        const data = { ...baseData, action: 'closed' };
        expect(getSkipReason(data, 'closed', REVIEWER)).to.include('unsupported action');
      });
    });

    describe('skip rules (review_requested only — labeled is disabled)', () => {
      // The reviewer matches, so each case reaches its draft / bot / branch rule.
      const matchFields = { requested_reviewer: { login: REVIEWER } };

      it('returns skip reason for draft PR', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          ...matchFields,
          pull_request: { ...baseData.pull_request, draft: true },
        };
        expect(getSkipReason(data, 'review_requested', REVIEWER)).to.equal('draft PR');
      });

      it('returns skip reason for bot sender', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          ...matchFields,
          sender: { type: 'Bot' },
        };
        expect(getSkipReason(data, 'review_requested', REVIEWER)).to.equal('bot sender');
      });

      it('returns skip reason for non-default branch', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          ...matchFields,
          pull_request: { ...baseData.pull_request, base: { ref: 'release/v2' } },
        };
        const reason = getSkipReason(data, 'review_requested', REVIEWER);
        expect(reason).to.include('non-default branch');
      });
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
      const REVIEWER = 'mysticat[bot]';
      const base = {
        action: 'review_requested',
        requested_reviewer: { login: REVIEWER },
        repository: { default_branch: 'main' },
        sender: { type: 'User' },
        pull_request: { draft: false, base: { ref: 'main' } },
      };

      it('classifies the draft-PR reason as postable', () => {
        const data = { ...base, pull_request: { draft: true, base: { ref: 'main' } } };
        const reason = getSkipReason(data, 'review_requested', REVIEWER);
        expect(isMysticatTargetedSkip(reason)).to.be.true;
      });

      it('classifies the bot-sender reason as postable', () => {
        const data = { ...base, sender: { type: 'Bot' } };
        const reason = getSkipReason(data, 'review_requested', REVIEWER);
        expect(isMysticatTargetedSkip(reason)).to.be.true;
      });

      it('classifies the non-default-branch reason as postable', () => {
        const data = { ...base, pull_request: { draft: false, base: { ref: 'release/v2' } } };
        const reason = getSkipReason(data, 'review_requested', REVIEWER);
        expect(isMysticatTargetedSkip(reason)).to.be.true;
      });

      it('classifies the foreign-reviewer reason as silent', () => {
        const data = { ...base, requested_reviewer: { login: 'some-human' } };
        const reason = getSkipReason(data, 'review_requested', REVIEWER);
        expect(isMysticatTargetedSkip(reason)).to.be.false;
      });

      it('classifies the unsupported-action reason as silent', () => {
        const data = { ...base, action: 'closed' };
        const reason = getSkipReason(data, 'closed', REVIEWER);
        expect(reason).to.include('unsupported action');
        expect(isMysticatTargetedSkip(reason)).to.be.false;
      });

      it('classifies the auto-trigger reason as silent', () => {
        const data = { ...base, action: 'opened' };
        const reason = getSkipReason(data, 'opened', REVIEWER);
        expect(reason).to.include('auto-trigger');
        expect(isMysticatTargetedSkip(reason)).to.be.false;
      });
    });
  });

  describe('skipReasonLabel', () => {
    it('returns draft_pr for draft PR', () => {
      expect(skipReasonLabel('draft PR')).to.equal('draft_pr');
    });

    it('returns bot_sender for bot sender', () => {
      expect(skipReasonLabel('bot sender')).to.equal('bot_sender');
    });

    it('returns non_default_branch for non-default branch reason', () => {
      expect(skipReasonLabel('non-default branch: release/v2')).to.equal('non_default_branch');
    });

    it('returns auto_trigger for auto-trigger not yet supported reason', () => {
      expect(skipReasonLabel('auto-trigger not yet supported: opened')).to.equal('auto_trigger');
    });

    it('returns wrong_reviewer for reviewer mismatch reason', () => {
      expect(skipReasonLabel('reviewer some-human is not MysticatBot')).to.equal('wrong_reviewer');
    });

    it('returns unsupported_action for unsupported action reason', () => {
      expect(skipReasonLabel('unsupported action: closed')).to.equal('unsupported_action');
    });

    it('returns other for unknown reason', () => {
      expect(skipReasonLabel('something completely unknown')).to.equal('other');
    });

    it('returns other for null/undefined', () => {
      expect(skipReasonLabel(null)).to.equal('other');
      expect(skipReasonLabel(undefined)).to.equal('other');
    });
  });
});
