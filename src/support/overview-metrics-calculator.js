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
  SPACECAT_USER_AGENT,
  tracingFetch as fetch,
} from '@adobe/spacecat-shared-utils';

import { LLMO_SHEETDATA_SOURCE_URL } from '../controllers/llmo/llmo-utils.js';

/**
 * Parse semicolon-separated URLs from sources field
 * @param {string} sources - Semicolon-separated URL string
 * @returns {string[]} Array of trimmed URLs
 */
const parseSourcesUrls = (sources) => {
  if (!sources || typeof sources !== 'string') return [];

  return sources
    .split(';')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
};

/**
 * Check if a URL belongs to a site's owned domain
 * @param {string} url - The URL to check
 * @param {string} normalizedSiteHostname - Pre-normalized site hostname (lowercase, no www.)
 * @returns {boolean} True if URL is owned by the site
 */
const isOwnedUrl = (url, normalizedSiteHostname) => {
  try {
    const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
    const urlHostname = urlObj.hostname.replace(/^www\./, '').toLowerCase();

    // Check if URL hostname matches or is a subdomain of site hostname
    return urlHostname === normalizedSiteHostname || urlHostname.endsWith(`.${normalizedSiteHostname}`);
  } catch {
    return false;
  }
};

/**
 * Calculate average visibility score from records.
 * Groups records by unique prompt (prompt + region + topic) and averages the visibility scores
 * per unique prompt, then averages across all unique prompts.
 *
 * @param {Array<Object>} records - Array of brand presence records
 * @returns {number} Average visibility score (0-100, rounded to whole number)
 */
export const calculateVisibilityScore = (records) => {
  if (!records || records.length === 0) {
    return 0;
  }

  // Group records by unique prompt key (same format as mentions/citations)
  const uniquePromptScores = new Map();

  records.forEach((record) => {
    // Try different possible field names for visibility score
    const visibilityScore = record['Visibility Score'] ?? record.visibility_score ?? record.visibilityScore;

    if (visibilityScore !== undefined && visibilityScore !== null && visibilityScore !== '') {
      const numericScore = Number(visibilityScore);

      if (!Number.isNaN(numericScore)) {
        // Create unique prompt key: prompt|Region|Topics (same format as mentions/citations)
        const prompt = record.Prompt || 'Unknown';
        const region = record.Region || 'Unknown';
        const topics = record.Topics || 'Unknown';
        const uniqueKey = `${prompt}|${region}|${topics}`;

        // Collect all visibility scores for this unique prompt
        if (!uniquePromptScores.has(uniqueKey)) {
          uniquePromptScores.set(uniqueKey, []);
        }
        uniquePromptScores.get(uniqueKey).push(numericScore);
      }
    }
  });

  if (uniquePromptScores.size === 0) {
    return 0;
  }

  // Calculate average visibility score per unique prompt
  const averageScoresPerPrompt = [];
  uniquePromptScores.forEach((scores) => {
    // If a prompt appears multiple times, average its scores first
    const promptAverage = scores.reduce((acc, score) => acc + score, 0) / scores.length;
    averageScoresPerPrompt.push(promptAverage);
  });

  // Average across all unique prompts
  const sum = averageScoresPerPrompt.reduce((acc, score) => acc + score, 0);
  return Math.round(sum / averageScoresPerPrompt.length); // Round to whole number
};

/**
 * Calculate mentions and citations counts from records.
 * Counts unique prompts (prompt + region + topic) that have mentions or citations.
 *
 * @param {Array<Object>} records - Array of brand presence records
 * @param {string} [siteBaseUrl] - Site's base URL for citation ownership check
 * @returns {{ mentionsCount: number, citationsCount: number }}
 */
export const calculateMentionsAndCitations = (records, siteBaseUrl) => {
  const mentionsSet = new Set();
  const citationsSet = new Set();

  if (!records || records.length === 0) {
    return { mentionsCount: 0, citationsCount: 0 };
  }

  // Parse site hostname ONCE for all URL checks
  let normalizedSiteHostname = null;
  if (siteBaseUrl) {
    try {
      const siteObj = new URL(siteBaseUrl);
      normalizedSiteHostname = siteObj.hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      // Invalid site URL, skip citation checks
    }
  }

  // Cache for ownership checks and parsed URLs
  const ownershipCache = new Map();
  const parsedUrlsCache = new Map();

  for (const record of records) {
    const promptKey = `${record.Prompt}|${record.Region || 'Unknown'}|${record.Topics || 'Unknown'}`;

    // Check for mentions
    const mentionsColumn = record.Mentions;
    if (mentionsColumn === 'true' || mentionsColumn === true) {
      mentionsSet.add(promptKey);
    }

    // Check for citations (only if we have a base URL)
    if (normalizedSiteHostname) {
      const sources = record.Sources || '';
      if (sources && sources !== '') {
        // Check cache for parsed URLs
        let urls;
        if (parsedUrlsCache.has(sources)) {
          urls = parsedUrlsCache.get(sources);
        } else {
          urls = parseSourcesUrls(sources);
          urls = [...new Set(urls)]; // Deduplicate
          parsedUrlsCache.set(sources, urls);
        }

        if (urls.length > 0) {
          let hasOwnedSource = false;

          for (const url of urls) {
            // Create site-aware cache key
            const cacheKey = `${siteBaseUrl}|${url}`;
            let isOwned;
            if (ownershipCache.has(cacheKey)) {
              isOwned = ownershipCache.get(cacheKey);
            } else {
              // Use fast ownership check with pre-parsed hostname
              isOwned = isOwnedUrl(url, normalizedSiteHostname);
              ownershipCache.set(cacheKey, isOwned);
            }

            if (isOwned) {
              hasOwnedSource = true;
              break; // SHORT CIRCUIT - stop checking remaining URLs
            }
          }

          if (hasOwnedSource) {
            citationsSet.add(promptKey);
          }
        }
      }
    }
  }

  return {
    mentionsCount: mentionsSet.size,
    citationsCount: citationsSet.size,
  };
};

/**
 * Calculate percentage delta between current and previous values.
 *
 * @param {number} current - Current value
 * @param {number} previous - Previous value
 * @returns {string} Formatted delta string (e.g., "+5%", "-3%", "0%")
 */
export const calculateDelta = (current, previous) => {
  if (previous === 0) {
    if (current === 0) return '0%';
    return '+100%'; // From 0 to something is considered 100% increase
  }

  const delta = ((current - previous) / previous) * 100;
  const rounded = Math.round(delta);

  if (rounded > 0) return `+${rounded}%`;
  if (rounded < 0) return `${rounded}%`;
  return '0%';
};

/**
 * Get the current ISO week number and year.
 *
 * @param {Date} [date=new Date()] - Date to get week for
 * @returns {{ week: number, year: number }}
 */
export const getCurrentWeek = (date = new Date()) => {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Set to nearest Thursday: current date + 4 - current day number
  // (Monday is 1, Sunday is 7)
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  // Get first day of year
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  // Calculate full weeks to nearest Thursday
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);

  return {
    week: weekNo,
    year: d.getUTCFullYear(),
  };
};

/**
 * Format week identifier as "Jan 13-19, 2026" style string.
 *
 * @param {number} week - ISO week number
 * @param {number} year - Year
 * @returns {string} Formatted date range
 */
export const formatWeekRange = (week, year) => {
  // Get the Monday of the given ISO week
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (week - 1) * 7);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const startMonth = months[monday.getUTCMonth()];
  const endMonth = months[sunday.getUTCMonth()];
  const startDay = monday.getUTCDate();
  const endDay = sunday.getUTCDate();
  const endYear = sunday.getUTCFullYear();

  // If same month, format as "Jan 13-19, 2026"
  // If different months, format as "Jan 27 - Feb 2, 2026"
  if (startMonth === endMonth) {
    return `${startMonth} ${startDay}-${endDay}, ${endYear}`;
  }
  return `${startMonth} ${startDay} - ${endMonth} ${endDay}, ${endYear}`;
};

/**
 * Extract week and year from a brandpresence-all filename.
 * Supports both weekly and daily formats:
 * - Weekly: brandpresence-all-w45-2025.json
 * - Daily: brandpresence-all-w44-2025-281025.json
 *
 * @param {string} filename - The filename to parse
 * @returns {{ week: number, year: number } | null} Week info or null if invalid
 */
export const parseWeekFromFilename = (filename) => {
  // Match patterns like: brandpresence-all-w45-2025.json or brandpresence-all-w44-2025-281025.json
  const match = filename.match(/brandpresence-all-w(\d+)-(\d{4})(?:-\d+)?\.json$/);
  if (match) {
    return {
      week: parseInt(match[1], 10),
      year: parseInt(match[2], 10),
    };
  }
  return null;
};

/**
 * Check if a path is a valid brandpresence-all file (not in config_absent folder).
 *
 * @param {string} path - The file path to check
 * @returns {boolean} True if this is a valid brandpresence-all file
 */
export const isValidBrandPresenceAllFile = (path) => {
  // Exclude paths containing /config_absent/
  if (path.includes('/config_absent/')) {
    return false;
  }
  // Check if filename matches brandpresence-all pattern
  const filename = path.split('/').pop();
  return /^brandpresence-all-w\d+-\d{4}(?:-\d+)?\.json$/.test(filename);
};

/**
 * Fetch the query index to discover available brand presence files.
 *
 * @param {Object} options - Options
 * @param {string} options.dataFolder - LLMO data folder path
 * @param {string} options.hlxApiKey - Helix API key
 * @param {Object} options.log - Logger instance
 * @returns {Promise<Array<{path: string, lastModified: string}>>} Array of file entries
 */
export const fetchQueryIndex = async ({
  dataFolder,
  hlxApiKey,
  log,
}) => {
  const url = new URL(`${LLMO_SHEETDATA_SOURCE_URL}/${dataFolder}/query-index.json`);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `token ${hlxApiKey || 'hlx_api_key_missing'}`,
        'User-Agent': SPACECAT_USER_AGENT,
        'Accept-Encoding': 'br',
      },
    });

    /* c8 ignore start - fetch paths require mocking native fetch */
    if (!response.ok) {
      if (response.status === 404) {
        log.info(`No query index found for ${dataFolder}`);
        return [];
      }
      log.error(`Failed to fetch query index: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json();

    if (!data.data || !Array.isArray(data.data)) {
      log.warn(`Query index has unexpected format for ${dataFolder}`);
      return [];
    }

    log.info(`Fetched query index with ${data.data.length} entries for ${dataFolder}`);
    return data.data;
  } catch (error) {
    log.error(`Error fetching query index for ${dataFolder}: ${error.message}`);
    return [];
  }
  /* c8 ignore stop */
};

/**
 * Get the two most recent brandpresence-all files from the query index.
 *
 * @param {Array<{path: string, lastModified: string}>} queryIndexData - Query index entries
 * @returns {Array<{path: string, lastModified: string}>} Two most recent valid files
 */
export const getTwoMostRecentBrandPresenceFiles = (queryIndexData) => {
  if (!queryIndexData || !Array.isArray(queryIndexData)) {
    return [];
  }

  // Filter to only valid brandpresence-all files (exclude config_absent)
  const validFiles = queryIndexData.filter((entry) => isValidBrandPresenceAllFile(entry.path));

  // Sort by lastModified descending (most recent first)
  validFiles.sort((a, b) => {
    const aTime = parseInt(a.lastModified, 10) || 0;
    const bTime = parseInt(b.lastModified, 10) || 0;
    return bTime - aTime;
  });

  // Return the two most recent
  return validFiles.slice(0, 2);
};

/**
 * Fetch brand presence data from a specific file path.
 *
 * @param {Object} options - Options
 * @param {string} options.filePath - Full path to the file (from query index)
 * @param {string} options.hlxApiKey - Helix API key
 * @param {Object} options.log - Logger instance
 * @returns {Promise<Array<Object>>} Array of brand presence records
 */
export const fetchBrandPresenceDataFromPath = async ({
  filePath,
  hlxApiKey,
  log,
}) => {
  const url = new URL(`${LLMO_SHEETDATA_SOURCE_URL}${filePath}`);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `token ${hlxApiKey || 'hlx_api_key_missing'}`,
        'User-Agent': SPACECAT_USER_AGENT,
        'Accept-Encoding': 'br',
      },
    });

    /* c8 ignore start - fetch paths require mocking native fetch */
    if (!response.ok) {
      if (response.status === 404) {
        log.info(`No brand presence data found at ${filePath}`);
        return [];
      }
      log.error(`Failed to fetch brand presence data: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json();

    // Extract records from the response
    // The response can be a single sheet or multi-sheet format
    let records = [];

    if (data[':type'] === 'sheet' && data.data) {
      records = Array.isArray(data.data) ? data.data : [];
    } else if (data[':type'] === 'multi-sheet') {
      // Look for the 'all' or 'brand_all' sheet
      Object.keys(data).forEach((key) => {
        if ((key === 'all' || key.includes('brand_all')) && data[key]?.data) {
          const sheetRecords = Array.isArray(data[key].data) ? data[key].data : [];
          records.push(...sheetRecords);
        }
      });
    } else if (Array.isArray(data.data)) {
      // Direct data array format
      records = data.data;
    }

    log.info(`Fetched ${records.length} brand presence records from ${filePath}`);
    return records;
  } catch (error) {
    log.error(`Error fetching brand presence data from ${filePath}: ${error.message}`);
    return [];
  }
  /* c8 ignore stop */
};

/**
 * Calculate overview metrics for a site.
 * Fetches the query index to discover the two most recent brandpresence-all files,
 * then calculates:
 * - Visibility score with delta
 * - Mentions count with delta
 * - Citations count with delta
 *
 * @param {Object} options - Options
 * @param {Object} options.site - Site entity
 * @param {string} options.hlxApiKey - Helix API key
 * @param {Object} options.log - Logger instance
 * @returns {Promise<Object>} Overview metrics
 */
export const calculateOverviewMetrics = async ({ site, hlxApiKey, log }) => {
  const config = site.getConfig();
  const llmoConfig = config?.llmo || config?.getLlmoConfig?.();

  if (!llmoConfig?.dataFolder) {
    throw new Error('Site does not have LLMO configured');
  }

  const { dataFolder } = llmoConfig;
  const siteBaseUrl = site.getBaseURL();

  // Fetch the query index to discover available files
  const queryIndexData = await fetchQueryIndex({
    dataFolder,
    hlxApiKey,
    log,
  });

  // Get the two most recent brandpresence-all files
  const recentFiles = getTwoMostRecentBrandPresenceFiles(queryIndexData);

  if (recentFiles.length === 0) {
    log.info(`No brand presence data files found for site ${site.getId()}`);
    return {
      dateRange: '',
      week: null,
      visibilityScore: 0,
      visibilityDelta: '0%',
      mentionsCount: 0,
      mentionsDelta: '0%',
      citationsCount: 0,
      citationsDelta: '0%',
      hasData: false,
    };
  }

  const currentFile = recentFiles[0];
  const previousFile = recentFiles[1] || null;

  log.info(`Calculating metrics for site ${site.getId()}: current file ${currentFile.path}${previousFile ? `, previous file ${previousFile.path}` : ' (no previous file)'}`);

  // Fetch data for both files (current is required, previous is optional)
  const fetchPromises = [
    fetchBrandPresenceDataFromPath({
      filePath: currentFile.path,
      hlxApiKey,
      log,
    }),
  ];

  if (previousFile) {
    fetchPromises.push(
      fetchBrandPresenceDataFromPath({
        filePath: previousFile.path,
        hlxApiKey,
        log,
      }),
    );
  }

  const [currentRecords, previousRecords = []] = await Promise.all(fetchPromises);

  // Calculate metrics for current period
  const currentVisibilityScore = calculateVisibilityScore(currentRecords);
  const currentMetrics = calculateMentionsAndCitations(currentRecords, siteBaseUrl);
  const { mentionsCount: currentMentions, citationsCount: currentCitations } = currentMetrics;

  // Calculate metrics for previous period
  const previousVisibilityScore = calculateVisibilityScore(previousRecords);
  const previousMetrics = calculateMentionsAndCitations(previousRecords, siteBaseUrl);
  const { mentionsCount: previousMentions, citationsCount: previousCitations } = previousMetrics;

  // Calculate deltas
  const visibilityDelta = calculateDelta(currentVisibilityScore, previousVisibilityScore);
  const mentionsDelta = calculateDelta(currentMentions, previousMentions);
  const citationsDelta = calculateDelta(currentCitations, previousCitations);

  // Extract week info from the current file's filename for date range formatting
  const currentFilename = currentFile.path.split('/').pop();
  const weekInfo = parseWeekFromFilename(currentFilename);
  const dateRange = weekInfo ? formatWeekRange(weekInfo.week, weekInfo.year) : '';

  return {
    dateRange,
    week: weekInfo,
    visibilityScore: currentVisibilityScore,
    visibilityDelta,
    mentionsCount: currentMentions,
    mentionsDelta,
    citationsCount: currentCitations,
    citationsDelta,
    hasData: currentRecords.length > 0,
  };
};
