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

import { POSTGREST_WRITER_JWT } from './shared/postgrest-jwt.js';

/**
 * Builds the full mandatory env matrix for the IT dev server.
 *
 * @param {string} publicKeyB64 - Base64-encoded ES256 SPKI public key
 * @returns {object} Environment variables object
 */
export function buildEnv(publicKeyB64) {
  return {
    // Auth
    AUTH_PUBLIC_KEY_B64: publicKeyB64,

    // AWS — point S3 at the local MinIO container; other services use dummy credentials.
    // AWS_SESSION_TOKEN is cleared so that the CI configure-aws-credentials step's real
    // STS token does not leak into MinIO requests (MinIO validates or rejects STS tokens).
    AWS_REGION: 'us-east-1',
    // Deployment env. The state-access-mapping endpoints are dev-only until
    // facsWrapper fronts them (they 404 elsewhere), so the IT server must boot
    // as 'dev' for that suite to exercise the real handlers.
    AWS_ENV: 'dev',
    AWS_ACCESS_KEY_ID: 'minioadmin',
    AWS_SECRET_ACCESS_KEY: 'minioadmin',
    AWS_SESSION_TOKEN: '',
    AWS_ENDPOINT_URL_S3: `http://localhost:${process.env.IT_MINIO_PORT || '9100'}`,
    S3_BUCKET_NAME: 'spacecat-it-test',

    // ASO redirect overlay endpoint (GET /config/:service/redirects.txt). The
    // bucket name encodes the deployment env (dev); the controller reads from it
    // with the Lambda's own role after resolving the service to an entitled site.
    S3_ASO_OVERLAYS_BUCKET: 'spacecat-dev-aso-overlays',
    ASO_OVERLAY_API_KEY: 'it-aso-overlay-key',

    // IMS client (eager, hard-throws per-request). NB: hostname only, no
    // scheme — ImsClient builds URLs as `https://${IMS_HOST}${endpoint}`,
    // so a scheme-prefixed value yields `https://https://...` and fails
    // DNS with `ENOTFOUND https`.
    IMS_HOST: 'dummy-ims.example.com',
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

    // JSON configs (eagerly parsed in controller constructors; empty objects are valid)
    IMPORT_CONFIGURATION: '{}',
    API_KEY_CONFIGURATION: '{}',

    // Other middleware (dummy values, not called by Tier 1 routes)
    AUDIT_JOBS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/dummy-audits',
    S3_CONFIG_BUCKET: 'dummy-config-bucket',

    // LLMO Cloudflare onboarding — GET .../cloudflare/config returns this verbatim to the
    // browser PKCE flow. Other cloudflare endpoints call the external Cloudflare API and are
    // not exercised by the IT suite (no external HTTP mocking).
    CLOUDFLARE_CLIENT_ID: 'it-cloudflare-client-id',

    // Consumers (S2S) — allow ORG_1 IMS org for seeding and IT tests
    S2S_ALLOWED_IMS_ORG_IDS: 'AAAAAAAABBBBBBBBCCCCCCCC@AdobeOrg',

    // PostgreSQL data service
    DATA_SERVICE_PROVIDER: 'postgres',
    POSTGREST_URL: `http://localhost:${process.env.IT_POSTGREST_PORT || '3300'}`,
    POSTGREST_SCHEMA: 'public',
    POSTGREST_API_KEY: POSTGREST_WRITER_JWT,

    // ── Serenity E2E: Semrush vendor mocks ──────────────────────────────────
    // NONE of the vars below require Vault / deployed-env config: SEMRUSH_USERS_BASE_URL
    // falls back to SEMRUSH_PROJECTS_BASE_URL when unset, and the rest are IT-only.
    // Point the two serenity transport gateways at the mock containers. The
    // User Manager origin is split out via SEMRUSH_USERS_BASE_URL (api-service#2656)
    // so the two mocks need no path-routing reverse proxy. Both serve self-signed
    // HTTPS, so the dev server trusts them via NODE_TLS_REJECT_UNAUTHORIZED=0
    // (scoped to this IT process — never a deployed setting).
    SEMRUSH_PROJECTS_BASE_URL: `https://localhost:${process.env.IT_PE_MOCK_PORT || '8443'}`,
    SEMRUSH_USERS_BASE_URL: `https://localhost:${process.env.IT_UM_MOCK_PORT || '8444'}`,
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    // Test-only escape hatch: accept the harness's non-IMS JWT on /serenity/*.
    // Sound only against the mocks, which ignore the forwarded bearer. No
    // deployed environment sets this (it is never written to Vault).
    SERENITY_ALLOW_NON_IMS_AUTH: 'true',
    // Lets the net-zero cleanup delete a sub-workspace it created in the mock.
    SERENITY_ALLOW_WORKSPACE_DELETE: 'true',
  };
}
