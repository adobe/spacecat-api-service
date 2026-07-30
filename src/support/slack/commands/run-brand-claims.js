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

import crypto from 'crypto';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { isValidUUID } from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';
import { getBrandBySite } from '../../brands-storage.js';
import { extractURLFromSlackInput, postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['run-brand-claims'];

// DRS Brand-Presence bucket comes from env DRS_BP_BUCKET (set per environment).
// Required — no default, so a misconfigured env can never silently target the
// wrong bucket; the command errors if it's unset.
const BP_PLATFORM = 'chatgpt_free';

// DRS weekly/daily sheet filenames only; skips experiment and week/year-less names.
const SHEET_FILENAME_RE = /-w(\d{1,2})-(\d{4})(?:-(\d{6}))?\.xlsx$/i;
const KEY_DATE_RE = /\/(\d{4})\/(\d{2})\/(\d{2})\//;

// Safety cap so a pathological key space can't hang the command until Lambda timeout.
const MAX_LISTING_PAGES = 10;

/**
 * Mirrors DRS's `sanitize_path_component` (src/common/utils/path_utils.py) —
 * must match byte-for-byte, since the Brand Claims consumer's own freshness
 * re-list uses the same `brand` value to find the sheet.
 *
 * @param {string} component - Raw brand name.
 * @returns {string} Sanitized S3 path component.
 */
export function sanitizePathComponent(component) {
  const raw = typeof component === 'string' ? component : String(component ?? '');
  let sanitized = raw.toLowerCase()
    .replaceAll('.', '-')
    .replaceAll('/', '-')
    .replaceAll('\\', '-')
    .replace(/[^a-z0-9-_]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!sanitized && raw.trim()) {
    sanitized = crypto.createHash('sha256').update(raw.toLowerCase(), 'utf8').digest('hex').slice(0, 16);
  }

  return sanitized;
}

/**
 * Finds the same "latest" object under `prefix` the Brand Claims consumer's
 * freshness guard would independently pick: max by (S3 date partition,
 * LastModified) — mirrors `brand_presence_s3.discover_latest_bp_object`.
 *
 * @param {object} s3Client - AWS SDK S3 client.
 * @param {string} prefix - `{siteId}/{brandSlug}/analytics/{platform}/`.
 * @param {string} bucket - DRS Brand-Presence bucket name (env DRS_BP_BUCKET).
 * @returns {Promise<object|null>} `{key, week, year, cadence, sheetDate}` or null.
 */
async function findLatestSheet(s3Client, prefix, bucket) {
  let best = null;
  let continuationToken;
  let pages = 0;

  do {
    pages += 1;
    // eslint-disable-next-line no-await-in-loop
    const response = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

    for (const object of response.Contents || []) {
      const key = object.Key;
      const filenameMatch = key.match(SHEET_FILENAME_RE);
      const dateMatch = key.match(KEY_DATE_RE);

      if (filenameMatch && dateMatch) {
        const [, yyyy, mm, dd] = dateMatch;
        const partitionDate = `${yyyy}-${mm}-${dd}`;
        const lastModified = object.LastModified ? new Date(object.LastModified).getTime() : 0;

        if (!best
          || partitionDate > best.partitionDate
          || (partitionDate === best.partitionDate && lastModified > best.lastModified)) {
          const [, week, year, dailySuffix] = filenameMatch;
          best = {
            key,
            partitionDate,
            lastModified,
            week: parseInt(week, 10),
            year: parseInt(year, 10),
            cadence: dailySuffix ? 'daily' : 'weekly',
            sheetDate: partitionDate,
          };
        }
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken && pages < MAX_LISTING_PAGES);

  return best;
}

/**
 * Slack command: force an on-demand Brand Claims run for a site. Looks up the
 * site's actual latest Brand Presence sheet, then publishes the DRS-shaped
 * `BRAND_PRESENCE_SHEET_WRITTEN` event onto the `mysticat-bp-sheet-ready`
 * queue (a guessed/stale `s3_key` would be rejected by the consumer's own
 * freshness guard, so this looks the real key up rather than constructing it).
 *
 * @param {Object} context - The context object.
 * @returns {Object} The command object.
 */
function RunBrandClaimsCommand(context) {
  const baseCommand = BaseCommand({
    id: 'run-brand-claims',
    name: 'Run Brand Claims',
    description: 'Forces an on-demand Brand Claims run for a site by re-publishing the DRS ready-signal for its latest Brand Presence sheet.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL|siteId}`,
  });

  const { dataAccess, log, sqs } = context;
  const { Site } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const queueUrl = context.env?.SQS_BP_SHEET_READY_QUEUE_URL;
      if (!queueUrl) {
        await say(':x: SQS_BP_SHEET_READY_QUEUE_URL is not configured in this environment.');
        return;
      }

      const drsBpBucket = context.env?.DRS_BP_BUCKET;
      if (!drsBpBucket) {
        await say(':x: DRS_BP_BUCKET is not configured in this environment.');
        return;
      }

      const [siteArg] = args;
      if (!siteArg) {
        await say(baseCommand.usage());
        return;
      }

      const resolvedSiteArg = isValidUUID(siteArg) ? siteArg : extractURLFromSlackInput(siteArg);
      if (!resolvedSiteArg) {
        await say(`:warning: Could not parse a valid URL or site ID from \`${siteArg}\`. ${baseCommand.usage()}`);
        return;
      }

      const site = isValidUUID(resolvedSiteArg)
        ? await Site.findById(resolvedSiteArg)
        : await Site.findByBaseURL(resolvedSiteArg);

      if (!site) {
        await say(`:x: Site not found: \`${siteArg}\``);
        return;
      }

      const postgrestClient = dataAccess?.services?.postgrestClient;
      if (!postgrestClient?.from) {
        await say(':x: Brand storage is not available in this environment.');
        return;
      }

      const brand = await getBrandBySite(
        site.getOrganizationId(),
        site.getId(),
        postgrestClient,
        log,
      );
      if (!brand) {
        await say(`:warning: No active brand found for site \`${site.getBaseURL()}\`.`);
        return;
      }

      if (!brand.brandClaimsEnabled) {
        await say(`:warning: Brand claims is not enabled for brand "${brand.name}" (${brand.id}). Run \`enable-brand-claims ${brand.id}\` first.`);
        return;
      }

      const brandSlug = sanitizePathComponent(brand.name);
      if (!brandSlug) {
        await say(`:x: Brand name "${brand.name}" (${brand.id}) sanitizes to an empty S3 path component — cannot look up its sheet.`);
        return;
      }

      const prefix = `${site.getId()}/${brandSlug}/analytics/${BP_PLATFORM}/`;
      const sheet = await findLatestSheet(context.s3.s3Client, prefix, drsBpBucket);

      if (!sheet) {
        await say(`:warning: No Brand Presence sheet found yet for \`${site.getBaseURL()}\` on platform \`${BP_PLATFORM}\` — nothing to run.`);
        return;
      }

      const event = {
        event_type: 'BRAND_PRESENCE_SHEET_WRITTEN',
        schema_version: 1,
        // The Brand Claims consumer resolves the brand via
        // `GET /v2/orgs/{spaceCatId}/sites/{siteId}/brand`, whose path param is the
        // SpaceCat org UUID (validated `isValidUUID`) — NOT the IMS org id. Sending
        // `getImsOrgId()` (…@AdobeOrg) 400s there and the event is silently
        // enablement-dropped. Use the spacecat org UUID. (LLMO-6143)
        organization_id: site.getOrganizationId(),
        brand_id: brand.id,
        brand: brandSlug,
        site_id: site.getId(),
        week: sheet.week,
        year: sheet.year,
        cadence: sheet.cadence,
        sheet_date: sheet.sheetDate,
        platform: BP_PLATFORM,
        s3_bucket: drsBpBucket,
        s3_key: sheet.key,
        parent_job_id: null,
        batch_id: null,
      };

      await sqs.sendMessage(queueUrl, event);

      log.info(`run-brand-claims: published ready-signal for site ${site.getId()} (brand "${brand.name}"), s3_key=${sheet.key}`);
      await say(
        `:white_check_mark: Requested a Brand Claims run for \`${site.getBaseURL()}\` `
        + `(brand "${brand.name}"), referencing sheet \`${sheet.key}\` `
        + `(week ${sheet.week}, ${sheet.year}, ${sheet.cadence}). `
        + 'Actual execution depends on the Brand Claims consumer\'s freshness/concurrency gates — check mystique logs for the outcome.',
      );
    } catch (error) {
      log.error(error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default RunBrandClaimsCommand;
