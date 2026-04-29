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

    describe('labeled trigger', () => {
      it('returns null when label matches', () => {
        const data = {
          ...baseData,
          action: 'labeled',
          label: { name: 'mysticat:review-requested' },
        };
        expect(getSkipReason(data, 'labeled', defaultEnv)).to.be.null;
      });

      it('returns skip reason when label does not match', () => {
        const data = {
          ...baseData,
          action: 'labeled',
          label: { name: 'bug' },
        };
        const reason = getSkipReason(data, 'labeled', defaultEnv);
        expect(reason).to.include('bug');
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

    describe('skip rules', () => {
      it('returns skip reason for draft PR', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'mysticat[bot]' },
          pull_request: { ...baseData.pull_request, draft: true },
        };
        expect(getSkipReason(data, 'review_requested', defaultEnv)).to.equal('draft PR');
      });

      it('returns skip reason for bot sender', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'mysticat[bot]' },
          sender: { type: 'Bot' },
        };
        expect(getSkipReason(data, 'review_requested', defaultEnv)).to.equal('bot sender');
      });

      it('returns skip reason for non-default branch', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'mysticat[bot]' },
          pull_request: { ...baseData.pull_request, base: { ref: 'release/v2' } },
        };
        const reason = getSkipReason(data, 'review_requested', defaultEnv);
        expect(reason).to.include('non-default branch');
      });
    });

    describe('GITHUB_APP_SLUG default', () => {
      it('defaults to mysticat when env var is not set', () => {
        const data = {
          ...baseData,
          action: 'review_requested',
          requested_reviewer: { login: 'mysticat[bot]' },
        };
        expect(getSkipReason(data, 'review_requested', {})).to.be.null;
      });
    });
  });
});
