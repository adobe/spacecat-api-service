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
import { postErrorMessage } from '../../../utils/slack/base.js';

const PHRASES = ['check cdn logs status'];
const CDN_LOGS_AUDIT = 'cdn-logs-analysis';
const BATCH_SIZE = 10;
const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SITE_ID_ARG_RE = /^(siteId|site-id|site_id)=(.*)$/i;

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
const pad2 = (n) => String(n).padStart(2, '0');

function getYMD(date) {
  return {
    year: String(date.getUTCFullYear()),
    month: pad2(date.getUTCMonth() + 1),
    day: pad2(date.getUTCDate()),
  };
}

function parseCommandArgs(args) {
  const parsed = {};

  for (const rawArg of args) {
    const arg = String(rawArg || '').trim();
    if (arg) {
      const siteIdMatch = arg.match(SITE_ID_ARG_RE);
      if (siteIdMatch) {
        parsed.siteId = siteIdMatch[2].trim();
        if (!parsed.siteId) {
          return { error: ':warning: siteId must not be empty.' };
        }
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
        parsed.dateArg = arg;
      } else if (SITE_ID_RE.test(arg)) {
        parsed.siteId = arg;
      } else {
        return { error: ':warning: Invalid date format. Use YYYY-MM-DD.' };
      }
    }
  }

  return parsed;
}

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
async function getCdnSettings(site, s3Client, s3Bucket, env) {
  let s3Config;
  try {
    ({ config: s3Config } = await llmo.readConfig(site.getId(), s3Client, { s3Bucket }));
  } catch {
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

      const parsedArgs = parseCommandArgs(args);
      if (parsedArgs.error) {
        await say(parsedArgs.error);
        return;
      }

      const { dateArg, siteId: requestedSiteId } = parsedArgs;
      let targetDate;
      if (dateArg) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
          await say(':warning: Invalid date format. Use YYYY-MM-DD.');
          return;
        }
        targetDate = new Date(`${dateArg}T00:00:00Z`);
        if (Number.isNaN(targetDate.getTime())) {
          await say(':warning: Invalid date format. Use YYYY-MM-DD.');
          return;
        }
      } else {
        targetDate = new Date();
        targetDate.setUTCDate(targetDate.getUTCDate() - 1);
      }

      const dateStr = targetDate.toISOString().slice(0, 10);
      const { year, month, day } = getYMD(targetDate);
      const siteScopeText = requestedSiteId ? ` for site \`${requestedSiteId}\`` : '';

      // Resolve default CDN aggregate bucket name from environment. Per-site
      // region overrides are honored below when the site config provides them.
      const defaultRegion = env.AWS_REGION || 'us-east-1';
      const defaultAggregateBucket = resolveAggregateBucket(env, defaultRegion);

      await say(`:hourglass_flowing_sand: Checking CDN logs status for *${dateStr}*${siteScopeText} in \`${defaultAggregateBucket}\`...`);

      // Find all sites with cdn-logs-analysis enabled
      const [allSites, configuration] = await Promise.all([
        Site.all(),
        Configuration.findLatest(),
      ]);
      const candidateSites = requestedSiteId
        ? allSites.filter((site) => site.getId() === requestedSiteId)
        : allSites;

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
            } = await getCdnSettings(site, s3Client, s3.s3Bucket, env);
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

      const lines = [
        `*CDN Logs Aggregate Status — ${dateStr}*`,
        `:white_check_mark: Complete: *${complete.length}*  :warning: Incomplete: *${incomplete.length}*  :x: Errors: *${errors.length}*  (${results.length} total sites)`,
      ];

      if (incomplete.length > 0) {
        lines.push('', '*Sites with missing aggregate hours:*');
        for (const r of incomplete) {
          const providerName = r.cdnProvider === r.cdnFamily
            ? r.cdnProvider
            : `${r.cdnProvider} => ${r.cdnFamily}`;
          const providerTag = r.isDailyOnly ? `${providerName} [daily-only]` : providerName;
          let missingStr;
          if (r.missingHours.length <= 6) {
            missingStr = r.missingHours.join(', ');
          } else {
            missingStr = `${r.missingHours.slice(0, 6).join(', ')} (+${r.missingHours.length - 6} more)`;
          }
          lines.push(
            `• \`${r.baseURL}\` (${r.siteId}) — CDN: ${providerTag} — missing: [${missingStr}] — present: ${r.presentCount}/${r.expectedCount}`,
          );
        }
      }

      if (errors.length > 0) {
        lines.push('', '*Sites with errors:*');
        for (const r of errors) {
          lines.push(`• \`${r.baseURL}\` (${r.siteId}) — ${r.error}`);
        }
      }

      // Slack has a ~3000 char text limit; chunk if needed
      const CHUNK_LIMIT = 2800;
      const fullText = lines.join('\n');
      if (fullText.length <= CHUNK_LIMIT) {
        await say(fullText);
      } else {
        let chunk = '';
        for (const line of lines) {
          if (chunk.length + line.length + 1 > CHUNK_LIMIT) {
            // eslint-disable-next-line no-await-in-loop
            await say(chunk.trim());
            chunk = '';
          }
          chunk += `${line}\n`;
        }
        if (chunk.trim()) {
          await say(chunk.trim());
        }
      }
    } catch (error) {
      log.error('Error in check-cdn-logs-status:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);
  return { ...baseCommand, handleExecution };
}

export default CheckCdnLogsStatusCommand;
