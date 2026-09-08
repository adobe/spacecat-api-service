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

import {
  badRequest, notFound, accepted, internalServerError, createResponse,
} from '@adobe/spacecat-shared-http-utils';
import { hasText } from '@adobe/spacecat-shared-utils';
import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { cachedOk } from '../../support/cached-response.js';
import { dateToIsoWeek } from '../../support/elements/week-utils.js';
import { postSlackMessage } from '../../utils/slack/base.js';

const CLAIMS_PREFIX = 'brand_claims/llmo';
const WEEK_RE = /^\d{4}-W\d{2}$/;

// Default and hard cap for the `weeks` listing endpoint. The UI shows the most
// recent runs, so the default is small; the cap bounds an unbounded caller-
// supplied `limit` (a year of weekly runs) without ever paging past one S3 list.
const DEFAULT_WEEKS_LIMIT = 15;
const MAX_WEEKS_LIMIT = 52;

/**
 * List the ISO-week (`YYYY-Www`) run folders under a site's brand-claims prefix,
 * newest first. Zero-padded `YYYY-Www` sorts lexicographically, so a descending
 * string sort orders the weeks chronologically. Non-week folders (e.g. a legacy
 * flat file's sibling) are ignored. Throws on an S3 failure — callers decide
 * whether to fall back or surface the error.
 *
 * @returns {Promise<{ weeks: string[], prefix: string }>} descending week segments.
 */
async function listWeekFolders(s3, bucketName, siteId, log) {
  const prefix = `${CLAIMS_PREFIX}/${siteId}/`;
  const res = await s3.s3Client.send(new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: prefix,
    Delimiter: '/',
  }));
  // One folder per ISO week keeps this well under the 1000-prefix page limit
  // (~19 years), so pagination is intentionally omitted; warn if that changes.
  if (res.IsTruncated) {
    log.warn(`Brand claims week listing truncated for site ${siteId}; week resolution may be incomplete`);
  }
  const weeks = [];
  for (const cp of res.CommonPrefixes || []) {
    const seg = cp.Prefix.slice(prefix.length).replace(/\/$/, '');
    if (WEEK_RE.test(seg)) {
      weeks.push(seg);
    }
  }
  weeks.sort((a, b) => (a < b ? 1 : -1)); // newest first
  return { weeks, prefix };
}

// Audit type + 7-day cooldown for on-demand Brand Claims runs (LLMO-7263). Trial
// customers may request a fresh run at most once per week; the UI shows the same
// window, and this is the authoritative server-side backstop (the UI gate is
// bypassable). Kept in step with project-elmo-ui's BRAND_CLAIMS_REQUEST_COOLDOWN_MS.
const BRAND_CLAIMS_AUDIT_TYPE = 'brand-claims';
const BRAND_CLAIMS_REQUEST_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
// `model` is interpolated into the S3 key, so constrain it to alphanumerics,
// dots, hyphens, underscores — no `/` — to prevent using HeadObject as an
// object-existence probe across arbitrary key paths.
const MODEL_RE = /^[\w.-]+$/;

/**
 * Latest run key for a site: the lexically-greatest `YYYY-Www` folder under the
 * site prefix. Returns null when no week folder exists yet (caller falls back to
 * the legacy flat key).
 */
async function latestWeekKey(s3, bucketName, siteId, log) {
  try {
    const { weeks, prefix } = await listWeekFolders(s3, bucketName, siteId, log);
    return weeks.length ? `${prefix}${weeks[0]}/data.json.gz` : null;
  } catch (err) {
    // Best-effort: a listing failure falls back to the legacy flat key rather
    // than failing the request (a genuinely missing object still 404s at HEAD).
    log.warn(`Failed to list brand claims weeks for site ${siteId}: ${err.message}`);
    return null;
  }
}

/**
 * Handles the brand claims retrieval by generating a presigned S3 URL.
 * Data files are .json.gz and can exceed Lambda's 6MB response limit,
 * so this endpoint returns a presigned URL rather than the data directly.
 *
 * Runs are stored per ISO week (`{siteId}/{YYYY-Www}/data.json.gz`). With no
 * selector, the latest week is served (falling back to the legacy flat
 * `{siteId}/data.json.gz` for sites not yet migrated). A `week` (`YYYY-Www`, as
 * returned by the weeks-listing endpoint) keys that week directly; a `date`
 * (`YYYY-MM-DD`) resolves to its ISO week; `week` wins if both are set. A
 * `model` selects a legacy flat `{model}.json.gz` file, unchanged.
 *
 * @param {object} context - The request context containing log, s3, env, and params
 * @returns {Promise<Response>} The brand claims presigned URL response
 */
export async function handleBrandClaims(context) {
  const { log, s3 } = context;
  const { siteId } = context.params;
  const { model, date, week } = context.data;

  if (!s3 || !s3.s3Client) {
    return badRequest('S3 storage is not configured for this environment');
  }

  const bucketName = s3.s3Bucket;
  if (!bucketName) {
    return badRequest('S3 bucket is not configured for this environment');
  }

  if (model !== undefined && !MODEL_RE.test(model)) {
    return badRequest('Invalid model parameter');
  }

  // Model files are managed flat (not week-partitioned) and take precedence;
  // `week` (a `YYYY-Www` returned by the weeks-listing endpoint) keys its folder
  // directly; `date` resolves to its ISO week; otherwise default to the legacy
  // flat key and upgrade it to the latest week (via a list) inside the try below.
  // `week` and `date` are two spellings of the same selector — `week` wins when
  // both are set (it needs no date→week conversion). Each is validated only in
  // the branch that uses it.
  let s3Key;
  if (model) {
    s3Key = `${CLAIMS_PREFIX}/${siteId}/${model}.json.gz`;
  } else if (week) {
    if (!WEEK_RE.test(week)) {
      return badRequest('Invalid week parameter: expected YYYY-Www format');
    }
    s3Key = `${CLAIMS_PREFIX}/${siteId}/${week}/data.json.gz`;
  } else if (date) {
    // Round-trip parse (UTC): rejects unparseable dates AND ones JS silently
    // rolls over (e.g. 2026-02-30 -> Mar 2), which would key the wrong week.
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      return badRequest('Invalid date parameter: expected YYYY-MM-DD format');
    }
    s3Key = `${CLAIMS_PREFIX}/${siteId}/${dateToIsoWeek(date)}/data.json.gz`;
  } else {
    s3Key = `${CLAIMS_PREFIX}/${siteId}/data.json.gz`;
  }

  let selectorLog = '';
  if (week) {
    selectorLog = `, week: ${week}`;
  } else if (date) {
    selectorLog = `, date: ${date}`;
  }
  log.info(`Getting brand claims for site ${siteId}, model: ${model || 'default'}${selectorLog}`);

  try {
    const { getSignedUrl, GetObjectCommand } = s3;

    if (!model && !week && !date) {
      const latest = await latestWeekKey(s3, bucketName, siteId, log);
      if (latest) {
        s3Key = latest;
      }
    }

    // Presigning a GetObject URL is an offline operation and never checks that
    // the object exists, so without this HeadObject the endpoint would happily
    // hand out a URL that 404s on fetch. Verify existence first and return a
    // clean 404 otherwise (mirrors getFanoutReport). This also lets callers use
    // the endpoint as a cheap availability probe (e.g. an "all brands" view).
    await s3.s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: s3Key }));

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
    });

    const expiresIn = 60 * 60; // 1 hour
    const url = await getSignedUrl(s3.s3Client, command, { expiresIn });

    return cachedOk({
      siteId,
      model: model || 'default',
      presignedUrl: url,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    });
  } catch (s3Error) {
    if (s3Error.name === 'NotFound' || s3Error.$metadata?.httpStatusCode === 404) {
      log.warn(`Brand claims file not found for site ${siteId} at ${s3Key}`);
      return notFound(`Brand claims data not found for site ${siteId}`);
    }
    if (s3Error.name === 'NoSuchBucket') {
      log.error(`S3 bucket ${bucketName} not found`);
      return badRequest(`Storage bucket not found: ${bucketName}`);
    }

    log.error(`S3 error retrieving brand claims for site ${siteId}: ${s3Error.message}`);
    return badRequest(`Error retrieving brand claims: ${s3Error.message}`);
  }
}

/**
 * Lists the ISO weeks (`YYYY-Www`) for which a brand-claims run exists for a
 * site, newest first, capped at `limit` (default 15, max 52). The UI uses this
 * to offer a week picker instead of only ever showing the latest run; each
 * listed week can then be fetched via `GET .../brand-claims?date=<in-week>`.
 * Returns an empty list (not a 404) when no week-partitioned runs exist, so the
 * caller can distinguish "no history yet" from a hard failure.
 *
 * @param {object} context - The request context containing log, s3, and params.
 * @returns {Promise<Response>} `{ siteId, weeks, count }`.
 */
export async function handleBrandClaimsWeeks(context) {
  const { log, s3 } = context;
  const { siteId } = context.params;

  if (!s3 || !s3.s3Client) {
    return badRequest('S3 storage is not configured for this environment');
  }

  const bucketName = s3.s3Bucket;
  if (!bucketName) {
    return badRequest('S3 bucket is not configured for this environment');
  }

  // Optional `limit`: parsed leniently, then clamped to [1, MAX_WEEKS_LIMIT];
  // a missing or non-numeric value falls back to the default rather than 400ing.
  const rawLimit = Number.parseInt(context.data?.limit, 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_WEEKS_LIMIT)
    : DEFAULT_WEEKS_LIMIT;

  log.info(`Listing brand claims weeks for site ${siteId} (limit ${limit})`);

  try {
    const { weeks } = await listWeekFolders(s3, bucketName, siteId, log);
    const limited = weeks.slice(0, limit);
    return cachedOk({ siteId, weeks: limited, count: limited.length });
  } catch (s3Error) {
    if (s3Error.name === 'NoSuchBucket') {
      log.error(`S3 bucket ${bucketName} not found`);
      return badRequest(`Storage bucket not found: ${bucketName}`);
    }
    log.error(`S3 error listing brand claims weeks for site ${siteId}: ${s3Error.message}`);
    return badRequest(`Error listing brand claims weeks: ${s3Error.message}`);
  }
}

/**
 * Human-readable identity of the caller who triggered the request, for the Slack alert.
 * Mirrors user-details.js: prefer the RFC-5322 address (trial_email, then preferred_username)
 * over profile.email, which is an IMS user GUID; include the name when present. Returns
 * null when no identity is available (the alert then omits the "by ..." clause).
 *
 * @param {object} context - Request context (attributes.authInfo).
 * @returns {string|null} e.g. "Ada Lovelace (ada@example.com)" or "ada@example.com"; null
 *   when no identity is available.
 */
function getRequesterLabel(context) {
  try {
    const authInfo = context?.attributes?.authInfo;
    const profile = authInfo?.getProfile?.() ?? authInfo?.profile ?? {};
    const email = [profile.trial_email, profile.preferred_username, profile.email]
      .find((v) => hasText(v));
    const first = profile.first_name || profile.given_name;
    const last = profile.last_name || profile.family_name;
    const name = [first, last].filter((v) => hasText(v)).join(' ').trim();
    const label = (name && email) ? `${name} (${email})` : (name || email);
    // Trial users control their own display name, so strip the Slack mrkdwn control
    // characters (<, >, `, |) that could inject a link/mention/code span into the alert.
    return hasText(label) ? label.replace(/[<>`|]/g, '') : null;
  } catch {
    // Best-effort label only — never let requester lookup throw into the (already
    // queued) run or the Slack alert.
    return null;
  }
}

/**
 * On-demand Brand Claims trigger for trial customers (LLMO-7263). Triggers the
 * audit-worker `brand-claims` audit for the site with `onDemand: true`, which
 * finds the latest Brand Presence sheet and publishes a one-shot
 * `BRAND_PRESENCE_SHEET_WRITTEN` event (on_demand=true). The audit-worker owns
 * the sheet lookup + event shape, so this endpoint just fires the trigger; the
 * run happens once WITHOUT setting the persistent `brand_claims_enabled` flag
 * (which the weekly emit would otherwise re-run every week). Site + LLMO access
 * is validated by the caller.
 *
 * @param {object} context - Request context (log, sqs, env).
 * @param {object} site - The resolved, access-checked Site model.
 * @returns {Promise<Response>} 202 accepted, or a 5xx on a misconfiguration.
 */
export async function handleRequestBrandClaims(context, site) {
  const { log, sqs, env } = context;

  const queueUrl = env?.AUDIT_JOBS_QUEUE_URL;
  if (!queueUrl) {
    // Keep the config diagnostic in the log; return a generic message so the
    // environment's configuration state isn't leaked to external trial callers.
    log.error('Brand Claims on-demand: AUDIT_JOBS_QUEUE_URL is not configured');
    return internalServerError('Brand Claims on-demand is temporarily unavailable');
  }

  // 7-day cooldown backstop: refuse a new run if the last brand-claims audit ran
  // within the window. Mirrors the UI's disabled "Request new run" button so the two
  // agree; because the UI button is bypassable this is the authoritative gate. Fails
  // OPEN — a lookup error must not block a legitimate first/eligible request.
  // Accepted TOCTOU gap: two requests arriving before the audit-worker persists its
  // audit row both pass this check and both enqueue. The per-brand redelivery dedup
  // (blackboard fact freshness in mystique) makes the duplicate a cheap no-op, so a
  // best-effort check here is deliberate rather than a hard once-only lock.
  try {
    const latestAudit = await site.getLatestAuditByAuditType(BRAND_CLAIMS_AUDIT_TYPE);
    const ranAtMs = typeof latestAudit?.getAuditedAt === 'function'
      ? Date.parse(latestAudit.getAuditedAt())
      : NaN;
    if (Number.isFinite(ranAtMs)) {
      const elapsed = Date.now() - ranAtMs;
      if (elapsed < BRAND_CLAIMS_REQUEST_COOLDOWN_MS) {
        const availableAt = new Date(ranAtMs + BRAND_CLAIMS_REQUEST_COOLDOWN_MS).toISOString();
        const retryAfterSeconds = Math.ceil((BRAND_CLAIMS_REQUEST_COOLDOWN_MS - elapsed) / 1000);
        log.info(`Brand Claims on-demand: cooldown active for site ${site.getId()}, available at ${availableAt}`);
        return createResponse(
          {
            siteId: site.getId(),
            availableAt,
            message: 'A Brand Claims run was requested recently; a new run can be requested once per 7 days.',
          },
          429,
          { 'Retry-After': String(retryAfterSeconds) },
        );
      }
    }
  } catch (auditError) {
    log.warn(`Brand Claims on-demand: cooldown lookup failed for site ${site.getId()}, allowing request: ${auditError.message}`);
  }

  try {
    await sqs.sendMessage(queueUrl, {
      type: 'brand-claims',
      siteId: site.getId(),
      onDemand: true,
      auditContext: { trigger: 'on-demand-brand-claims' },
    });
  } catch (sqsError) {
    // Enqueue failure is a server-side/infra fault, not a client error — surface it
    // as 5xx (the caller's controller catch would otherwise map any throw to 400).
    log.error(`Brand Claims on-demand: failed to enqueue audit for site ${site.getId()}: ${sqsError.message}`);
    return internalServerError('Brand Claims on-demand is temporarily unavailable');
  }
  log.info(`Brand Claims on-demand: triggered brand-claims audit for site ${site.getId()}`);

  // Dedicated channel for on-demand Brand Claims request alerts (LLMO-7263),
  // set in Vault, so these can be routed/muted independently of other LLMO alerts.
  const slackChannel = env?.SLACK_BRAND_CLAIMS_REQUEST_CHANNEL_ID;
  const slackToken = env?.SLACK_BOT_TOKEN;
  if (slackChannel && slackToken) {
    try {
      const requester = getRequesterLabel(context);
      const requestedBy = requester ? ` by ${requester}` : '';
      await postSlackMessage(
        slackChannel,
        `:rocket: On-demand Brand Claims requested for *${site.getBaseURL()}* (${site.getId()})${requestedBy}.`,
        slackToken,
      );
    } catch (slackError) {
      // Slack notification is best-effort — the trigger is already queued.
      log.warn(`Brand Claims on-demand: Slack notification failed: ${slackError.message}`);
    }
  }

  return accepted({
    siteId: site.getId(),
    message: 'Brand Claims run requested; results appear once the pipeline completes.',
  });
}
