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
 * Also makes additional requests to common endpoints to detect HTTP/2 blocking patterns.
 *
 * @param {string} baseUrl - Site base URL
 * @param {object} log - Logger
 * @returns {Promise<object>} Bot protection status
 */
export async function checkBotProtectionDuringOnboarding(baseUrl, log) {
  log.info(`Performing lightweight bot protection check for ${baseUrl}`);

  try {
    // Make multiple requests to detect HTTP/2 blocking patterns
    // Some sites allow the first request but block subsequent automated requests
    const requests = [
      { url: baseUrl, name: 'homepage' },
      { url: new URL('/robots.txt', baseUrl).toString(), name: 'robots.txt' },
      { url: new URL('/sitemap.xml', baseUrl).toString(), name: 'sitemap.xml' },
    ];

    const results = await Promise.allSettled(
      requests.map(async (req) => {
        try {
          const response = await fetch(req.url, {
            method: 'GET',
            headers: {
              'User-Agent': SPACECAT_BOT_USER_AGENT,
            },
            signal: AbortSignal.timeout(10000), // 10 second timeout
          });

          // Try to read response body
          const html = await response.text();

          return {
            name: req.name,
            url: req.url,
            success: true,
            response,
            html,
          };
        } catch (error) {
          // Check for HTTP/2 errors
          const errorCode = error?.code || '';
          const errorMessage = error?.message || '';
          const isHttp2Error = errorCode === 'NGHTTP2_INTERNAL_ERROR'
            || errorCode === 'ERR_HTTP2_STREAM_ERROR'
            || errorCode === 'ERR_HTTP2_STREAM_CANCEL'
            || errorMessage.includes('NGHTTP2_INTERNAL_ERROR')
            || errorMessage.includes('HTTP2_STREAM_ERROR');

          log.debug(`Fetch failed for ${req.name}: code=${errorCode}, message=${errorMessage}, isHttp2=${isHttp2Error}`);

          return {
            name: req.name,
            url: req.url,
            success: false,
            error,
            isHttp2Error,
          };
        }
      }),
    );

    // Check if any requests failed with HTTP/2 errors
    const http2Failures = results.filter(
      (r) => r.status === 'fulfilled' && r.value && r.value.success === false && r.value.isHttp2Error === true,
    );

    if (http2Failures.length > 0) {
      log.warn(`HTTP/2 errors detected for ${baseUrl} - likely bot protection`);
      const firstFailure = http2Failures[0].value;
      return {
        blocked: true,
        type: 'http2-block',
        confidence: 0.9,
        reason: `HTTP/2 connection error: ${firstFailure.error?.message || 'bot blocking detected'}`,
        details: {
          failedRequests: http2Failures.map((f) => ({
            name: f.value.name,
            url: f.value.url,
            error: f.value.error?.message,
            code: f.value.error?.code,
          })),
        },
      };
    }

    // Get the homepage response for content analysis
    const homepageResult = results[0];
    if (homepageResult.status === 'rejected' || !homepageResult.value?.success) {
      // Homepage fetch failed completely
      const error = homepageResult.reason || homepageResult.value?.error;

      // Check if this is an HTTP/2 error before throwing
      if (error) {
        const errorCode = error.code || '';
        const errorMessage = error.message || '';
        const isHttp2Error = errorCode === 'NGHTTP2_INTERNAL_ERROR'
          || errorCode === 'ERR_HTTP2_STREAM_ERROR'
          || errorCode === 'ERR_HTTP2_STREAM_CANCEL'
          || errorMessage.includes('NGHTTP2_INTERNAL_ERROR')
          || errorMessage.includes('HTTP2_STREAM_ERROR');

        /* c8 ignore start */
        // Defensive check - in practice, HTTP/2 errors are caught by the first filter
        // (lines 80-100). This serves as a safety net in case the error object structure changes.
        if (isHttp2Error) {
          log.warn(`HTTP/2 error detected on homepage for ${baseUrl} - likely bot protection`);
          return {
            blocked: true,
            type: 'http2-block',
            confidence: 0.9,
            reason: `HTTP/2 connection error: ${errorMessage}`,
            details: {
              error: errorMessage,
              code: errorCode,
            },
          };
        }
        /* c8 ignore stop */
      }

      throw error;
    }

    const { response, html } = homepageResult.value;

    // Analyze homepage content for bot protection patterns
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

    // Check for HTTP/2 errors in the caught error
    const errorCode = error.code || '';
    const errorMessage = error.message || '';
    const isHttp2Error = errorCode === 'NGHTTP2_INTERNAL_ERROR'
      || errorCode === 'ERR_HTTP2_STREAM_ERROR'
      || errorCode === 'ERR_HTTP2_STREAM_CANCEL'
      || errorMessage.includes('NGHTTP2_INTERNAL_ERROR')
      || errorMessage.includes('HTTP2_STREAM_ERROR');

    if (isHttp2Error) {
      log.warn(`HTTP/2 error detected for ${baseUrl} - likely bot protection`);
      return {
        blocked: true,
        type: 'http2-block',
        confidence: 0.9,
        reason: `HTTP/2 connection error: ${errorMessage}`,
        details: {
          error: errorMessage,
          code: errorCode,
        },
      };
    }

    // Check if error suggests bot blocking (403, 401, etc.)
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
