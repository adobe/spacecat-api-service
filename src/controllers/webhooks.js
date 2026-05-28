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

// The request body is HMAC-verified by GitHubWebhookHmacHandler.
// Headers (x-github-event, x-github-delivery) are NOT part of GitHub's signed
// material - only the body is signed. Pass header-derived values as structured
// log context, never interpolated into log message strings (log injection risk).

import {
  accepted, noContent, badRequest, internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import wrap from '@adobe/helix-shared-wrap';
import { getSkipReason, EVENT_JOB_MAP, isMysticatTargetedSkip } from '../utils/github-trigger-rules.js';
import { createObservabilitySlackClient } from '../support/slack/observability-client.js';
import { enqueuedParentText, skippedStandaloneText } from '../support/slack/observability-messages.js';
import { shouldRateLimitSlackPost } from '../support/slack/observability-rate-limit.js';

const DEFAULT_WORKSPACE_REPOS = [
  'adobe/mysticat-architecture',
  'adobe/mysticat-ai-native-guidelines',
  'Adobe-AEM-Sites/aem-sites-architecture',
];

// owner/repo format: non-slash owner + single slash + non-slash repo
const WORKSPACE_REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

function getWorkspaceRepos(env, log) {
  const raw = env.MYSTICAT_WORKSPACE_REPOS;
  if (!raw) {
    log.debug('MYSTICAT_WORKSPACE_REPOS not set, using built-in defaults', {
      defaults: DEFAULT_WORKSPACE_REPOS,
    });
    return DEFAULT_WORKSPACE_REPOS;
  }
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = [];
  const invalid = [];
  entries.forEach((entry) => {
    if (WORKSPACE_REPO_PATTERN.test(entry)) {
      valid.push(entry);
    } else {
      invalid.push(entry);
    }
  });
  if (invalid.length > 0) {
    log.warn('MYSTICAT_WORKSPACE_REPOS has invalid entries (expected owner/repo format)', {
      invalid,
    });
  }
  if (valid.length === 0) {
    log.warn('MYSTICAT_WORKSPACE_REPOS produced no valid entries, falling back to defaults', {
      defaults: DEFAULT_WORKSPACE_REPOS,
    });
    return DEFAULT_WORKSPACE_REPOS;
  }
  return valid;
}

function WebhooksController(context) {
  const { sqs, log, env } = context;
  const slackChannel = env.MYSTICAT_OBSERVABILITY_SLACK_CHANNEL;
  const slack = createObservabilitySlackClient({
    token: env.MYSTICAT_OBSERVABILITY_SLACK_TOKEN,
    channel: slackChannel,
    log,
  });

  function errorHandler(fn) {
    return async (ctx) => {
      try {
        return await fn(ctx);
      } catch (e) {
        log.error('GitHub webhook handler error', e);
        return internalServerError('Internal error');
      }
    };
  }

  const processGitHubWebhook = wrap(async (ctx) => {
    // Headers are populated onto context.pathInfo.headers by the enrichPathInfo
    // middleware (request.headers.plain() — lowercase plain object). Reading
    // ctx.headers directly silently returns undefined and short-circuits every
    // delivery to a 204 noContent at the EVENT_JOB_MAP check below.
    const event = ctx.pathInfo?.headers?.['x-github-event'];
    const deliveryId = ctx.pathInfo?.headers?.['x-github-delivery'];
    const { data } = ctx;

    // Destination resolved by the HMAC handler (registry mode). Legacy mode has
    // no profile target_id/app_slug -> fall back to env.GITHUB_APP_SLUG and emit
    // no target_id (worker then resolves its flat keys).
    const profile = ctx.attributes?.authInfo?.getProfile?.() || {};
    const targetId = profile.target_id;
    const appSlug = profile.app_slug || env.GITHUB_APP_SLUG;

    // Security-relevant: which bot can trigger automated runs. In registry mode
    // this comes from the target's appSlug; in legacy mode from env. A missing
    // value must be a 5xx (GitHub retries) rather than a 204 (delivery lost).
    if (!appSlug) {
      log.error('No app slug resolved (GITHUB_APP_SLUG unset and no target app_slug)', { deliveryId });
      return internalServerError('app slug not configured');
    }

    // Filter on event type BEFORE validating payload fields. Unmapped events
    // (ping, push, issues, ...) do not necessarily carry `action` or
    // `installation.id`. GitHub's app-install ping has neither — validating
    // first would 400 the install handshake and surface as red Xs in the
    // app's "Recent Deliveries" UI. Mapped events still get full validation
    // below.
    const jobType = EVENT_JOB_MAP[event];
    if (!jobType) {
      log.info('Skipping unmapped event', { event, deliveryId });
      return noContent();
    }

    // Validate required payload fields (mapped events only)
    if (!data?.action) {
      return badRequest('Missing required field: action');
    }
    if (!data?.installation?.id) {
      return badRequest('Missing required field: installation.id');
    }

    const { action, pull_request: pr } = data;

    // Validate pull_request-specific fields BEFORE getSkipReason. Doing so
    // prevents a missing pull_request from surfacing as a misleading
    // "non-default branch: undefined" 204 skip instead of a 400 bad request.
    if (!pr?.number) {
      return badRequest('Missing required field: pull_request.number');
    }
    if (!data.repository?.owner?.login) {
      return badRequest('Missing required field: repository.owner.login');
    }
    if (!data.repository?.name) {
      return badRequest('Missing required field: repository.name');
    }

    // Apply trigger rules (returns skip reason string or null)
    const skipReason = getSkipReason(data, action, env, appSlug);
    if (skipReason) {
      log.info('Skipping webhook', {
        skipReason,
        deliveryId,
        event,
        action,
        owner: data.repository.owner.login,
        repo: data.repository.name,
        prNumber: pr.number,
      });
      // Post a standalone Slack note only when Mysticat WAS the requested
      // reviewer (draft / bot / non-default branch). Foreign-reviewer and
      // unsupported-action skips stay silent. Best-effort + rate-limited per PR;
      // postMessage never throws.
      if (
        slack.enabled
        && isMysticatTargetedSkip(skipReason)
        && !shouldRateLimitSlackPost(`${data.repository.owner.login}/${data.repository.name}#${pr.number}`)
      ) {
        await slack.postMessage({
          text: skippedStandaloneText({
            owner: data.repository.owner.login,
            repo: data.repository.name,
            prNumber: pr.number,
            reason: skipReason,
          }),
        });
      }
      return noContent();
    }

    // Post the Slack thread root BEFORE enqueue (ordering invariant: parent
    // before enqueue, never after). Best-effort - a Slack failure must never
    // block the review, so we still enqueue. On parent-post failure we send
    // slack_channel only (no thread_ts); the worker degrades to a standalone.
    // When Slack is disabled or rate-limited we omit observability entirely.
    let observability;
    if (
      slack.enabled
      && !shouldRateLimitSlackPost(`${data.repository.owner.login}/${data.repository.name}#${pr.number}`)
    ) {
      const threadTs = await slack.postMessage({
        text: enqueuedParentText({
          owner: data.repository.owner.login,
          repo: data.repository.name,
          prNumber: pr.number,
          action,
          jobType,
        }),
      });
      observability = threadTs
        ? { slack_channel: slackChannel, slack_thread_ts: threadTs }
        : { slack_channel: slackChannel };
    }

    // Computed per webhook request (not per controller construction) so the
    // env-var validation log fires only on genuine deliveries, not all traffic.
    const workspaceRepos = getWorkspaceRepos(env, log);

    // Build and enqueue job payload
    const jobPayload = {
      owner: data.repository.owner.login,
      repo: data.repository.name,
      event_type: event,
      event_action: action,
      event_ref: String(pr.number),
      installation_id: String(data.installation.id),
      delivery_id: deliveryId,
      job_type: jobType,
      workspace_repos: workspaceRepos,
      retry_count: 0,
      ...(targetId ? { target_id: targetId } : {}),
      ...(observability ? { observability } : {}),
    };

    const queueUrl = env.MYSTICAT_GITHUB_JOBS_QUEUE_URL;
    await sqs.sendMessage(queueUrl, jobPayload);

    log.info('Enqueued webhook job', {
      jobType,
      deliveryId,
      event,
      action,
      owner: jobPayload.owner,
      repo: jobPayload.repo,
      prNumber: pr.number,
      installationId: jobPayload.installation_id,
    });

    return accepted({ status: 'accepted' });
  })
    .with(errorHandler);

  return { processGitHubWebhook };
}

export default WebhooksController;
