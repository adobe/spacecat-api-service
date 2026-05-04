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
 * @param {object} env - Environment variables
 * @returns {string|null} Skip reason or null
 */
export function getSkipReason(data, action, env) {
  const pr = data.pull_request;
  // Caller must validate env.GITHUB_APP_SLUG before invoking (the controller
  // returns 500 on missing config so GitHub retries, rather than 204 from a skip).
  const appSlug = env.GITHUB_APP_SLUG;

  // Unsupported actions (auto-triggers deferred to Phase 3)
  if (action === 'opened' || action === 'ready_for_review') {
    return `auto-trigger not yet supported: ${action}`;
  }

  // Invite-based trigger: reviewer must be the app
  if (action === 'review_requested') {
    const reviewer = data.requested_reviewer?.login;
    if (reviewer !== `${appSlug}[bot]`) {
      return `reviewer ${reviewer} is not ${appSlug}`;
    }
  }

  // Label-based trigger: label must match
  if (action === 'labeled') {
    const label = data.label?.name;
    if (label !== 'mysticat:review-requested') {
      return `label ${label} does not match trigger`;
    }
  }

  // Only review_requested and labeled are supported in Phase 2
  if (action !== 'review_requested' && action !== 'labeled') {
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
