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

import esmock from 'esmock';
import { ASO_PRODUCT_CODE, PLG_MODEL_DOMAIN_HELPERS } from './shared-fixtures.js';

/**
 * Builds the standard esmock for plg-onboarding.js.
 * Use this in every PLG onboarding test file so the wiring stays in one place.
 * @param {object} stubs - the stub bag returned by createSharedMocks()
 * @param {object} acl   - access-control flags: { hasAdminAccess, hasAdminReadAccess }
 * @param {Function} [postSlackMessageStub] - optional stub to wire into slack/base.js
 */
export async function createPlgEsmock(stubs, {
  hasAdminAccess = false,
  hasAdminReadAccess = false,
  postSlackMessageStub,
} = {}) {
  const {
    composeBaseURLStub,
    detectBotBlockerStub,
    detectLocaleStub,
    resolveCanonicalUrlStub,
    rumApiClientCreateFromStub,
    ldCreateFromStub,
    tierClientCreateForSiteStub,
    tierClientCreateForOrgStub,
    configToDynamoItemStub,
    createOrFindOrganizationStub,
    enableAuditsStub,
    enableImportsStub,
    triggerAuditsStub,
    autoResolveAuthorUrlStub,
    resolveWwwUrlStub,
    updateCodeConfigStub,
    findDeliveryTypeStub,
    deriveProjectNameStub,
    queueDeliveryConfigWriterStub,
    loadProfileConfigStub,
    triggerBrandProfileAgentStub,
    updateRumConfigStub,
  } = stubs;

  return (await esmock(
    '../../../../src/controllers/plg/plg-onboarding.js',
    {
      '@adobe/spacecat-shared-utils': {
        composeBaseURL: composeBaseURLStub,
        detectBotBlocker: detectBotBlockerStub,
        detectLocale: detectLocaleStub,
        hasText: (val) => typeof val === 'string' && val.trim().length > 0,
        isValidIMSOrgId: (val) => typeof val === 'string' && val.endsWith('@AdobeOrg'),
        resolveCanonicalUrl: resolveCanonicalUrlStub,
      },
      // Keep onboarding tests hermetic: delegate the multi-client probe to the
      // injected @adobe/fetch stub (detectBotBlockerFn) instead of making a real
      // undici network call. The multi-client aggregation is unit-tested separately.
      '../../../../src/support/bot-blocker-multi-client.js': {
        detectBotBlockerMultiClient: async ({ baseUrl, headers }, opts = {}) => {
          const fn = opts.detectBotBlockerFn || detectBotBlockerStub;
          return fn({ baseUrl, headers });
        },
      },
      '@adobe/spacecat-shared-http-utils': {
        badRequest: (msg) => ({ status: 400, value: msg }),
        created: (data) => ({ status: 201, value: data }),
        createResponse: (body, status) => ({ status, value: body }),
        forbidden: (msg) => ({ status: 403, value: msg }),
        internalServerError: (msg) => ({ status: 500, value: msg }),
        noContent: () => ({ status: 204 }),
        notFound: (msg) => ({ status: 404, value: msg }),
        ok: (data) => ({ status: 200, value: data }),
      },
      '@adobe/spacecat-shared-rum-api-client': {
        default: {
          createFrom: rumApiClientCreateFromStub,
        },
      },
      '@adobe/spacecat-shared-launchdarkly-client': { default: ldCreateFromStub },
      '@adobe/spacecat-shared-tier-client': {
        default: {
          createForSite: tierClientCreateForSiteStub,
          createForOrg: tierClientCreateForOrgStub,
        },
      },
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: { toDynamoItem: configToDynamoItemStub },
      },
      '@adobe/spacecat-shared-data-access/src/models/entitlement/index.js': {
        Entitlement: {
          PRODUCT_CODES: { ASO: ASO_PRODUCT_CODE },
          TIERS: {
            FREE_TRIAL: 'FREE_TRIAL', PAID: 'PAID', PLG: 'PLG', PRE_ONBOARD: 'PRE_ONBOARD',
          },
        },
      },
      '@adobe/spacecat-shared-data-access/src/models/plg-onboarding/plg-onboarding.model.js': {
        default: {
          ...PLG_MODEL_DOMAIN_HELPERS,
          STATUSES: {
            IN_PROGRESS: 'IN_PROGRESS',
            ONBOARDED: 'ONBOARDED',
            PRE_ONBOARDING: 'PRE_ONBOARDING',
            ERROR: 'ERROR',
            WAITING_FOR_IP_ALLOWLISTING: 'WAITING_FOR_IP_ALLOWLISTING',
            WAITLISTED: 'WAITLISTED',
            INACTIVE: 'INACTIVE',
            REJECTED: 'REJECTED',
            OUTDATED: 'OUTDATED',
          },
          REVIEW_REASONS: {
            DOMAIN_ALREADY_ONBOARDED_IN_ORG: 'DOMAIN_ALREADY_ONBOARDED_IN_ORG',
            AEM_SITE_CHECK: 'AEM_SITE_CHECK',
            DOMAIN_ALREADY_ASSIGNED: 'DOMAIN_ALREADY_ASSIGNED',
            BOT_BLOCKER: 'BOT_BLOCKER',
          },
          REVIEW_DECISIONS: {
            BYPASSED: 'BYPASSED',
            UPHELD: 'UPHELD',
            CLOSED: 'CLOSED',
            REOPENED: 'REOPENED',
            OFFBOARDED: 'OFFBOARDED',
            PENDING: 'PENDING',
          },
        },
      },
      '../../../../src/controllers/llmo/llmo-onboarding.js': {
        createOrFindOrganization: createOrFindOrganizationStub,
        enableAudits: enableAuditsStub,
        enableImports: enableImportsStub,
        triggerAudits: triggerAuditsStub,
      },
      '../../../../src/support/utils.js': {
        autoResolveAuthorUrl: autoResolveAuthorUrlStub,
        resolveWwwUrl: resolveWwwUrlStub,
        updateCodeConfig: updateCodeConfigStub,
        findDeliveryType: findDeliveryTypeStub,
        deriveProjectName: deriveProjectNameStub,
        queueDeliveryConfigWriter: queueDeliveryConfigWriterStub,
      },
      '../../../../src/utils/slack/base.js': {
        loadProfileConfig: loadProfileConfigStub,
        ...(postSlackMessageStub ? { postSlackMessage: postSlackMessageStub } : {}),
      },
      '../../../../src/support/brand-profile-trigger.js': { triggerBrandProfileAgent: triggerBrandProfileAgentStub },
      '../../../../src/support/access-control-util.js': {
        default: {
          fromContext: () => ({
            hasAdminAccess: () => hasAdminAccess,
            hasAdminReadAccess: () => hasAdminReadAccess,
          }),
        },
      },
      '../../../../src/support/rum-config-service.js': { updateRumConfig: updateRumConfigStub },
    },
  )).default;
}
