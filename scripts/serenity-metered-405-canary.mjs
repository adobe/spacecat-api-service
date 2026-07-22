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
 * LLMO-6190 item 5 — live-gateway canary for the disguised metered-quota 405.
 *
 * `isMeteredQuota` (src/support/serenity/errors.js) is now shape-based (a string body is the
 * disguised gateway-level rejection, a JSON object is a genuine app-level error) — pinned from a
 * real body captured live (Rainer, LLMO-6190, LLMO-Dev-2): a bare nginx `text/html` 405 page with
 * no "quota"/"allocation exhausted" text at all. This script remains useful for re-confirming that
 * shape against a fresh gateway/tenant, or capturing a new fixture if the upstream body ever
 * changes. It drives the REAL Semrush transport against a REAL (throwaway) sub-workspace,
 * deliberately drains its AI prompt allocation to zero, and publishes into it — which the workspace
 * design doc says 405s as a disguised quota rejection (as opposed to a genuine Method-Not-Allowed).
 * It prints the raw response status, headers, and body so a human can re-confirm the shape.
 *
 * WHY THIS CAN'T RUN IN CI OR BE RUN BY the implementing agent: it needs a live IMS bearer token
 * and a real Semrush sub-workspace id — neither exists in this environment. A human with
 * Semrush/IMS dev-environment credentials must run it manually.
 *
 * Usage:
 *   IMS_TOKEN=$(mysticat auth token --ims) \
 *   SUB_WORKSPACE_ID=<a throwaway/dev sub-workspace id> \
 *   node scripts/serenity-metered-405-canary.mjs [--project-id <existing project id>]
 *
 * Options:
 *   --project-id <id>   Reuse an existing project in the sub-workspace instead of creating one.
 *   --dry-run            Print what would be done without draining the allocation or publishing.
 *
 * What it does:
 *   1. Reads the sub-workspace's current AI resources (GET .../resources).
 *   2. Sets `prompts.total` to its current `used` (an absolute transfer to zero headroom) —
 *      draining the SAME dimension the disguised-405 is documented against (workspace doc §5).
 *      Prints the before/after totals so the operator can confirm this and can restore it after
 *      (this script does NOT restore it — see "cleanup" below).
 *   3. Creates (or reuses, with --project-id) a minimal AI project, attaches a model, drafts one
 *      prompt, and publishes — expected to 405 with the disguised metered-quota body.
 *   4. Prints the FULL raw error: status, `error.body`, and (if present) any response headers
 *      SerenityTransportError captured — everything needed to pin a fixture.
 *
 * Cleanup: this script does NOT delete the project or restore the drained allocation — it's meant
 * to run against a disposable dev/throwaway sub-workspace. Re-run `ensureAiHeadroom`/an ordinary
 * API top-up (or just re-activate the brand) afterwards if the workspace needs to keep working, or
 * decommission the throwaway workspace entirely.
 *
 * If the captured body's SHAPE ever changes (e.g. the gateway starts returning JSON for this
 * rejection too), `isMeteredQuota` and its pinned fixture in `test/support/serenity/errors.test.js`
 * need to be revisited — the classifier keys on shape, not content, so it would need a new signal.
 */

import { env, argv, exit } from 'node:process';
import { parseArgs } from 'node:util';
import { createSerenityTransport, SerenityTransportError } from '../src/support/serenity/rest-transport.js';

function usageAndExit(message) {
  if (message) {
    console.error(`Error: ${message}\n`);
  }
  console.error('Usage: IMS_TOKEN=... SUB_WORKSPACE_ID=... node scripts/serenity-metered-405-canary.mjs [--project-id <id>] [--dry-run]');
  exit(1);
}

const { values: opts } = parseArgs({
  args: argv.slice(2),
  options: {
    'project-id': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const imsToken = env.IMS_TOKEN;
const subWorkspaceId = env.SUB_WORKSPACE_ID;

if (!imsToken) {
  usageAndExit('IMS_TOKEN env var is required (e.g. IMS_TOKEN=$(mysticat auth token --ims))');
}
if (!subWorkspaceId) {
  usageAndExit('SUB_WORKSPACE_ID env var is required — a THROWAWAY dev sub-workspace, not a real customer brand');
}

const transport = createSerenityTransport({ env, imsToken });

function printError(label, e) {
  console.log(`\n=== ${label} ===`);
  if (e instanceof SerenityTransportError) {
    console.log('status:', e.status);
    console.log('message:', e.message);
    console.log('body (raw):', JSON.stringify(e.body, null, 2));
    console.log('body typeof:', typeof e.body);
  } else {
    console.log('NON-transport error (unexpected):', e);
  }
}

async function main() {
  console.log(`Reading current AI resources for sub-workspace ${subWorkspaceId}...`);
  const before = await transport.getWorkspaceResources(subWorkspaceId);
  const prompts = before?.product_resources?.ai?.resources?.prompts;
  if (!prompts || typeof prompts.used !== 'number' || typeof prompts.total !== 'number') {
    usageAndExit('Could not read product_resources.ai.resources.prompts.{used,total} from the workspace response — dumping raw response instead');
  }
  console.log('prompts.used:', prompts.used, ' prompts.total (before):', prompts.total);

  if (opts['dry-run']) {
    console.log('\n--dry-run: would drain prompts.total to', prompts.used, 'then create+publish a project to trigger the disguised 405. Exiting without making changes.');
    return;
  }

  console.log(`Draining prompts.total to ${prompts.used} (an absolute transfer — zero prompt headroom left)...`);
  await transport.transferWorkspaceResources(subWorkspaceId, {
    ai: { projects: before.product_resources.ai.resources.projects.total, prompts: prompts.used },
  });

  let projectId = opts['project-id'];
  if (!projectId) {
    console.log('Resolving a real language_id from the Semrush language catalog...');
    const languages = await transport.listLanguages();
    const english = (languages?.items || []).find(
      (item) => String(item?.name).toLowerCase() === 'english',
    );
    if (!english?.id) {
      usageAndExit('Could not resolve an English language_id from /v1/languages');
    }
    console.log('language_id:', english.id);

    console.log('Creating a minimal AI project to publish into...');
    const created = await transport.createProject(subWorkspaceId, {
      name: 'LLMO-6190 metered-405 canary (delete me)',
      type: 'ai',
      brand_name_display: 'Canary',
      brand_names: ['Canary'],
      domain: 'example.com',
      country_code: 'us',
      location_id: 2840,
      location_name: 'United States',
      language_id: english.id,
    });
    projectId = String(created?.id || '');
    if (!projectId) {
      usageAndExit('createProject returned no id — cannot continue');
    }
    console.log('Created project', projectId);
  }

  console.log('Creating a tag to attach a draft prompt to...');
  const tagResp = await transport.createProjectTags(subWorkspaceId, projectId, [`llmo-6190-canary-${Date.now()}`]);
  const tagList = Array.isArray(tagResp) ? tagResp : (tagResp?.items || []);
  const tagId = String(tagList[0]?.id || '');
  if (!tagId) {
    usageAndExit(`createProjectTags returned no usable tag id — raw: ${JSON.stringify(tagResp)}`);
  }
  console.log('tag_id:', tagId);

  console.log('Drafting one prompt (free until publish) to give publish something to meter...');
  await transport.createPromptsByIds(
    subWorkspaceId,
    projectId,
    ['LLMO-6190 metered-405 canary prompt (delete me)'],
    [tagId],
  );

  try {
    console.log('Publishing with zero prompt headroom — expecting the disguised metered-quota 405...');
    await transport.publishProject(subWorkspaceId, projectId);
    console.log('\nUNEXPECTED: publish succeeded. The workspace may not actually be at zero headroom, or the disguised-405 only fires with drafted prompts present — try creating a prompt on the project before publishing.');
  } catch (e) {
    printError('publishProject result (this is what isMeteredQuota must match)', e);
  }

  console.log('\nDone. This script did NOT restore the drained allocation or delete the canary project — clean up the throwaway workspace manually.');
}

main().catch((e) => {
  printError('UNEXPECTED top-level failure', e);
  exit(1);
});
