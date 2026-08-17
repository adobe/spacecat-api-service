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
 * SECOND READING (SITES-49206 / ADR-009): after the JIT allocator's removal this script is also the
 * interim per-environment re-check that Semrush is still NOT enforcing AI limits — and under that
 * premise its meaning INVERTS the LLMO-6190 labels used below. A publish that SUCCEEDS at zero
 * headroom is the HEALTHY result (the premise holds); the disguised 405 this was built to capture
 * now means Semrush is ENFORCING AGAIN — the signal to re-introduce the allocator from history. The
 * on-screen `expected` / `UNEXPECTED` console text still speaks the fixture-capture language, so it
 * reads the opposite way from the premise check. `main()` exits 0 in both branches: the operator
 * reads the printed publish outcome, not an exit code.
 *
 * DELETE-LAST COUPLING: this script is the sole remaining caller of the transport's
 * `transferWorkspaceResources` (the step-2 drain). Deleting this script strands that method, and
 * deleting that method breaks this script — serenity-docs#72 §10.7 retires the two together with
 * the §10.6 classifier. The step-1 read `getWorkspaceResources` is NOT part of this coupling:
 * `elements.js` `checkAccess` (the brand-presence access banner) keeps it alive independently.
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
 *   2. Sets prompt headroom to zero — an absolute transfer of `total` down to `used`, draining the
 *      SAME dimension the disguised-405 is documented against (workspace doc §5). Prints the
 *      before/after totals so the operator can confirm this and can restore it after (this script
 *      does NOT restore it — see "cleanup" below).
 *
 *      Read-side shape drift (found 2026-08-17, SITES-49206 canary run): Semrush's AI product
 *      resources used to report a single flat `prompts.{used,total}`; some workspaces now instead
 *      report tiered `daily_prompts.{used,total}` / `weekly_prompts.{used,total}`, with no flat
 *      `prompts` key at all. This script handles BOTH shapes on read. The `resources/transfer`
 *      WRITE contract (`handlers.aiProductResources`), however, still only accepts a flat `prompts`
 *      number — there is no documented tiered write shape. So for a tiered workspace this script
 *      can only DRAIN when both tiers are already at `total: 0` (nothing to do — skips the transfer
 *      call and proceeds straight to step 3); it refuses to guess a write shape for a tiered
 *      workspace that still has real headroom, and exits with an explanation instead.
 *   3. Creates (or reuses, with --project-id) a minimal AI project, attaches a model, drafts one
 *      prompt, and publishes — expected to 405 with the disguised metered-quota body.
 *   4. Prints the FULL raw error: status, `error.body`, and (if present) any response headers
 *      SerenityTransportError captured — everything needed to pin a fixture.
 *
 * Cleanup: this script does NOT delete the project or restore the drained allocation — it's meant
 * to run against a disposable dev/throwaway sub-workspace. To restore headroom afterwards (legacy
 * flat-`prompts` workspaces only — see the shape-drift note above), transfer `prompts.total` back
 * up (the inverse of step 2 — a `transferWorkspaceResources` call, or just re-activate the brand)
 * if the workspace needs to keep working, or decommission the throwaway workspace entirely.
 *
 * If the captured body's SHAPE ever changes (e.g. the gateway starts returning JSON for this
 * rejection too), `isMeteredQuota` and its pinned fixture in `test/support/serenity/errors.test.js`
 * need to be revisited — the classifier keys on shape, not content, so it would need a new signal.
 */

import { env, argv, exit } from 'node:process';
import { parseArgs } from 'node:util';
import { createSerenityTransport, SerenityTransportError } from '../src/support/serenity/rest-transport.js';
import { resolvePromptDims, isZeroHeadroom } from './serenity-metered-405-canary-resources.mjs';

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

function printDims(dims, label) {
  for (const dim of dims) {
    console.log(`${dim.key}.used:`, dim.used, ` ${dim.key}.total (${label}):`, dim.total);
  }
}

async function main() {
  console.log(`Reading current AI resources for sub-workspace ${subWorkspaceId}...`);
  const before = await transport.getWorkspaceResources(subWorkspaceId);
  const aiResourcesBefore = before?.product_resources?.ai?.resources;
  const promptsBefore = resolvePromptDims(aiResourcesBefore);
  if (!promptsBefore) {
    console.error('Raw ai.resources (unrecognized shape):', JSON.stringify(aiResourcesBefore, null, 2));
    usageAndExit('Could not find a flat `prompts.{used,total}` or a complete tiered `daily_prompts`/`weekly_prompts` pair in product_resources.ai.resources — see the raw dump above');
  }
  printDims(promptsBefore.dims, 'before');

  if (opts['dry-run']) {
    if (promptsBefore.shape === 'legacy') {
      console.log('\n--dry-run: would drain prompts.total to prompts.used, then create+publish a project to trigger the disguised 405. Exiting without making changes.');
    } else if (isZeroHeadroom(promptsBefore.dims)) {
      console.log('\n--dry-run: tiered prompt resources already at zero headroom — would skip the drain (unsupported for this shape, see header) and create+publish directly. Exiting without making changes.');
    } else {
      console.log('\n--dry-run: tiered prompt resources have real headroom, which this script cannot drain (the transfer write API only supports the legacy flat `prompts` field — see header). A real run would exit here without publishing.');
    }
    return;
  }

  if (promptsBefore.shape === 'legacy') {
    const [prompts] = promptsBefore.dims;
    const projectsTotal = aiResourcesBefore?.projects?.total;
    if (typeof projectsTotal !== 'number') {
      usageAndExit('Could not read product_resources.ai.resources.projects.total from the workspace response — required to preserve it across the drain transfer');
    }
    console.log(`Draining prompts.total to ${prompts.used} (an absolute transfer — zero prompt headroom left)...`);
    await transport.transferWorkspaceResources(subWorkspaceId, {
      ai: { projects: projectsTotal, prompts: prompts.used },
    });
  } else if (isZeroHeadroom(promptsBefore.dims)) {
    console.log('Tiered prompt resources are already at zero headroom on every tier — skipping the drain (the transfer write API has no documented tiered shape to drain further).');
  } else {
    usageAndExit('This workspace uses the tiered daily_prompts/weekly_prompts shape with real headroom remaining, and the resources/transfer write API only accepts a flat `prompts` field (no documented tiered write shape) — this script cannot safely drain it. Use a workspace already at daily_prompts.total===0 && weekly_prompts.total===0, or extend transferWorkspaceResources once Semrush documents the tiered write contract.');
  }

  // Re-read AFTER the drain (or no-op) and print the post-drain totals. Without this, "did the
  // drain land?" is an open confounder on the premise-confirming reading (a publish that succeeds
  // against GENUINELY zero headroom confirms Semrush is not enforcing — but a publish that succeeds
  // because the drain silently no-op'd proves nothing). This is the "after" half the header
  // advertises.
  const after = await transport.getWorkspaceResources(subWorkspaceId);
  const promptsAfter = resolvePromptDims(after?.product_resources?.ai?.resources);
  const zeroHeadroom = promptsAfter && isZeroHeadroom(promptsAfter.dims);
  if (promptsAfter) {
    printDims(promptsAfter.dims, 'after drain');
  }
  console.log(zeroHeadroom ? '— zero headroom confirmed' : '— ⚠ HEADROOM REMAINS: the drain did not land (or the read shape changed again); the publish result below is inconclusive either way');

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
    console.log('Publishing with zero prompt headroom — LLMO-6190 fixture capture expects the disguised metered-quota 405...');
    await transport.publishProject(subWorkspaceId, projectId);
    console.log('\npublish SUCCEEDED at zero headroom. Read this against the "after drain" totals printed above:');
    console.log('  • if zero headroom was confirmed there — this is the ADR-009 premise-confirming result: Semrush is NOT enforcing AI limits (no allocator needed).');
    console.log('  • if HEADROOM REMAINS was printed — inconclusive: the drain did not land (or the disguised-405 only fires with drafted prompts present — try a prompt first).');
    console.log('(The legacy label for this branch was "UNEXPECTED"; that reflects the LLMO-6190 fixture-capture goal, not the ADR-009 premise check — see the header.)');
  } catch (e) {
    printError('publishProject result (this is what isMeteredQuota must match)', e);
    if (e instanceof SerenityTransportError && e.status === 405) {
      console.log('\nA disguised 405 at confirmed-zero headroom is the LLMO-6190 fixture; under the ADR-009 premise it ALSO means Semrush is enforcing AI limits again — the signal to re-introduce the allocator from history (ADR-009).');
    }
  }

  console.log('\nDone. This script did NOT restore the drained allocation or delete the canary project — clean up the throwaway workspace manually.');
}

main().catch((e) => {
  printError('UNEXPECTED top-level failure', e);
  exit(1);
});
