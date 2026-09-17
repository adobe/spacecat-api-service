#!/usr/bin/env node
/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-disable no-console */

/**
 * Ops script for the deferred user-context Semrush job runner (serenity-docs#186).
 * Recovery for `NEEDS_REAUTH` jobs requires a human with a live IMS session — this can
 * never run unattended in CI, matching every other Serenity canary/ops script in this
 * directory. Deliberately NOT exposed on the public API surface.
 *
 * Usage:
 *   IMS_TOKEN=$(mysticat auth token --ims) POSTGREST_URL=... \
 *   SERENITY_JOB_RUNNER_QUEUE_ARN=... SERENITY_JOB_RUNNER_DLQ_ARN=... \
 *     node scripts/serenity-job-runner-ops.mjs recover <jobId...>
 *
 * `recover` re-mints a promise token for each affected job (as the operator running the
 * script), writes it onto the job's AsyncJob record, then redrives the DLQ back onto the
 * main queue. Since the SQS message body carries only `{ jobId, type }` (no token), the
 * redrive itself is the stock AWS `StartMessageMoveTask` operation — no per-message
 * rewriting needed. Note: `StartMessageMoveTask` takes queue ARNs, not URLs.
 */

import { env, argv, exit } from 'node:process';
import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { ImsPromiseClient } from '@adobe/spacecat-shared-ims-client';
import {
  SQSClient, StartMessageMoveTaskCommand, ListMessageMoveTasksCommand,
} from '@aws-sdk/client-sqs';

const need = (name) => {
  const v = env[name];
  if (!v) {
    console.error(`\n  Missing required env ${name}. See the script header.\n`);
    exit(2);
  }
  return v;
};

const [subcommand, ...args] = argv.slice(2);

const log = console;

async function recover(jobIds) {
  if (jobIds.length === 0) {
    console.error('Usage: recover <jobId...>');
    exit(2);
  }

  const imsToken = need('IMS_TOKEN');
  const dlqArn = need('SERENITY_JOB_RUNNER_DLQ_ARN');
  const queueArn = need('SERENITY_JOB_RUNNER_QUEUE_ARN');

  const dataAccess = createDataAccess({
    postgrestUrl: env.POSTGREST_URL,
    postgrestSchema: env.POSTGREST_SCHEMA,
    postgrestApiKey: env.POSTGREST_API_KEY,
  }, log);
  const { AsyncJob } = dataAccess;

  const context = {
    env: {
      IMS_HOST: env.IMS_HOST,
      IMS_PROMISE_EMITTER_CLIENT_ID: env.IMS_PROMISE_EMITTER_CLIENT_ID,
      IMS_PROMISE_EMITTER_CLIENT_SECRET: env.IMS_PROMISE_EMITTER_CLIENT_SECRET,
      IMS_PROMISE_EMITTER_DEFINITION_ID: env.IMS_PROMISE_EMITTER_DEFINITION_ID,
      AUTOFIX_CRYPT_SECRET: env.AUTOFIX_CRYPT_SECRET,
      AUTOFIX_CRYPT_SALT: env.AUTOFIX_CRYPT_SALT,
    },
    log,
  };
  const emitterClient = ImsPromiseClient.createFrom(context, ImsPromiseClient.CLIENT_TYPE.EMITTER);
  const enableEncryption = !!env.AUTOFIX_CRYPT_SECRET && !!env.AUTOFIX_CRYPT_SALT;

  for (const jobId of jobIds) {
    // eslint-disable-next-line no-await-in-loop
    const job = await AsyncJob.findById(jobId);
    if (!job) {
      log.warn(`Job ${jobId} not found, skipping`);
      // eslint-disable-next-line no-continue
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const promiseToken = await emitterClient.getPromiseToken(imsToken, enableEncryption);
    job.setMetadata({
      ...(job.getMetadata() ?? {}),
      promiseToken,
    });
    job.setStatus('IN_PROGRESS');
    job.setError(null);
    // eslint-disable-next-line no-await-in-loop
    await job.save();
    log.info(`Re-minted promise token for job ${jobId}`);
  }

  const sqsClient = new SQSClient({ region: env.AWS_REGION });
  const { TaskHandle } = await sqsClient.send(new StartMessageMoveTaskCommand({
    SourceArn: dlqArn,
    DestinationArn: queueArn,
  }));
  log.info(`Started DLQ redrive task: ${TaskHandle}`);

  const status = await sqsClient.send(new ListMessageMoveTasksCommand({ SourceArn: dlqArn }));
  log.info(`Move task status: ${JSON.stringify(status.Results)}`);
}

function reclassify() {
  // serenity-docs#33's concern — the project-wide re-classify subcommand belongs to
  // that consumer's own ops tooling, not the generic runner. Stub only.
  console.error('reclassify is not implemented in the runner ops script — see serenity-docs#33.');
  exit(2);
}

switch (subcommand) {
  case 'recover':
    await recover(args);
    break;
  case 'reclassify':
    reclassify();
    break;
  default:
    console.error('Usage: node scripts/serenity-job-runner-ops.mjs <recover|reclassify> [args...]');
    exit(2);
}
