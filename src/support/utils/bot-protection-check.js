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

import { analyzeBotProtection, SPACECAT_BOT_USER_AGENT } from '@adobe/spacecat-shared-utils';

/**
 * Performs a lightweight bot protection check by fetching the homepage.
 * This is a minimal check used during onboarding to determine if audits should be skipped.
 * Uses the same detection logic as the content scraper but only checks the homepage.
 *
 * @param {string} baseUrl - Site base URL
 * @param {object} log - Logger
 * @returns {Promise<object>} Bot protection status
 */
export async function checkBotProtectionDuringOnboarding(baseUrl, log) {
  log.info(`Performing lightweight bot protection check for ${baseUrl}`);

  try {
    const response = await fetch(baseUrl, {
      method: 'GET',
      headers: {
        'User-Agent': SPACECAT_BOT_USER_AGENT,
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    const html = await response.text();

    const botProtection = analyzeBotProtection({
      status: response.status,
      headers: response.headers,
      html,
    });

    log.info(`Bot protection check complete for ${baseUrl}`, {
      crawlable: botProtection.crawlable,
      type: botProtection.type,
      confidence: botProtection.confidence,
    });

    return {
      blocked: !botProtection.crawlable,
      type: botProtection.type,
      confidence: botProtection.confidence,
      reason: botProtection.reason,
      details: {
        httpStatus: response.status,
        htmlSize: html.length,
      },
    };
  } catch (error) {
    log.error(`Bot protection check failed for ${baseUrl}:`, error);

    // Check if error suggests bot blocking (403, 401, etc.)
    const errorMessage = error.message || '';
    const isBotBlocking = errorMessage.includes('403')
      || errorMessage.includes('401')
      || errorMessage.includes('Forbidden')
      || error.status === 403
      || error.status === 401;

    if (isBotBlocking) {
      // Fetch failed with 403/401 - likely bot protection
      log.warn(`HTTP error suggests bot protection for ${baseUrl}`);
      return {
        blocked: true,
        type: 'http-error',
        confidence: 0.7,
        reason: `HTTP error suggests bot protection: ${errorMessage}`,
        details: {
          error: errorMessage,
        },
      };
    }

    // Other errors (timeout, DNS, network) - fail open
    // Better to try audits than block unnecessarily
    return {
      blocked: false,
      type: 'unknown',
      confidence: 0,
      error: errorMessage,
    };
  }
}
