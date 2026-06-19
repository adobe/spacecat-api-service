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
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import BaseCommand from './base.js';
import {
  appendStatusDetails,
  formatUtcDate,
  getUtcYMD,
  isFutureUtcDate,
  parseStatusCommandArgs,
  parseUtcDateArg,
  postReport,
  resolveSiteScope,
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
 * Validates if a bucket name is a standard Adobe CDN logs bucket (mirrors
 * spacecat-audit-worker's cdn-utils.isStandardAdobeCdnBucket). Standardized
 * buckets store raw logs under a `{pathId}/raw/{serviceProvider}/` prefix;
 * legacy/BYOCDN buckets store them under a flat `raw/` prefix.
 *
 * @param {string} bucketName
 * @returns {boolean}
 */
function isStandardAdobeCdnBucket(bucketName) {
  if (/^cdn-logs-adobe-(prod|dev|stage)$/.test(bucketName)) {
    return true;
  }
  if (/^cdn-logs-[a-zA-Z0-9-]+$/.test(bucketName)) {
    const suffix = bucketName.substring('cdn-logs-'.length);
    if (/[a-zA-Z]/.test(suffix) && /[0-9]/.test(suffix)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves the raw CDN logs bucket and pathId for a site. Mirrors the resolution
 * in spacecat-audit-worker (resolveCdnBucketName + pathId): the configured
 * `bucketName` wins, else the standardized `cdn-logs-adobe-{env}` bucket; pathId
 * is the configured `orgId`, else the org's IMS org id.
 *
 * @param {Object} site
 * @param {Object} env
 * @param {Object} Organization - data-access Organization model
 * @param {Object} log
 * @returns {Promise<{rawBucket: string, pathId: string|null}>}
 */
async function resolveRawLogLocation(site, env, Organization, log) {
  const cdnBucketConfig = getSiteCdnBucketConfig(site);
  const rawBucket = cdnBucketConfig.bucketName
    || `cdn-logs-adobe-${env.AWS_ENV || 'prod'}`;

  let pathId = cdnBucketConfig.orgId || null;
  if (!pathId && isStandardAdobeCdnBucket(rawBucket)) {
    try {
      const orgId = site.getOrganizationId?.();
      const org = orgId ? await Organization.findById(orgId) : null;
      pathId = org?.getImsOrgId?.() || null;
    } catch (e) {
      log.warn(`Could not resolve IMS org id for site ${site.getId()}: ${e.message}`);
    }
  }
  return { rawBucket, pathId };
}

/**
 * Builds the S3 key prefix at which raw logs for a site/day live, accounting for
 * provider-specific layouts (mirrors spacecat-audit-worker cdn-analysis handler):
 * cloudflare = `{y}{m}{d}/`, byocdn-other/hourly providers = `{y}/{m}/{d}/`,
 * imperva = flat (no date partition). Raw is only reliably resolvable at day
 * granularity, which matches how the aggregation pipeline reasons about raw logs.
 *
 * @param {string} rawBucket
 * @param {string|null} pathId
 * @param {string} serviceProvider - e.g. 'aem-cs-fastly', 'byocdn-other'
 * @param {string} cdnFamily - e.g. 'fastly', 'cloudflare', 'imperva'
 * @param {{year: string, month: string, day: string}} ymd
 * @returns {string} S3 key prefix to list for raw-log presence.
 */
function buildRawDayPrefix(rawBucket, pathId, serviceProvider, cdnFamily, ymd) {
  const { year, month, day } = ymd;
  const base = isStandardAdobeCdnBucket(rawBucket) && pathId
    ? `${pathId}/raw/${serviceProvider}/`
    : 'raw/';
  if (cdnFamily === 'cloudflare') {
    return `${base}${year}${month}${day}/`;
  }
  if (cdnFamily === 'imperva') {
    return base;
  }
  return `${base}${year}/${month}/${day}/`;
}

/**
 * Returns true if at least one object exists under the given bucket/prefix.
 *
 * @param {import('@aws-sdk/client-s3').S3Client} s3Client
 * @param {string} bucket
 * @param {string} prefix
 * @returns {Promise<boolean>}
 */
async function rawDataExists(s3Client, bucket, prefix) {
  const response = await s3Client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: 1,
  }));
  return (response.KeyCount ?? response.Contents?.length ?? 0) > 0;
}

/**
 * For an incomplete site, determines whether raw logs exist for the day, so the
 * caller can tell a genuine aggregation miss (raw present, aggregate missing)
 * apart from an expected gap (no raw logs to aggregate).
 *
 * @returns {Promise<'present'|'absent'|'unknown'>}
 */
async function resolveRawStatus(site, result, deps) {
  const {
    env, Organization, getS3ClientForRegion, ymd, log,
  } = deps;
  /* c8 ignore next 3 -- defensive: every incomplete result's siteId is in siteById */
  if (!site) {
    return 'unknown';
  }
  try {
    const { rawBucket, pathId } = await resolveRawLogLocation(site, env, Organization, log);
    const prefix = buildRawDayPrefix(rawBucket, pathId, result.cdnProvider, result.cdnFamily, ymd);
    // The raw bucket (CDN/BYOCDN bucket) is a different bucket than the aggregate
    // bucket, but both live in the site's configured CDN region — so the same
    // per-region client (keyed on result.region) is correct for both paths.
    const exists = await rawDataExists(getS3ClientForRegion(result.region), rawBucket, prefix);
    return exists ? 'present' : 'absent';
  } catch (e) {
    log.warn(`Raw-log presence check failed for site ${result.siteId}: ${e.message}`);
    return 'unknown';
  }
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
    usageText: `${PHRASES[0]} [YYYY-MM-DD] [siteId=<siteId>|baseUrl=<url>]`,
  });

  const {
    dataAccess, log, s3, env = {},
  } = context;
  const { Site, Configuration, Organization } = dataAccess;

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

      const { dateArg } = parsedArgs;
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
      let siteScopeText = '';
      if (parsedArgs.siteId) {
        siteScopeText = ` for site \`${parsedArgs.siteId}\``;
      } else if (parsedArgs.baseURL) {
        siteScopeText = ` for site \`${parsedArgs.baseURL}\``;
      }

      // Resolve default CDN aggregate bucket name from environment. Per-site
      // region overrides are honored below when the site config provides them.
      const defaultRegion = env.AWS_REGION || 'us-east-1';
      const defaultAggregateBucket = resolveAggregateBucket(env, defaultRegion);

      await say(`:hourglass_flowing_sand: Checking CDN logs status for *${dateStr}*${siteScopeText} in \`${defaultAggregateBucket}\`...`);

      const scope = await resolveSiteScope(Site, parsedArgs);
      if (scope.error) {
        await say(scope.error);
        return;
      }
      const { candidateSites } = scope;
      // Find all sites with cdn-logs-analysis enabled
      const configuration = await Configuration.findLatest();
      const enabledSites = candidateSites.filter(
        (site) => configuration.isHandlerEnabledForSite(CDN_LOGS_AUDIT, site),
      );

      if (enabledSites.length === 0) {
        await say(siteScopeText
          ? `:information_source: Site${siteScopeText.replace(/^ for site/, '')} does not have cdn-logs-analysis enabled.`
          : ':information_source: No sites have cdn-logs-analysis enabled.');
        return;
      }

      await say(`:gear: Checking ${enabledSites.length} enabled site${enabledSites.length === 1 ? '' : 's'}...`);

      const { s3Client } = s3;
      // Aggregate buckets are per-region; reuse the runtime-region client and lazily
      // create one client per other region (not per site) to avoid cross-region 301s.
      const runtimeRegion = env.AWS_REGION || 'us-east-1';
      const s3ClientsByRegion = new Map([[runtimeRegion, s3Client]]);
      const getS3ClientForRegion = (region) => {
        let client = s3ClientsByRegion.get(region);
        if (!client) {
          client = new S3Client({ region });
          s3ClientsByRegion.set(region, client);
        }
        return client;
      };
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
            const presentHours = await listPresentHours(
              getS3ClientForRegion(region),
              aggregateBucket,
              aggPrefix,
            );
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

      // A site with missing aggregate hours is only a genuine miss when raw logs
      // actually exist for the day; if there are no raw logs there was nothing to
      // aggregate (expected). Resolve raw presence only for the incomplete subset
      // (one S3 list per site) — complete sites are already proven processed.
      const siteById = new Map(enabledSites.map((s) => [s.getId(), s]));
      const rawDeps = {
        env,
        Organization,
        getS3ClientForRegion,
        ymd: { year, month, day },
        log,
      };
      const rawStatusById = new Map();
      for (let i = 0; i < incomplete.length; i += BATCH_SIZE) {
        const batch = incomplete.slice(i, i + BATCH_SIZE);
        // eslint-disable-next-line no-await-in-loop
        await Promise.all(batch.map(async (r) => {
          rawStatusById.set(r.siteId, await resolveRawStatus(siteById.get(r.siteId), r, rawDeps));
        }));
      }

      const genuinelyMissing = incomplete.filter((r) => rawStatusById.get(r.siteId) === 'present');
      const noRawLogs = incomplete.filter((r) => rawStatusById.get(r.siteId) === 'absent');
      const rawUnknown = incomplete.filter((r) => rawStatusById.get(r.siteId) === 'unknown');
      const missingAll = genuinelyMissing.filter((r) => r.presentCount === 0);
      const partialCoverage = genuinelyMissing.filter((r) => r.presentCount > 0);

      const lines = [
        `*CDN Logs Aggregate Status — ${dateStr}*`,
        `:white_check_mark: Complete: *${complete.length}*`,
        `:warning: Missing (raw logs present, not aggregated): *${genuinelyMissing.length}*`,
        `:ghost: No raw logs — nothing to process: *${noRawLogs.length}*`,
        `:x: Errors: *${errors.length}*`,
        `Sites checked: *${results.length}*`,
      ];
      if (rawUnknown.length > 0) {
        lines.push(`:grey_question: Raw-log status unknown (check failed): *${rawUnknown.length}*`);
      }
      if (configReadFailures.length > 0) {
        lines.push(`:warning: LLMO config unavailable for *${configReadFailures.length}* site${configReadFailures.length === 1 ? '' : 's'}; using site/default config fallback.`);
      }

      lines.push('', '*Actionable insight:*');
      if (genuinelyMissing.length === 0 && rawUnknown.length === 0 && errors.length === 0) {
        const expectedNote = noRawLogs.length > 0
          ? ` ${noRawLogs.length} site(s) had no raw logs for ${dateStr} (nothing to aggregate — expected).`
          : '';
        lines.push(`All site(s) with raw logs have expected CDN log aggregates. Action: proceed to DB import/status checks for ${dateStr}.${expectedNote}`);
      } else {
        if (complete.length > 0) {
          lines.push(`${complete.length} site(s) have inputs ready for DB import.`);
        }
        if (missingAll.length > 0) {
          lines.push(`${missingAll.length} site(s) have raw logs but no aggregate hours. Action: investigate upstream CDN aggregation before DB backfill.`);
        }
        if (partialCoverage.length > 0) {
          lines.push(`${partialCoverage.length} site(s) have raw logs but only partial aggregate coverage. Action: rerun this check before backfill; only backfill after expected hours are present.`);
        }
        if (noRawLogs.length > 0) {
          lines.push(`${noRawLogs.length} site(s) have no raw logs for ${dateStr} — nothing to aggregate (expected, no action).`);
        }
        if (rawUnknown.length > 0) {
          lines.push(`${rawUnknown.length} site(s) could not be classified (raw-log check failed). Action: check API logs/S3 access for those sites.`);
        }
        if (configReadFailures.length > 0) {
          lines.push(`${configReadFailures.length} site(s) used fallback config. Action: verify LLMO config/S3 access for those sites.`);
        }
        if (errors.length > 0) {
          lines.push(`${errors.length} site check(s) errored. Action: check API logs before trusting the aggregate status.`);
        }
      }

      const fullLines = [...lines];
      const addDetails = (header, rows, renderRow) => appendStatusDetails(
        lines,
        fullLines,
        header,
        rows,
        renderRow,
        renderOmittedSites,
      );

      const renderIncompleteRow = (r) => {
        const providerName = r.cdnProvider === r.cdnFamily
          ? r.cdnProvider
          : `${r.cdnProvider} => ${r.cdnFamily}`;
        const providerTag = r.isDailyOnly ? `${providerName} [daily-only]` : providerName;
        const configWarning = r.configReadFailed ? ' — config unavailable, using fallback' : '';
        const missingStr = r.missingHours.length <= 6
          ? r.missingHours.join(', ')
          : `${r.missingHours.slice(0, 6).join(', ')} (+${r.missingHours.length - 6} more)`;
        // Imperva raw logs are delivered flat (no date partition), so the raw-log
        // presence signal for imperva is not scoped to this specific day.
        const rawCaveat = r.cdnFamily === 'imperva'
          ? '\n  note: imperva raw logs are flat (not date-partitioned); raw presence is not day-scoped'
          : '';
        return [
          `• \`${r.baseURL}\``,
          `  siteId: \`${r.siteId}\``,
          `  CDN: ${providerTag}${configWarning}`,
          `  missing: [${missingStr}]`,
          `  present: ${r.presentCount}/${r.expectedCount}${rawCaveat}`,
        ].join('\n');
      };

      addDetails('*Sites missing aggregates (raw logs present — action needed):*', genuinelyMissing, renderIncompleteRow);
      addDetails('*Sites with no raw logs (nothing to aggregate — expected):*', noRawLogs, renderIncompleteRow);
      addDetails('*Sites with unknown raw-log status (check failed):*', rawUnknown, renderIncompleteRow);

      addDetails('*Sites with errors:*', errors, (r) => [
        `• \`${r.baseURL}\``,
        `  siteId: \`${r.siteId}\``,
        `  error: ${r.error}`,
      ].join('\n'));

      await postReport(
        slackContext,
        lines,
        `cdn-logs-status-${dateStr}`,
        `CDN Logs Status ${dateStr}`,
        `CDN logs aggregate status report for ${dateStr}`,
        fullLines,
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
