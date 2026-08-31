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

import PlgOnboardingModel from '@adobe/spacecat-shared-data-access/src/models/plg-onboarding/plg-onboarding.model.js';

// isSafeDomain lives in src/support/ (shared SSRF guard) so lower-level probes can reuse it
// without importing up into a controller. Re-exported here for onboarding callers that already
// import it from this module.
export { isSafeDomain } from '../../../support/url-safety.js';

// EDS host pattern: ref--repo--owner.aem.live (or hlx.live)
export const EDS_HOST_PATTERN = /^([\w-]+)--([\w-]+)--([\w-]+)\.(aem\.live|hlx\.live)$/i;

// AEM CS publish host pattern: publish-p{programId}-e{environmentId}.adobeaemcloud.com
export const AEM_CS_PUBLISH_HOST_PATTERN = /^publish-p(\d+)-e(\d+)\.adobeaemcloud\.(com|net)$/i;

// AEM CS author URL pattern: https://author-p{programId}-e{environmentId}[-suffix].adobeaemcloud.com
export const AEM_CS_AUTHOR_URL_PATTERN = /^https?:\/\/author-p(\d+)-e(\d+)(?:-[^.]+)?\.adobeaemcloud\.(?:com|net)/i;

// Strip http:// or https:// scheme so callers can pass either scheme-prefixed input or a bare
// hostname/path. Only the scheme is removed — port, userinfo, query, and fragment are NOT
// stripped and will be rejected by the domain validator downstream.
const stripScheme = (s) => s.replace(/^https?:\/\//i, '');

/**
 * Prepare a raw user-supplied domain for validation and persistence: strip scheme, then
 * lowercase via PlgOnboarding.normalizeDomain so callers can pass mixed-case input.
 * The shared schema requires lowercase, so callers must normalize before validating
 * or saving — otherwise the data-access layer would reject the write.
 * @param {string} raw - The raw user-supplied domain.
 * @returns {string} normalized domain.
 */
export const prepareDomain = (raw) => PlgOnboardingModel.normalizeDomain(stripScheme(raw));

/**
 * Delegates to the shared PlgOnboarding.isValidDomain validator so this service, the
 * data-access schema (plg-onboarding.schema.js), and any future consumer share a single
 * implementation. Do NOT import DOMAIN_PATTERN directly — it is incomplete on its own
 * (no length cap, no all-numeric/short-form-IP rejection, no control-char check).
 * @param {string} domain - The domain to validate.
 * @returns {boolean} true if valid, false otherwise.
 */
export const isValidDomain = (domain) => PlgOnboardingModel.isValidDomain(domain);
