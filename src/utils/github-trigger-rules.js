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

/**
 * Maps GitHub event types to job types for the Mysticat GitHub Service.
 * Today: pull_request -> pr-review.
 * Future: issues -> triage-issue, push -> changelog, etc.
 */
export const EVENT_JOB_MAP = {
  pull_request: 'pr-review',
};

/**
 * Determines whether a GitHub webhook event should be skipped.
 * Returns a human-readable skip reason string, or null if the event should be processed.
 *
 * @param {object} data - Parsed webhook payload
 * @param {string} action - The event action (e.g. 'review_requested', 'labeled')
 * @param {string} reviewerLogin - The destination's reviewer login, attached to
 *   the auth profile by GitHubWebhookHmacHandler from the consolidated
 *   GITHUB_DESTINATIONS registry. The requested reviewer must equal this for
 *   review_requested to proceed. Required: the controller resolves and validates
 *   it before calling (a missing reviewer identity is a 5xx, not a silent skip).
 * @returns {string|null} Skip reason or null
 */
export function getSkipReason(data, action, reviewerLogin) {
  const pr = data.pull_request;

  // Unsupported actions (auto-triggers deferred to Phase 3)
  if (action === 'opened' || action === 'ready_for_review') {
    return `auto-trigger not yet supported: ${action}`;
  }

  // Invite-based trigger: the requested reviewer must be the destination's
  // configured reviewer login (a plain user, EMU user, or App bot - whatever
  // the registry pins per destination).
  if (action === 'review_requested') {
    const reviewer = data.requested_reviewer?.login;
    if (reviewer !== reviewerLogin) {
      return `reviewer ${reviewer} is not ${reviewerLogin}`;
    }
  }

  // Only review_requested is supported. Label-based triggers were disabled
  // because GitHub does not count label-triggered reviews toward branch
  // protection / merge requirements: an approval only counts when the
  // reviewer was explicitly *requested* (Reviewers panel) or is listed in
  // CODEOWNERS for the changed paths. A bot that posts a review off the
  // back of a label add appears under "Reviewers whose approvals may not
  // affect merge requirements" — visible but non-binding.
  //
  // The env-configurable label hook (env.MYSTICAT_REVIEW_LABEL) and its
  // dev/prod-specific Vault values were left in place for now. If we ever
  // re-enable label triggers (e.g., a "comment-only / advisory" mode that
  // does not pretend to count), restore the matching block here without
  // re-doing the env-separation work.
  if (action !== 'review_requested') {
    return `unsupported action: ${action}`;
  }

  // Skip rules (defensive, even for on-demand triggers)
  if (pr?.draft) {
    return 'draft PR';
  }

  if (data.sender?.type === 'Bot') {
    return 'bot sender';
  }

  if (pr?.base?.ref !== data.repository?.default_branch) {
    return `non-default branch: ${pr?.base?.ref}`;
  }

  return null;
}

/**
 * Maps a skip reason string from getSkipReason to a short, stable label
 * suitable for use as a CloudWatch metric dimension value.
 *
 * Keep in lockstep with getSkipReason: these string checks mirror the exact
 * literals / prefixes it returns.
 *
 * @param {string|null|undefined} reason - Skip reason from getSkipReason
 * @returns {string} Stable label string
 */
export function skipReasonLabel(reason) {
  if (!reason) {
    return 'other';
  }
  if (reason === 'draft PR') {
    return 'draft_pr';
  }
  if (reason === 'bot sender') {
    return 'bot_sender';
  }
  if (reason.startsWith('non-default branch')) {
    return 'non_default_branch';
  }
  if (reason.startsWith('auto-trigger not yet supported')) {
    return 'auto_trigger';
  }
  if (reason.startsWith('reviewer ')) {
    return 'wrong_reviewer';
  }
  if (reason.startsWith('unsupported action')) {
    return 'unsupported_action';
  }
  return 'other';
}

/**
 * Classifies a skip reason from getSkipReason as one that should post a
 * standalone Slack observability note. Only skips where Mysticat WAS the
 * requested reviewer (draft PR / bot sender / non-default branch) are
 * interesting; foreign-reviewer, unsupported-action, and auto-trigger skips
 * stay silent to avoid flooding the channel.
 *
 * Keep in lockstep with getSkipReason: these literals/prefix mirror the strings
 * it returns AFTER the reviewer check passes. The drift-guard tests in
 * test/utils/github-trigger-rules.test.js fail if the two diverge.
 *
 * @param {string} reason - The skip reason string returned by getSkipReason
 * @returns {boolean} true if a standalone Slack note should be posted
 */
export function isMysticatTargetedSkip(reason) {
  if (!reason) {
    return false;
  }
  return reason === 'draft PR'
    || reason === 'bot sender'
    || reason.startsWith('non-default branch:');
}
