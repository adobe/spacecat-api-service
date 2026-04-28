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

import { llmoConfig as llmo } from '@adobe/spacecat-shared-utils';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import BaseCommand from './base.js';
import {
  appendLimitedDetails,
  formatUtcDate,
  getUtcYMD,
  isFutureUtcDate,
  parseStatusCommandArgs,
  parseUtcDateArg,
  postReport,
} from './status-command-helpers.js';
import { postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['check cdn logs status'];
const CDN_LOGS_AUDIT = 'cdn-logs-analysis';
const BATCH_SIZE = 10;

// These CDN families only produce a single daily aggregate (hour 23).
// All others produce 24 hourly aggregates (hours 00–23).
const DAILY_ONLY_CDN_FAMILIES = new Set(['cloudflare', 'imperva', 'other']);
const SERVICE_PROVIDER_TO_CDN_FAMILY = {
  'aem-cs-fastly': 'fastly',
  'commerce-fastly': 'fastly',
  'byocdn-fastly': 'fastly',
  'byocdn-akamai': 'akamai',
  'byocdn-cloudflare': 'cloudflare',
  'byocdn-cloudfront': 'cloudfront',
  'byocdn-frontdoor': 'frontdoor',
  'byocdn-imperva': 'imperva',
  'byocdn-other': 'other',
  'ams-cloudfront': 'cloudfront',
  'ams-frontdoor': 'frontdoor',
};

const ALL_HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));

function normalizeProvider(raw) {
  return raw ? String(raw).trim().toLowerCase() : 'unknown';
}

function getCdnFamily(cdnProvider) {
  const normalized = normalizeProvider(cdnProvider);
  if (SERVICE_PROVIDER_TO_CDN_FAMILY[normalized]) {
    return SERVICE_PROVIDER_TO_CDN_FAMILY[normalized];
  }
  if (normalized.includes('cloudflare')) {
    return 'cloudflare';
  }
  if (normalized.includes('imperva') || normalized.includes('incapsula')) {
    return 'imperva';
  }
  if (normalized.includes('fastly')) {
    return 'fastly';
  }
  if (normalized.includes('akamai')) {
    return 'akamai';
  }
  if (normalized.includes('cloudfront')) {
    return 'cloudfront';
  }
  if (normalized.includes('frontdoor')) {
    return 'frontdoor';
  }
  return normalized;
}

function resolveAggregateBucket(env, region) {
  const environment = env.AWS_ENV || 'prod';
  return `spacecat-${environment}-cdn-logs-aggregates-${region}`;
}

function getSiteLlmoConfig(site) {
  return site.getConfig?.()?.getLlmoConfig?.() || {};
}

function getSiteCdnBucketConfig(site) {
  return site.getConfig?.()?.getLlmoCdnBucketConfig?.()
    || getSiteLlmoConfig(site).cdnBucketConfig
    || {};
}

function renderOmittedSites(omitted) {
  return `… ${omitted} more. Re-run with \`siteId=<siteId>\` for focused details.`;
}

/**
 * Lists which hours have aggregate data for a site/day by querying S3 common prefixes.
 *
 * @param {import('@aws-sdk/client-s3').S3Client} s3Client
 * @param {string} bucket
 * @param {string} prefix - S3 key prefix for the site/day, e.g. aggregated/{siteId}/{y}/{m}/{d}/
 * @returns {Promise<string[]>} Sorted list of present hour strings ('00'–'23').
 */
async function listPresentHours(s3Client, bucket, prefix) {
  const hours = new Set();
  let continuationToken;

  do {
    // eslint-disable-next-line no-await-in-loop
    const response = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: '/',
      ContinuationToken: continuationToken,
    }));

    for (const cp of response.CommonPrefixes || []) {
      // CommonPrefix format: aggregated/{siteId}/{year}/{month}/{day}/{hour}/
      const hour = cp.Prefix.slice(prefix.length).replace(/\/$/, '');
      if (hour) {
        hours.add(hour);
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return [...hours].sort();
}

/**
 * Gets CDN provider and aggregate bucket settings for a site from LLMO config.
 *
 * @param {Object} site
 * @param {import('@aws-sdk/client-s3').S3Client} s3Client
 * @param {string} s3Bucket
 * @param {Object} env
 * @returns {Promise<Object>} Normalized CDN settings.
 */
async function getCdnSettings(site, s3Client, s3Bucket, env, log) {
  let s3Config;
  let configReadFailed = false;
  try {
    ({ config: s3Config } = await llmo.readConfig(site.getId(), s3Client, { s3Bucket }));
  } catch (e) {
    configReadFailed = true;
    log.warn(`LLMO config read failed for site ${site.getId()}: ${e.message}`);
    s3Config = {};
  }

  const siteLlmoConfig = getSiteLlmoConfig(site);
  const siteCdnBucketConfig = getSiteCdnBucketConfig(site);
  const cdnProvider = normalizeProvider(
    s3Config?.cdnBucketConfig?.cdnProvider
      || siteCdnBucketConfig?.cdnProvider
      || siteLlmoConfig?.detectedCdn,
  );
  const cdnFamily = getCdnFamily(cdnProvider);
  const region = s3Config?.cdnBucketConfig?.region
    || siteCdnBucketConfig?.region
    || env.AWS_REGION
    || 'us-east-1';

  return {
    cdnProvider,
    cdnFamily,
    region,
    aggregateBucket: resolveAggregateBucket(env, region),
    configReadFailed,
  };
}

/**
 * Factory function to create the CheckCdnLogsStatusCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {CheckCdnLogsStatusCommand} The command object.
 */
function CheckCdnLogsStatusCommand(context) {
  const baseCommand = BaseCommand({
    id: 'check-cdn-logs-status',
    name: 'Check CDN Logs Status',
    description: 'Checks CDN logs aggregate processing status for all sites with cdn-logs-analysis enabled.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} [YYYY-MM-DD] [siteId=<siteId>]`,
  });

  const {
    dataAccess, log, s3, env = {},
  } = context;
  const { Site, Configuration } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      if (!s3?.s3Client) {
        await say(':x: S3 client not available.');
        return;
      }

      const parsedArgs = parseStatusCommandArgs(args);
      if (parsedArgs.error) {
        await say(parsedArgs.error);
        return;
      }

      const { dateArg, siteId: requestedSiteId } = parsedArgs;
      let targetDate;
      if (dateArg) {
        targetDate = parseUtcDateArg(dateArg);
        if (!targetDate) {
          await say(':warning: Invalid date format. Use YYYY-MM-DD.');
          return;
        }
      } else {
        targetDate = new Date();
        targetDate.setUTCDate(targetDate.getUTCDate() - 1);
      }
      if (isFutureUtcDate(targetDate)) {
        await say(':warning: Cannot check a future traffic date.');
        return;
      }

      const dateStr = formatUtcDate(targetDate);
      const { year, month, day } = getUtcYMD(targetDate);
      const siteScopeText = requestedSiteId ? ` for site \`${requestedSiteId}\`` : '';

      // Resolve default CDN aggregate bucket name from environment. Per-site
      // region overrides are honored below when the site config provides them.
      const defaultRegion = env.AWS_REGION || 'us-east-1';
      const defaultAggregateBucket = resolveAggregateBucket(env, defaultRegion);

      await say(`:hourglass_flowing_sand: Checking CDN logs status for *${dateStr}*${siteScopeText} in \`${defaultAggregateBucket}\`...`);

      // Find all sites with cdn-logs-analysis enabled
      const configuration = await Configuration.findLatest();
      const candidateSites = requestedSiteId
        ? [await Site.findById(requestedSiteId)].filter(Boolean)
        : await Site.all();

      if (requestedSiteId && candidateSites.length === 0) {
        await say(`:warning: No site found with siteId \`${requestedSiteId}\`.`);
        return;
      }

      const enabledSites = candidateSites.filter(
        (site) => configuration.isHandlerEnabledForSite(CDN_LOGS_AUDIT, site),
      );

      if (enabledSites.length === 0) {
        await say(requestedSiteId
          ? `:information_source: Site \`${requestedSiteId}\` does not have cdn-logs-analysis enabled.`
          : ':information_source: No sites have cdn-logs-analysis enabled.');
        return;
      }

      await say(`:gear: Checking ${enabledSites.length} enabled site${enabledSites.length === 1 ? '' : 's'}...`);

      const { s3Client } = s3;
      const results = [];

      // Process in batches to avoid overwhelming S3
      for (let i = 0; i < enabledSites.length; i += BATCH_SIZE) {
        const batch = enabledSites.slice(i, i + BATCH_SIZE);
        // eslint-disable-next-line no-await-in-loop
        const batchResults = await Promise.all(batch.map(async (site) => {
          const siteId = site.getId();
          const baseURL = site.getBaseURL();

          try {
            const {
              cdnProvider,
              cdnFamily,
              region,
              aggregateBucket,
              configReadFailed,
            } = await getCdnSettings(site, s3Client, s3.s3Bucket, env, log);
            const isDailyOnly = DAILY_ONLY_CDN_FAMILIES.has(cdnFamily);
            const expectedHours = isDailyOnly ? ['23'] : ALL_HOURS;

            const aggPrefix = `aggregated/${siteId}/${year}/${month}/${day}/`;
            const presentHours = await listPresentHours(s3Client, aggregateBucket, aggPrefix);
            const presentSet = new Set(presentHours);
            const missingHours = expectedHours.filter((h) => !presentSet.has(h));

            return {
              siteId,
              baseURL,
              cdnProvider,
              cdnFamily,
              region,
              aggregateBucket,
              isDailyOnly,
              expectedCount: expectedHours.length,
              presentCount: presentHours.length,
              missingHours,
              status: missingHours.length === 0 ? 'complete' : 'incomplete',
              configReadFailed,
            };
          } catch (e) {
            log.warn(`CDN logs status check failed for site ${siteId}: ${e.message}`);
            return {
              siteId,
              baseURL,
              cdnProvider: 'error',
              status: 'error',
              error: e.message,
            };
          }
        }));
        results.push(...batchResults);
      }

      const complete = results.filter((r) => r.status === 'complete');
      const incomplete = results.filter((r) => r.status === 'incomplete');
      const errors = results.filter((r) => r.status === 'error');
      const configReadFailures = results.filter((r) => r.configReadFailed);
      const missingAll = incomplete.filter((r) => r.presentCount === 0);
      const partialCoverage = incomplete.filter((r) => r.presentCount > 0);
      const dailyOnlyMissing = incomplete.filter((r) => r.isDailyOnly);
      const hourlyMissing = incomplete.filter((r) => !r.isDailyOnly);
      const outcome = incomplete.length === 0 && errors.length === 0
        ? 'READY_FOR_DB_IMPORT'
        : 'ACTION_REQUIRED';

      const lines = [
        `*CDN Logs Aggregate Status — ${dateStr}*`,
        `Outcome: *${outcome}*`,
        `:white_check_mark: Complete: *${complete.length}*`,
        `:warning: Incomplete: *${incomplete.length}*`,
        `:x: Errors: *${errors.length}*`,
        `Sites checked: *${results.length}*`,
      ];
      if (configReadFailures.length > 0) {
        lines.push(`:warning: LLMO config unavailable for *${configReadFailures.length}* site${configReadFailures.length === 1 ? '' : 's'}; using site/default config fallback.`);
      }

      lines.push('', '*Actionable insight:*');
      if (incomplete.length === 0 && errors.length === 0) {
        lines.push(`All *${complete.length}* checked site(s) have expected CDN log aggregates. Action: proceed to DB import/status checks for ${dateStr}.`);
      } else {
        if (complete.length > 0) {
          lines.push(`${complete.length} site(s) have inputs ready for DB import.`);
        }
        if (missingAll.length > 0) {
          lines.push(`${missingAll.length} site(s) have no aggregate hours. Action: wait for or investigate upstream CDN aggregation before DB backfill.`);
        }
        if (partialCoverage.length > 0) {
          lines.push(`${partialCoverage.length} site(s) have partial aggregate coverage. Action: rerun this check before backfill; only backfill after expected hours are present.`);
        }
        if (dailyOnlyMissing.length > 0) {
          lines.push(`${dailyOnlyMissing.length} daily-only site(s) are missing hour 23.`);
        }
        if (hourlyMissing.length > 0) {
          lines.push(`${hourlyMissing.length} hourly site(s) are missing one or more hourly aggregates.`);
        }
        if (configReadFailures.length > 0) {
          lines.push(`${configReadFailures.length} site(s) used fallback config. Action: verify LLMO config/S3 access for those sites.`);
        }
        if (errors.length > 0) {
          lines.push(`${errors.length} site check(s) errored. Action: check API logs before trusting the aggregate status.`);
        }
      }

      if (incomplete.length > 0) {
        lines.push('', '*Sites with missing aggregate hours:*');
        appendLimitedDetails(lines, incomplete, (r) => {
          const providerName = r.cdnProvider === r.cdnFamily
            ? r.cdnProvider
            : `${r.cdnProvider} => ${r.cdnFamily}`;
          const providerTag = r.isDailyOnly ? `${providerName} [daily-only]` : providerName;
          const configWarning = r.configReadFailed ? ' — config unavailable, using fallback' : '';
          let missingStr;
          if (r.missingHours.length <= 6) {
            missingStr = r.missingHours.join(', ');
          } else {
            missingStr = `${r.missingHours.slice(0, 6).join(', ')} (+${r.missingHours.length - 6} more)`;
          }
          return [
            `• \`${r.baseURL}\``,
            `  siteId: \`${r.siteId}\``,
            `  CDN: ${providerTag}${configWarning}`,
            `  missing: [${missingStr}]`,
            `  present: ${r.presentCount}/${r.expectedCount}`,
          ].join('\n');
        }, renderOmittedSites);
      }

      if (errors.length > 0) {
        lines.push('', '*Sites with errors:*');
        appendLimitedDetails(lines, errors, (r) => [
          `• \`${r.baseURL}\``,
          `  siteId: \`${r.siteId}\``,
          `  error: ${r.error}`,
        ].join('\n'), renderOmittedSites);
      }

      await postReport(
        slackContext,
        lines,
        `cdn-logs-status-${dateStr}`,
        `CDN Logs Status ${dateStr}`,
        `CDN logs aggregate status report for ${dateStr}`,
      );
    } catch (error) {
      log.error('Error in check-cdn-logs-status:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);
  return { ...baseCommand, handleExecution };
}

export default CheckCdnLogsStatusCommand;
