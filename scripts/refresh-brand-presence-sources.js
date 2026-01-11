#!/usr/bin/env node

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

import { AuroraClient } from '../src/support/aurora-client.js';

const BATCH_SIZE = 500; // Records to fetch at a time
const INSERT_BATCH_SIZE = 100; // Sources to insert at a time (7 params each = 700 params max)

// Social media domains
const SOCIAL_MEDIA_DOMAINS = [
  'twitter.com',
  'x.com',
  'facebook.com',
  'linkedin.com',
  'instagram.com',
  'youtube.com',
  'tiktok.com',
  'reddit.com',
  'pinterest.com',
  'tumblr.com',
  'snapchat.com',
  'whatsapp.com',
  'telegram.org',
  'discord.com',
  'twitch.tv',
  'medium.com',
  'quora.com',
];

/**
 * Normalize URL to match UI logic:
 * - Remove query parameters
 * - Remove trailing slash (except root)
 * - Add www. to bare domains
 * - Lowercase protocol
 */
function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return url;

  let normalized = url.trim();

  try {
    // Add protocol if missing
    const urlObj = new URL(normalized.startsWith('http') ? normalized : `https://${normalized}`);

    // Clear all search params
    urlObj.search = '';

    // Add www. to bare domains (if no subdomain)
    const hostParts = urlObj.hostname.split('.');
    // Simple check: if only 2 parts (e.g., "adobe.com"), add www.
    // For subdomains like "helpx.adobe.com" (3+ parts), don't add www.
    if (hostParts.length === 2 && !urlObj.hostname.startsWith('www.')) {
      urlObj.hostname = `www.${urlObj.hostname}`;
    }

    normalized = urlObj.toString();
  } catch {
    // If URL parsing fails, just strip query params with regex
    normalized = normalized.replace(/\?[^#]*/, '');
  }

  // Remove trailing slash, except for root paths
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  // Normalize protocol to lowercase
  if (normalized.startsWith('HTTP://')) {
    normalized = `http://${normalized.slice(7)}`;
  } else if (normalized.startsWith('HTTPS://')) {
    normalized = `https://${normalized.slice(8)}`;
  }

  return normalized;
}

/**
 * Extract hostname from URL (for matching purposes)
 */
function extractHostname(url) {
  if (!url || typeof url !== 'string') return null;

  try {
    // Add protocol if missing
    let urlWithProtocol = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      urlWithProtocol = `https://${url}`;
    }

    const urlObj = new URL(urlWithProtocol);
    // Remove www. prefix and convert to lowercase
    return urlObj.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Check if URL is from the site (owned)
 */
function isOwnedUrl(hostname, siteHostname) {
  if (!hostname || !siteHostname) return false;

  // Exact match or subdomain match
  return hostname === siteHostname || hostname.endsWith(`.${siteHostname}`);
}

/**
 * Check if URL is from social media
 */
function isSocialMediaUrl(hostname) {
  if (!hostname) return false;
  return SOCIAL_MEDIA_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

/**
 * Check if URL is from a competitor
 * Competitors are extracted from business_competitors field
 */
function isCompetitorUrl(hostname, competitorDomains) {
  if (!hostname || !competitorDomains || competitorDomains.length === 0) return false;

  return competitorDomains.some((domain) => {
    const competitorHostname = extractHostname(domain);
    if (!competitorHostname) return false;
    return hostname === competitorHostname || hostname.endsWith(`.${competitorHostname}`);
  });
}

/**
 * Determine content type for a URL
 */
function determineContentType(url, siteHostname, competitorDomains) {
  const hostname = extractHostname(url);
  if (!hostname) return 'earned';

  // Priority 1: Owned
  if (isOwnedUrl(hostname, siteHostname)) {
    return 'owned';
  }

  // Priority 2: Competitor
  if (isCompetitorUrl(hostname, competitorDomains)) {
    return 'competitor';
  }

  // Priority 3: Social
  if (isSocialMediaUrl(hostname)) {
    return 'social';
  }

  // Default: Earned (third-party)
  return 'earned';
}

/**
 * Parse semicolon-separated sources string into array of URLs
 */
function parseSources(sourcesString) {
  if (!sourcesString || typeof sourcesString !== 'string') return [];

  return sourcesString
    .split(';')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * Parse competitor names from business_competitors field
 */
function parseCompetitors(competitorsString) {
  if (!competitorsString || typeof competitorsString !== 'string') return [];

  return competitorsString
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Main refresh function
 */
async function refreshSources() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const siteUrlArg = args.find((arg) => arg.startsWith('--site-url='));

  if (!siteUrlArg) {
    console.error('❌ Error: --site-url parameter is required');
    console.error('   Usage: node scripts/refresh-brand-presence-sources.js --site-url=https://your-site.com');
    process.exit(1);
  }

  const siteBaseUrl = siteUrlArg.split('=')[1];
  const siteHostname = extractHostname(siteBaseUrl);

  if (!siteHostname) {
    console.error('❌ Error: Invalid site URL provided');
    process.exit(1);
  }

  console.log('🚀 Refreshing brand_presence_sources table...\n');
  console.log(`   Site URL: ${siteBaseUrl}`);
  console.log(`   Site hostname: ${siteHostname}\n`);

  const auroraClient = new AuroraClient({
    host: 'localhost',
    port: 5432,
    database: 'spacecatdb',
    user: 'spacecatuser',
    password: 'spacecatpassword',
    ssl: false,
  });

  try {
    console.log('🔌 Testing database connection...');
    const connected = await auroraClient.testConnection();
    if (!connected) {
      throw new Error('Failed to connect to database');
    }
    console.log('✅ Connected to database\n');

    // Clear existing data (full refresh)
    console.log('📝 Clearing existing sources data...');
    await auroraClient.query('TRUNCATE TABLE brand_presence_sources;');
    console.log('✅ Cleared\n');

    // Get total count
    const countResult = await auroraClient.query(`
      SELECT COUNT(*) as count FROM brand_presence WHERE sources IS NOT NULL AND sources != '';
    `);
    const totalRecords = parseInt(countResult[0].count, 10);
    console.log(`📊 Found ${totalRecords.toLocaleString()} records with sources to process\n`);

    if (totalRecords === 0) {
      console.log('ℹ️  No records to process');
      return;
    }

    // Process in batches
    let processed = 0;
    let sourcesInserted = 0;
    let offset = 0;
    const startTime = Date.now();

    const contentTypeCounts = {
      owned: 0,
      competitor: 0,
      social: 0,
      earned: 0,
    };

    console.log('📝 Processing sources...\n');

    while (offset < totalRecords) {
      // Fetch batch of records
      const records = await auroraClient.query(`
        SELECT id, site_id, date, model, sources, business_competitors
        FROM brand_presence
        WHERE sources IS NOT NULL AND sources != ''
        ORDER BY id
        LIMIT ${BATCH_SIZE} OFFSET ${offset};
      `);

      if (records.length === 0) break;

      // Collect all sources to insert from this batch of records
      const allSourcesToInsert = [];

      for (const record of records) {
        const urls = parseSources(record.sources);
        const competitors = parseCompetitors(record.business_competitors);

        for (const url of urls) {
          const normalizedUrl = normalizeUrl(url);
          const hostname = extractHostname(normalizedUrl);
          const contentType = determineContentType(normalizedUrl, siteHostname, competitors);

          contentTypeCounts[contentType]++;

          allSourcesToInsert.push({
            brand_presence_id: record.id,
            site_id: record.site_id,
            date: record.date,
            model: record.model,
            url: normalizedUrl,  // Store normalized URL
            hostname,
            content_type: contentType,
          });
          sourcesInserted++;
        }
      }

      // Insert in smaller batches to avoid parameter limits
      for (let i = 0; i < allSourcesToInsert.length; i += INSERT_BATCH_SIZE) {
        const batch = allSourcesToInsert.slice(i, i + INSERT_BATCH_SIZE);

        const insertValues = [];
        const insertParams = [];
        let paramIndex = 1;

        for (const source of batch) {
          insertValues.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6})`);
          insertParams.push(
            source.brand_presence_id,
            source.site_id,
            source.date,
            source.model,
            source.url,
            source.hostname,
            source.content_type,
          );
          paramIndex += 7;
        }

        if (insertValues.length > 0) {
          await auroraClient.query(`
            INSERT INTO brand_presence_sources
              (brand_presence_id, site_id, date, model, url, hostname, content_type)
            VALUES ${insertValues.join(', ')};
          `, insertParams);
        }
      }

      processed += records.length;
      offset += BATCH_SIZE;

      // Progress update
      const percent = Math.round((processed / totalRecords) * 100);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      process.stdout.write(`   Processed ${processed.toLocaleString()}/${totalRecords.toLocaleString()} records (${percent}%) - ${sourcesInserted.toLocaleString()} sources - ${elapsed}s\r`);
    }

    console.log('\n');

    // Summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('✅ Source Refresh Complete!');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log(`📊 Summary:`);
    console.log(`   Records processed: ${processed.toLocaleString()}`);
    console.log(`   Sources inserted: ${sourcesInserted.toLocaleString()}`);
    console.log(`   Duration: ${duration}s\n`);

    console.log(`📋 Content Type Distribution:`);
    console.log(`   Owned: ${contentTypeCounts.owned.toLocaleString()} (${((contentTypeCounts.owned / sourcesInserted) * 100).toFixed(1)}%)`);
    console.log(`   Competitor: ${contentTypeCounts.competitor.toLocaleString()} (${((contentTypeCounts.competitor / sourcesInserted) * 100).toFixed(1)}%)`);
    console.log(`   Social: ${contentTypeCounts.social.toLocaleString()} (${((contentTypeCounts.social / sourcesInserted) * 100).toFixed(1)}%)`);
    console.log(`   Earned: ${contentTypeCounts.earned.toLocaleString()} (${((contentTypeCounts.earned / sourcesInserted) * 100).toFixed(1)}%)\n`);

    // Verify
    const verifyCount = await auroraClient.query('SELECT COUNT(*) as count FROM brand_presence_sources;');
    console.log(`✅ Verified: ${verifyCount[0].count} sources in table\n`);

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await auroraClient.close();
  }
}

refreshSources();
