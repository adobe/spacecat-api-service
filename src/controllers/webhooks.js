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
import { getSkipReason, EVENT_JOB_MAP } from '../utils/github-trigger-rules.js';

const DEFAULT_WORKSPACE_REPOS = [
  'adobe/mysticat-architecture',
  'adobe/mysticat-ai-native-guidelines',
  'Adobe-AEM-Sites/aem-sites-architecture',
];

function getWorkspaceRepos(env) {
  const raw = env.MYSTICAT_WORKSPACE_REPOS;
  if (!raw) {
    return DEFAULT_WORKSPACE_REPOS;
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function WebhooksController(context) {
  const { sqs, log, env } = context;
  const workspaceRepos = getWorkspaceRepos(env);

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
    const event = ctx.headers?.['x-github-event'];
    const deliveryId = ctx.headers?.['x-github-delivery'];
    const { data } = ctx;

    // Validate required payload fields
    if (!data?.action) {
      return badRequest('Missing required field: action');
    }
    if (!data?.installation?.id) {
      return badRequest('Missing required field: installation.id');
    }

    // Check event-to-job-type mapping
    const jobType = EVENT_JOB_MAP[event];
    if (!jobType) {
      log.info('Skipping unmapped event', { event, deliveryId });
      return noContent();
    }

    const { action, pull_request: pr } = data;

    // Apply trigger rules (returns skip reason string or null)
    const skipReason = getSkipReason(data, action, env);
    if (skipReason) {
      log.info('Skipping webhook', {
        skipReason,
        deliveryId,
        event,
        action,
        owner: data.repository?.owner?.login,
        repo: data.repository?.name,
        prNumber: pr?.number,
      });
      return noContent();
    }

    // Validate pull_request-specific fields before building payload
    if (!pr?.number) {
      return badRequest('Missing required field: pull_request.number');
    }
    if (!data.repository?.owner?.login) {
      return badRequest('Missing required field: repository.owner.login');
    }
    if (!data.repository?.name) {
      return badRequest('Missing required field: repository.name');
    }

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
