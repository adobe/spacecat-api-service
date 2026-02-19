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
 * Builds the full mandatory env matrix for the IT dev server.
 *
 * @param {'dynamo'|'postgres'} mode - Backend mode
 * @param {string} publicKeyB64 - Base64-encoded ES256 SPKI public key
 * @returns {object} Environment variables object
 */
export function buildEnv(mode, publicKeyB64) {
  const env = {
    // Auth
    AUTH_PUBLIC_KEY_B64: publicKeyB64,

    // AWS (needed for SDK client init even with dummy values)
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'dummy',
    AWS_SECRET_ACCESS_KEY: 'dummy',

    // IMS client (eager, hard-throws per-request)
    IMS_HOST: 'https://dummy-ims.example.com',
    IMS_CLIENT_ID: 'dummy-client-id',
    IMS_CLIENT_CODE: 'dummy-client-code',
    IMS_CLIENT_SECRET: 'dummy-client-secret',

    // Slack client (env var name = SLACK_TOKEN_ + target + _ELEVATED)
    SLACK_TOKEN_WORKSPACE_EXTERNAL_ELEVATED: 'xoxb-dummy-token',
    SLACK_OPS_CHANNEL_WORKSPACE_EXTERNAL: 'C000DUMMY',
    SLACK_URL_WORKSPACE_EXTERNAL: 'https://dummy-slack.example.com',

    // Site discovery / default org
    DEFAULT_ORGANIZATION_ID: '11111111-1111-4111-b111-111111111111',

    // Reports controller (eager, hard-throws per-request)
    REPORT_JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/dummy-reports',
    S3_REPORT_BUCKET: 'dummy-report-bucket',
    S3_MYSTIQUE_BUCKET: 'dummy-mystique-bucket',

    // Scrape client (ScrapeClient.createFrom eagerly parses this in constructor)
    SCRAPE_JOB_CONFIGURATION: JSON.stringify({
      queues: [],
      scrapeWorkerQueue: 'https://sqs.us-east-1.amazonaws.com/000000000000/dummy-scrape',
      s3Bucket: 'dummy-scrape-bucket',
      options: {},
      maxUrlsPerJob: 4000,
      maxUrlsPerMessage: 1000,
      scrapeQueueUrlPrefix: 'https://sqs.us-east-1.amazonaws.com/000000000000/dummy',
    }),
    S3_SCRAPER_BUCKET: 'dummy-scraper-bucket',

    // Other middleware (dummy values, not called by Tier 1 routes)
    AUDIT_JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/dummy-audits',
    S3_CONFIG_BUCKET: 'dummy-config-bucket',
  };

  if (mode === 'dynamo') {
    Object.assign(env, {
      DYNAMO_TABLE_NAME_DATA: 'spacecat-services-data',
      AWS_ENDPOINT_URL_DYNAMODB: 'http://127.0.0.1:8000',
    });
  } else if (mode === 'postgres') {
    Object.assign(env, {
      DATA_SERVICE_PROVIDER: 'postgres',
      POSTGREST_URL: 'http://localhost:3300',
      POSTGREST_SCHEMA: 'public',
    });
  }

  return env;
}
