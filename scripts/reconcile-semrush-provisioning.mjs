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
 * LLMO-7369 (PR2) — fleet-wide discovery + notify for Serenity brands that are NOT fully
 * provisioned in Semrush.
 *
 * PR1 stopped Slack onboarding from creating a misleading complete `active` brand: for a
 * Serenity-active org it now creates the brand `pending` (awaiting IMS provisioning) and hands
 * off to the authenticated UI. But nothing self-heals a hand-off that a human never completes,
 * and the pre-existing stuck fleet (e.g. HEETS YELLOW, IQOS ILUMA i — created `active` with a
 * null sub-workspace before PR1) is invisible. This reconciler makes that state discoverable
 * and, with --execute, notifies an ops channel with a resume link for each stuck brand.
 *
 * "Not fully provisioned" (the completion bar, LLMO-7369) for a Serenity-active org's brand:
 *   - `semrush_sub_workspace_id IS NULL`  (no sub-workspace), OR
 *   - the brand has ZERO `BrandSemrushProject` rows (sub-workspace only, no market/project) —
 *     not usable in Brand Visibility.
 * Non-Serenity (e.g. PLG) orgs never touch Semrush and are skipped entirely.
 *
 * NOTIFY-ONLY BY DESIGN. This script never provisions Semrush: provisioning requires an IMS user
 * identity through resolveSemrushImsToken, which a server-side batch job does not have. It reports
 * (dry run) and, with --execute, posts a Slack notification pointing operators at the backend-owned
 * resume link so a signed-in Serenity user can complete provisioning as themselves. Unattended
 * auto-provisioning is deferred to PR3 (a security-reviewed Sites Internal service account); this
 * script is written so PR3 can add that completer without changing the enumeration here.
 *
 * Usage:
 *   POSTGREST_URL=<url> SPACECAT_API_BASE_URL=<url> \
 *     [SLACK_BOT_TOKEN=<t> SLACK_SEMRUSH_RECONCILE_CHANNEL_ID=<c>] \
 *     node scripts/reconcile-semrush-provisioning.mjs [options]
 *
 * Options:
 *   --execute        Post a Slack notification for the incomplete brands found. Default is a dry
 *                    run: incomplete brands are reported to stdout, nothing is written or sent.
 *   --org-id UUID    Only scan this SpaceCat organization (useful to verify before a fleet run).
 *   --page-size N    Brands page size (default 200).
 *   --rate-limit-ms N  Sleep between brands to bound the per-brand project read (default 50).
 *
 * Exit status:
 *   0  Ran successfully (finding incomplete brands is the expected purpose, not a failure).
 *   1  Bad invocation or an unexpected error.
 *
 * Get POSTGREST_URL / SPACECAT_API_BASE_URL / SLACK_* from the target env's Lambda configuration:
 *   aws lambda get-function-configuration --function-name spacecat-api-service-<env> \
 *     --query 'Environment.Variables.[POSTGREST_URL,SPACECAT_API_BASE_URL,SLACK_BOT_TOKEN]'
 */

import { createDataAccess } from '@adobe/spacecat-shared-data-access';
import { parseArgs } from 'node:util';
import { env, exit } from 'node:process';
import { isSerenityActiveForOrg } from '../src/support/serenity/serenity-active.js';
import { postSlackMessage } from '../src/utils/slack/base.js';

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_RATE_LIMIT_MS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IN_SCOPE_STATUSES = ['pending', 'active'];

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    execute: { type: 'boolean', default: false },
    'org-id': { type: 'string' },
    'page-size': { type: 'string' },
    'rate-limit-ms': { type: 'string' },
  },
  allowPositionals: false,
});

function parseNumericOption(flag, raw, fallback, min) {
  if (raw === undefined) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < min) {
    console.error(`ERROR: ${flag} must be an integer >= ${min}, got "${raw}"`);
    exit(1);
  }
  return n;
}

const { execute } = values;
const pageSize = parseNumericOption('--page-size', values['page-size'], DEFAULT_PAGE_SIZE, 1);
const rateLimitMs = parseNumericOption('--rate-limit-ms', values['rate-limit-ms'], DEFAULT_RATE_LIMIT_MS, 0);
const orgFilter = values['org-id'];
if (orgFilter !== undefined && !UUID_RE.test(orgFilter)) {
  console.error(`ERROR: --org-id must be a UUID, got "${orgFilter}"`);
  exit(1);
}

if (!env.POSTGREST_URL) {
  console.error('ERROR: POSTGREST_URL is required');
  exit(1);
}
if (!env.SPACECAT_API_BASE_URL) {
  console.error('ERROR: SPACECAT_API_BASE_URL is required (used to build the resume links)');
  exit(1);
}

const apiBase = env.SPACECAT_API_BASE_URL.replace(/\/$/, '');
const slackToken = env.SLACK_BOT_TOKEN;
const slackChannel = env.SLACK_SEMRUSH_RECONCILE_CHANNEL_ID || env.SLACK_PLG_ONBOARDING_CHANNEL_ID;
if (execute && (!slackToken || !slackChannel)) {
  console.error('ERROR: --execute needs SLACK_BOT_TOKEN and SLACK_SEMRUSH_RECONCILE_CHANNEL_ID '
    + '(or SLACK_PLG_ONBOARDING_CHANNEL_ID)');
  exit(1);
}

const log = console;

// Read-only PostgREST access, same pattern as the other reconcile scripts in this directory.
const dataAccess = createDataAccess({
  postgrestUrl: env.POSTGREST_URL,
  postgrestSchema: env.POSTGREST_SCHEMA,
  postgrestApiKey: env.POSTGREST_API_KEY,
}, log);
const { postgrestClient } = dataAccess.services;
const ctx = { dataAccess };

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const resumeLinkFor = (orgId, brandId) => `${apiBase}/v2/orgs/${orgId}/brands/${brandId}/resume`;

const totals = {
  scanned: 0,
  serenitySkipped: 0,
  incompleteNoSubworkspace: 0,
  incompleteNoProjects: 0,
};

/**
 * Returns the incompletion reason for a Serenity brand, or null when it is fully provisioned.
 * @param {{ id: string, semrush_sub_workspace_id: string|null }} brand
 * @returns {Promise<'no-subworkspace'|'no-projects'|null>}
 */
async function incompletionReason(brand) {
  if (!brand.semrush_sub_workspace_id) {
    return 'no-subworkspace';
  }
  const projects = await dataAccess.BrandSemrushProject.allByBrandId(brand.id);
  return (Array.isArray(projects) && projects.length > 0) ? null : 'no-projects';
}

async function run() {
  const incomplete = [];
  let offset = 0;

  for (;;) {
    let query = postgrestClient
      .from('brands')
      .select('id, organization_id, name, status, semrush_sub_workspace_id')
      .in('status', IN_SCOPE_STATUSES);
    if (orgFilter) {
      query = query.eq('organization_id', orgFilter);
    }
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) {
      log.error(`ERROR: failed to read brands page (offset=${offset}): ${error.message}`);
      exit(1);
    }
    if (!data || data.length === 0) {
      break;
    }

    for (const brand of data) {
      totals.scanned += 1;
      // eslint-disable-next-line no-await-in-loop
      const serenityActive = await isSerenityActiveForOrg(ctx, brand.organization_id, log);
      if (!serenityActive) {
        totals.serenitySkipped += 1;
      } else {
        // eslint-disable-next-line no-await-in-loop
        const reason = await incompletionReason(brand);
        if (reason === 'no-subworkspace') {
          totals.incompleteNoSubworkspace += 1;
        }
        if (reason === 'no-projects') {
          totals.incompleteNoProjects += 1;
        }
        if (reason) {
          incomplete.push({
            orgId: brand.organization_id,
            brandId: brand.id,
            name: brand.name,
            status: brand.status,
            reason,
            resumeLink: resumeLinkFor(brand.organization_id, brand.id),
          });
        }
      }
      if (rateLimitMs > 0) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(rateLimitMs);
      }
    }

    if (data.length < pageSize) {
      break;
    }
    offset += pageSize;
  }

  // Report (always).
  console.log(`\n[reconcile-semrush-provisioning] mode=${execute ? 'execute (notify)' : 'dry-run'}`);
  console.log(`scanned=${totals.scanned} serenity-skipped=${totals.serenitySkipped} `
    + `incomplete=${incomplete.length} `
    + `(no-subworkspace=${totals.incompleteNoSubworkspace} no-projects=${totals.incompleteNoProjects})`);
  for (const b of incomplete) {
    console.log(`  - ${b.name} [${b.brandId}] org=${b.orgId} status=${b.status} `
      + `reason=${b.reason} resume=${b.resumeLink}`);
  }

  if (incomplete.length === 0) {
    console.log('No incomplete Serenity brands found.');
    return;
  }

  if (!execute) {
    console.log('\nDry run — no notification sent. Re-run with --execute to notify the ops channel.');
    return;
  }

  // Notify-only: post one summary to the ops channel with a resume link per brand.
  const lines = incomplete.map(
    (b) => `• *${b.name}* (\`${b.brandId}\`, org \`${b.orgId}\`, status \`${b.status}\`, `
      + `${b.reason}) — complete provisioning: ${b.resumeLink}`,
  );
  const message = `:warning: *Semrush provisioning incomplete for ${incomplete.length} Serenity `
    + `brand(s)* — sign in and *Approve* each to provision as yourself:\n${lines.join('\n')}`;
  const sendSlackMessage = postSlackMessage;
  await sendSlackMessage(slackChannel, message, slackToken);
  console.log(`\nNotified ${slackChannel} about ${incomplete.length} incomplete brand(s).`);
}

run().catch((e) => {
  log.error(`ERROR: reconcile failed: ${e?.message}`);
  exit(1);
});
