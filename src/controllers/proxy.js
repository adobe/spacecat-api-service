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
/* c8 ignore start */
import {
  badRequest,
  createResponse,
  internalServerError,
  notFound,
} from '@adobe/spacecat-shared-http-utils';
import { hasText, tracingFetch as fetch } from '@adobe/spacecat-shared-utils';
import { getImsUserToken } from '../support/utils.js';

/**
 * Decodes a base64-encoded URL.
 * @param {string} base64Url - The base64-encoded URL.
 * @returns {string} The decoded URL.
 * @throws {Error} If the URL cannot be decoded.
 */
function decodeBase64Url(base64Url) {
  try {
    return Buffer.from(base64Url, 'base64').toString('utf-8');
  } catch (error) {
    throw new Error(`Failed to decode base64 URL: ${error.message}`);
  }
}

/**
 * Encodes a URL to base64.
 * @param {string} url - The URL to encode.
 * @returns {string} The base64-encoded URL.
 */
function encodeUrlToBase64(url) {
  return Buffer.from(url, 'utf-8').toString('base64');
}

/**
 * Fetches HTML content from the target URL using the IMS bearer token.
 * @param {string} targetUrl - The URL to fetch.
 * @param {string} bearerToken - The IMS bearer token for authentication.
 * @param {object} log - The logger instance.
 * @returns {Promise<{html: string, contentType: string}>} The HTML content and content type.
 * @throws {Error} If the fetch fails.
 */
async function fetchHtmlContent(targetUrl, bearerToken, log) {
  try {
    log.info(`Fetching content from: ${targetUrl}`);
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || 'text/html';
    const html = await response.text();

    log.info(`Successfully fetched ${html.length} bytes from ${targetUrl}`);
    return { html, contentType };
  } catch (error) {
    log.error(`Failed to fetch content from ${targetUrl}:`, error);
    throw error;
  }
}

/**
 * Resolves a potentially relative URL to an absolute URL.
 * @param {string} url - The URL to resolve.
 * @param {string} base - The base URL.
 * @returns {string|null} The absolute URL, or null if invalid.
 */
function resolveUrl(url, base) {
  try {
    // If URL is already absolute, return it
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    // If URL starts with //, it's protocol-relative
    if (url.startsWith('//')) {
      return `https:${url}`;
    }
    // If URL starts with /, it's relative to origin
    if (url.startsWith('/')) {
      return `${base}${url}`;
    }
    // Otherwise, try to resolve it as a relative URL
    return new URL(url, base).href;
  } catch (error) {
    return null;
  }
}

/**
 * Determines if a URL should be proxied.
 * @param {string} url - The URL to check.
 * @param {string} origin - The origin of the page being proxied.
 * @returns {boolean} True if the URL should be proxied.
 */
function shouldProxyUrl(url, origin) {
  try {
    const urlObj = new URL(url);
    // Only proxy URLs from the same origin
    return urlObj.origin === origin;
  } catch (error) {
    return false;
  }
}

/**
 * Rewrites image URLs in the HTML to proxy them through the SpaceCat API.
 * @param {string} html - The HTML content.
 * @param {string} baseUrl - The base URL of the original page.
 * @param {string} siteId - The site ID for the proxy route.
 * @param {object} log - The logger instance.
 * @returns {string} The HTML with rewritten image URLs.
 */
function rewriteImageUrls(html, baseUrl, siteId, log) {
  try {
    const urlObj = new URL(baseUrl);
    const { origin } = urlObj;
    log.info(`Rewriting image URLs with base: ${origin},for siteId: ${siteId}`);

    // Pattern to match img src attributes
    // Matches: <img src="..." or <img ... src="..."
    let rewrittenHtml = html;
    let rewriteCount = 0;

    // Rewrite img src attributes
    rewrittenHtml = rewrittenHtml.replace(
      /<img([^>]*?)src=["']([^"']+)["']/gi,
      (match, beforeSrc, srcUrl) => {
        const absoluteUrl = resolveUrl(srcUrl, origin);
        if (absoluteUrl && shouldProxyUrl(absoluteUrl, origin)) {
          const base64Url = encodeUrlToBase64(absoluteUrl);
          const proxyUrl = `/sites/${siteId}/csproxy/${base64Url}`;
          rewriteCount += 1;
          return `<img${beforeSrc}src="${proxyUrl}"`;
        }
        return match;
      },
    );

    // Rewrite CSS background-image URLs
    rewrittenHtml = rewrittenHtml.replace(
      /background-image:\s*url\(["']?([^"')]+)["']?\)/gi,
      (match, bgUrl) => {
        const absoluteUrl = resolveUrl(bgUrl, origin);
        if (absoluteUrl && shouldProxyUrl(absoluteUrl, origin)) {
          const base64Url = encodeUrlToBase64(absoluteUrl);
          const proxyUrl = `/sites/${siteId}/csproxy/${base64Url}`;
          rewriteCount += 1;
          return `background-image: url("${proxyUrl}")`;
        }
        return match;
      },
    );

    // Rewrite picture source srcset attributes
    rewrittenHtml = rewrittenHtml.replace(
      /<source([^>]*?)srcset=["']([^"']+)["']/gi,
      (match, beforeSrcset, srcsetValue) => {
        const rewrittenSrcset = srcsetValue.split(',').map((srcsetItem) => {
          const [url, descriptor] = srcsetItem.trim().split(/\s+/);
          const absoluteUrl = resolveUrl(url, origin);
          if (absoluteUrl && shouldProxyUrl(absoluteUrl, origin)) {
            const base64Url = encodeUrlToBase64(absoluteUrl);
            const proxyUrl = `/sites/${siteId}/csproxy/${base64Url}`;
            rewriteCount += 1;
            return descriptor ? `${proxyUrl} ${descriptor}` : proxyUrl;
          }
          return srcsetItem.trim();
        }).join(', ');
        return `<source${beforeSrcset}srcset="${rewrittenSrcset}"`;
      },
    );

    // Rewrite img srcset attributes
    rewrittenHtml = rewrittenHtml.replace(
      /<img([^>]*?)srcset=["']([^"']+)["']/gi,
      (match, beforeSrcset, srcsetValue) => {
        const rewrittenSrcset = srcsetValue.split(',').map((srcsetItem) => {
          const [url, descriptor] = srcsetItem.trim().split(/\s+/);
          const absoluteUrl = resolveUrl(url, origin);
          if (absoluteUrl && shouldProxyUrl(absoluteUrl, origin)) {
            const base64Url = encodeUrlToBase64(absoluteUrl);
            const proxyUrl = `/sites/${siteId}/csproxy/${base64Url}`;
            rewriteCount += 1;
            return descriptor ? `${proxyUrl} ${descriptor}` : proxyUrl;
          }
          return srcsetItem.trim();
        }).join(', ');
        return `<img${beforeSrcset}srcset="${rewrittenSrcset}"`;
      },
    );

    log.info(`Rewrote ${rewriteCount} image URLs`);
    return rewrittenHtml;
  } catch (error) {
    log.error('Failed to rewrite image URLs:', error);
    return html; // Return original HTML if rewrite fails
  }
}

/**
 * Proxy controller. Provides a method to proxy content from authenticated AEM instances.
 * @param {object} ctx - Context of the request.
 * @param {object} log - Logger instance.
 * @returns {object} Proxy controller.
 */
function ProxyController(ctx, log) {
  /**
   * Proxies content from the base64-encoded URL.
   * GET /sites/:siteId/csproxy/:base64ProxyUrl
   * @param {object} context - The request context.
   * @returns {Promise<object>} The response with proxied content.
   */
  async function proxyContent(context) {
    const base64ProxyUrl = context.params?.base64ProxyUrl;
    const siteId = context.params?.siteId;

    // Validate siteId
    if (!hasText(siteId)) {
      return badRequest('Site ID is required');
    }

    // Validate base64ProxyUrl
    if (!hasText(base64ProxyUrl)) {
      return badRequest('Proxy URL is required');
    }

    try {
      // Decode the base64 URL
      const targetUrl = decodeBase64Url(base64ProxyUrl);
      log.info(`Proxy request for siteId: ${siteId}, targetUrl: ${targetUrl}`);

      // Validate decoded URL
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        return badRequest('Invalid URL format');
      }

      // Get IMS bearer token from request headers
      let bearerToken;
      try {
        bearerToken = getImsUserToken(context);
      } catch (error) {
        log.error('Failed to get IMS token:', error);
        return badRequest('Missing or invalid Authorization header');
      }

      // Fetch content from target URL
      const { html, contentType } = await fetchHtmlContent(targetUrl, bearerToken, log);

      // Check if content is HTML (should rewrite URLs)
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');

      if (isHtml) {
        // Rewrite image URLs in HTML
        // Note: CSS/JS URLs are NOT rewritten - they load directly from AEM CS
        const rewrittenHtml = rewriteImageUrls(html, targetUrl, siteId, log);

        return createResponse(rewrittenHtml, 200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'X-Proxy-Source': targetUrl,
        });
      }

      // For non-HTML content (images, etc.), return as-is
      return createResponse(html, 200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        'X-Proxy-Source': targetUrl,
      });
    } catch (error) {
      log.error('Proxy request failed:', error);

      if (error.message.includes('decode')) {
        return badRequest(`Invalid base64 URL: ${error.message}`);
      }

      if (error.message.includes('HTTP 404')) {
        return notFound('Resource not found at target URL');
      }

      if (error.message.includes('HTTP 401') || error.message.includes('HTTP 403')) {
        return createResponse('Unauthorized or forbidden', 403, {
          'Content-Type': 'text/plain',
        });
      }

      return internalServerError(`Failed to proxy content: ${error.message}`);
    }
  }

  return {
    proxyContent,
  };
}

export default ProxyController;
/* c8 ignore end */
