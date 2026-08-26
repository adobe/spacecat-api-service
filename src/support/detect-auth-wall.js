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

/**
 * Authenticated-site (login / SSO wall) detection for PLG onboarding.
 *
 * ASO cannot audit login-gated sites: crawl-based audits (broken-backlinks, alt-text,
 * scrape) hit the auth wall and produce an incomplete optimizer experience. This probe
 * fetches the site's front door anonymously (following redirects) and classifies whether
 * that front door is a login/SSO page, so onboarding can route it to the manual-review
 * waitlist instead of provisioning it.
 *
 * The classifier is deliberately HIGH-PRECISION: a false positive waitlists a legitimate
 * public customer, which is worse than missing an edge case. We only flag on a strong
 * signal — an explicit 401, a front door that resolves to a login/SSO URL or IdP host, or
 * a landing page that is unambiguously a login form (password field + a login title/URL).
 * A public homepage with an incidental account/login widget is NOT flagged.
 */

const PROBE_TIMEOUT_MS = 15000;
const BODY_SCAN_LIMIT = 500000;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Path segment that is unmistakably a login / SSO endpoint. Anchored on a delimiter on both
// sides so `/authors`, `/login-tips`, etc. do not false-positive, while `/login`,
// `/sampoorna/login.html`, `/sign-in`, `/sso`, `/oauth`, `/saml` all match.
const LOGIN_URL_PATTERN = /(?:^|[/_.-])(?:log[-]?in|sign[-_]?in|sso|oauth|auth|authenticate|authentication|saml)(?:[/._?#=&-]|$)/i;

// Hostnames of well-known identity providers a site's front door commonly redirects to.
const IDP_HOST_PATTERNS = [
  /(?:^|\.)okta(?:preview)?\.com$/i,
  /(?:^|\.)auth0\.com$/i,
  /^login\.microsoftonline\.com$/i,
  /^login\.microsoft(?:online)?\.com$/i,
  /^login\.live\.com$/i,
  /^login\.windows\.net$/i,
  /^accounts\.google\.com$/i,
  /(?:^|\.)onelogin\.com$/i,
  /(?:^|\.)pingidentity\.com$/i,
  /(?:^|\.)adobelogin\.com$/i,
  /^auth\.services\.adobe\.com$/i,
  /^signin\.aws\.amazon\.com$/i,
  /(?:^|\.)cloudflareaccess\.com$/i,
];

const PASSWORD_INPUT_PATTERN = /<input[^>]*\btype\s*=\s*["']?password\b/i;
const LOGIN_TITLE_PATTERN = /<title[^>]*>[^<]*\b(?:log[\s-]?in|sign[\s-]?in|log[\s-]?on|authentication)\b/i;

function isLoginUrl(finalUrl) {
  try {
    return LOGIN_URL_PATTERN.test(new URL(finalUrl).pathname);
  } catch {
    /* c8 ignore next 2 */
    return false;
  }
}

function isIdpHost(finalUrl) {
  try {
    const { hostname } = new URL(finalUrl);
    return IDP_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    /* c8 ignore next 2 */
    return false;
  }
}

function isHtmlContentType(contentType) {
  return !contentType || /text\/html|application\/xhtml/i.test(contentType);
}

/**
 * Fetches the base URL anonymously (following redirects) and classifies whether its front
 * door is a login / SSO wall.
 *
 * @param {{ baseUrl: string, log?: object }} params
 * @param {{ fetch?: Function }} [deps] - injectable fetch for testing; defaults to global fetch.
 * @returns {Promise<{authenticated: boolean, signal: string|null, finalUrl: string|null,
 *   status: number|null}>}
 */
export async function detectAuthWall({ baseUrl, log }, { fetch = globalThis.fetch } = {}) {
  const notAuthenticated = (finalUrl = null, status = null) => ({
    authenticated: false, signal: null, finalUrl, status,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(baseUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    });

    const status = response.status ?? null;
    const finalUrl = response.url || baseUrl;

    if (status === 401) {
      return {
        authenticated: true, signal: 'status-401', finalUrl, status,
      };
    }
    if (isLoginUrl(finalUrl)) {
      return {
        authenticated: true, signal: 'login-url', finalUrl, status,
      };
    }
    if (isIdpHost(finalUrl)) {
      return {
        authenticated: true, signal: 'idp-host', finalUrl, status,
      };
    }

    const contentType = response.headers?.get?.('content-type');
    if (isHtmlContentType(contentType)) {
      const html = (await response.text()).slice(0, BODY_SCAN_LIMIT);
      const hasPasswordInput = PASSWORD_INPUT_PATTERN.test(html);
      const hasLoginTitle = LOGIN_TITLE_PATTERN.test(html);
      if (hasPasswordInput && hasLoginTitle) {
        return {
          authenticated: true, signal: 'login-form', finalUrl, status,
        };
      }
    }

    return notAuthenticated(finalUrl, status);
  } catch (error) {
    log?.warn?.(`Auth-wall probe failed for ${baseUrl}: ${error.message}`);
    return notAuthenticated();
  } finally {
    clearTimeout(timer);
  }
}
