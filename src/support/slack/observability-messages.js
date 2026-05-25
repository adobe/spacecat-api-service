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
 * Pure mrkdwn formatters for the web tier's Slack observability messages.
 * The web tier only ever posts top-level messages (thread roots + standalones);
 * the worker formats and posts the threaded replies in mysticat-github-service.
 */

/**
 * Escapes the three characters Slack treats specially in mrkdwn so user-influenced
 * content (e.g. a branch ref like `<!here>` carried in a skip reason) cannot inject
 * a mention or markup. Per Slack guidance, only &, <, > need escaping. Apply only
 * to text OUTSIDE backtick code spans (inside code spans Slack renders literally).
 */
function escapeSlack(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Thread-root message for an enqueued review.
 * @param {object} p
 * @param {string} p.owner
 * @param {string} p.repo
 * @param {number|string} p.prNumber
 * @param {string} p.action - GitHub event action (e.g. review_requested)
 * @param {string} p.jobType - mapped job type (e.g. pr-review)
 * @returns {string} mrkdwn text
 */
export function enqueuedParentText({
  owner, repo, prNumber, action, jobType,
}) {
  return `:inbox_tray: *Review enqueued* \`${owner}/${repo}\` #${prNumber}\n${escapeSlack(action)} → ${escapeSlack(jobType)}`;
}

/**
 * Standalone message for a Mysticat-targeted skip (draft / bot / non-default branch).
 * @param {object} p
 * @param {string} p.owner
 * @param {string} p.repo
 * @param {number|string} p.prNumber
 * @param {string} p.reason - skip reason from getSkipReason
 * @returns {string} mrkdwn text
 */
export function skippedStandaloneText({
  owner, repo, prNumber, reason,
}) {
  return `:fast_forward: *Skipped* \`${owner}/${repo}\` #${prNumber} - ${escapeSlack(reason)}`;
}
