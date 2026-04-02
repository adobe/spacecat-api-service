#!/usr/bin/env node
/* eslint-disable header/header */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const TARGET_IMPORT_TYPE = 'llmo-prompts-ahrefs';
const GLOBAL_CONFIG_KEY = 'config/spacecat/global-config.json';
const UPDATED_BY = 'remove-llmo-prompts-ahrefs-script';
const API_BASE_URLS = {
  dev: 'https://spacecat.experiencecloud.live/api/ci',
  prod: 'https://spacecat.experiencecloud.live/api/v1',
};
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      bearer: {
        type: 'string',
      },
      env: {
        type: 'string',
        short: 'e',
      },
      'sites-file': {
        type: 'string',
      },
      'config-bucket': {
        type: 'string',
      },
      region: {
        type: 'string',
      },
      'aws-profile': {
        type: 'string',
      },
      profile: {
        type: 'string',
      },
      'dry-run': {
        type: 'boolean',
        default: false,
      },
    },
  });

  const envName = values.env || process.env.SPACECAT_ENV;
  if (!envName || !(envName in API_BASE_URLS)) {
    throw new Error('Provide --env dev|prod (or set SPACECAT_ENV=dev|prod)');
  }

  const sitesFile = values['sites-file'];
  if (!sitesFile) {
    throw new Error('Provide --sites-file <path> to a JSONL file of site ids');
  }

  const configBucket = (values['config-bucket'] || process.env.S3_CONFIG_BUCKET || '').trim();
  if (!configBucket) {
    throw new Error('Provide --config-bucket <bucket> or set S3_CONFIG_BUCKET');
  }

  const bearer = (
    values.bearer
    || process.env.BEARER
    || process.env.bearer
    || ''
  ).trim();
  if (!bearer) {
    throw new Error('Provide --bearer <token> or set BEARER');
  }

  return {
    envName,
    apiBaseUrl: API_BASE_URLS[envName],
    sitesFile,
    configBucket,
    region: values.region || process.env.AWS_REGION || 'us-east-1',
    bearer,
    awsProfile: values['aws-profile'] || values.profile || process.env.AWS_PROFILE || '',
    dryRun: values['dry-run'],
  };
}

async function readJsonlSites(filePath) {
  const content = await readFile(filePath, 'utf8');
  const sites = [];

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.id) {
        sites.push({ id: String(parsed.id), baseURL: parsed.baseURL || '' });
      }
    } catch (error) {
      throw new Error(`Failed to parse JSONL line ${index + 1} in ${filePath}: ${error.message}`);
    }
  }

  return sites;
}

function isUuidV4(value) {
  return UUID_V4_PATTERN.test(value);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`);
  }

  return text ? JSON.parse(text) : null;
}

function normalizeAuthorizationHeader(bearer) {
  if (bearer.toLowerCase().startsWith('bearer ')) {
    return bearer;
  }

  return `Bearer ${bearer}`;
}

function isInvalidSiteIdError(error) {
  return error instanceof Error && error.message.includes('Site Id is invalid');
}

async function updateSiteConfig({ apiBaseUrl, bearer, dryRun }, siteId) {
  const headers = {
    Authorization: normalizeAuthorizationHeader(bearer),
    Accept: 'application/json',
  };

  const site = await fetchJson(`${apiBaseUrl}/sites/${siteId}`, { headers });
  const imports = site?.config?.imports;

  if (!Array.isArray(imports)) {
    return { changed: false, reason: 'site has no imports array' };
  }

  const nextImports = imports.filter((entry) => entry?.type !== TARGET_IMPORT_TYPE);

  if (nextImports.length === imports.length) {
    return { changed: false, reason: 'target import not present' };
  }

  if (dryRun) {
    return {
      changed: true,
      removed: imports.length - nextImports.length,
      dryRun: true,
    };
  }

  await fetchJson(`${apiBaseUrl}/sites/${siteId}`, {
    method: 'PATCH',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      config: {
        imports: nextImports,
      },
    }),
  });

  return {
    changed: true,
    removed: imports.length - nextImports.length,
  };
}

async function updateGlobalConfig({ configBucket, region, dryRun }, s3Client) {
  const response = await s3Client.send(new GetObjectCommand({
    Bucket: configBucket,
    Key: GLOBAL_CONFIG_KEY,
  }));

  const body = await response.Body.transformToString();
  const config = JSON.parse(body);
  const jobs = Array.isArray(config.jobs) ? config.jobs : [];
  const nextJobs = jobs.filter((job) => job?.type !== TARGET_IMPORT_TYPE);

  if (nextJobs.length === jobs.length) {
    return { changed: false, reason: 'target job not present' };
  }

  if (dryRun) {
    return {
      changed: true,
      removed: jobs.length - nextJobs.length,
      dryRun: true,
    };
  }

  const nextConfig = {
    ...config,
    jobs: nextJobs,
    updatedAt: new Date().toISOString(),
    updatedBy: UPDATED_BY,
  };

  await s3Client.send(new PutObjectCommand({
    Bucket: configBucket,
    Key: GLOBAL_CONFIG_KEY,
    Body: JSON.stringify(nextConfig, null, 2),
    ContentType: 'application/json',
    Metadata: {
      region,
      updatedBy: UPDATED_BY,
    },
  }));

  return {
    changed: true,
    removed: jobs.length - nextJobs.length,
  };
}

async function main() {
  const options = parseCliArgs();
  const sites = await readJsonlSites(options.sitesFile);

  if (options.awsProfile) {
    process.env.AWS_PROFILE = options.awsProfile;
    process.env.AWS_SDK_LOAD_CONFIG = '1';
  }

  const s3Client = new S3Client({ region: options.region });

  console.log(`Environment: ${options.envName}`);
  console.log(`API base URL: ${options.apiBaseUrl}`);
  console.log(`Sites file: ${options.sitesFile}`);
  console.log(`Config bucket: ${options.configBucket}`);
  console.log(`AWS profile: ${options.awsProfile || '(default)'}`);
  console.log(`Dry run: ${options.dryRun ? 'yes' : 'no'}`);

  let changedSites = 0;
  let skippedSites = 0;
  let failedSites = 0;

  for (const site of sites) {
    if (!isUuidV4(site.id)) {
      skippedSites += 1;
      console.log(`Site ${site.id}${site.baseURL ? ` (${site.baseURL})` : ''}: skipped (site id is not a UUIDv4)`);
      continue;
    }

    try {
      const result = await updateSiteConfig(options, site.id);
      if (result.changed) {
        changedSites += 1;
        console.log(`Site ${site.id}${site.baseURL ? ` (${site.baseURL})` : ''}: removed ${result.removed} import(s)`);
      } else {
        skippedSites += 1;
        console.log(`Site ${site.id}${site.baseURL ? ` (${site.baseURL})` : ''}: skipped (${result.reason})`);
      }
    } catch (error) {
      if (isInvalidSiteIdError(error)) {
        skippedSites += 1;
        console.log(`Site ${site.id}${site.baseURL ? ` (${site.baseURL})` : ''}: skipped (site id is invalid)`);
        continue;
      }

      failedSites += 1;
      console.error(`Site ${site.id}${site.baseURL ? ` (${site.baseURL})` : ''}: failed - ${error.message}`);
    }
  }

  try {
    const result = await updateGlobalConfig(options, s3Client);
    if (result.changed) {
      console.log(`Global config: removed ${result.removed} job(s)`);
    } else {
      console.log(`Global config: skipped (${result.reason})`);
    }
  } catch (error) {
    failedSites += 1;
    console.error(`Global config: failed - ${error.message}`);
  }

  console.log(`Summary: ${changedSites} site(s) changed, ${skippedSites} site(s) skipped, ${failedSites} failure(s)`);

  if (failedSites > 0) {
    process.exitCode = 1;
  }
}

await main();
