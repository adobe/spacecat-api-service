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

import { Site as SiteModel } from '@adobe/spacecat-shared-data-access';
import { hasText } from '@adobe/spacecat-shared-utils';

import { PlgOnboardingDto } from '../../../dto/plg-onboarding.js';
import {
  AEM_CS_AUTHOR_URL_PATTERN, EDS_HOST_PATTERN, isSafeDomain, isValidDomain, prepareDomain,
} from './validation.js';
import { postPlgOnboardingNotification } from './notifications.js';
import { revokeAsoSiteEnrollments, reassignSiteOrganization } from './entitlement.js';
import { performAsoPlgOnboarding } from './onboarding-flow.js';
import { STATUSES, REVIEW_DECISIONS } from './constants.js';

/**
 * BYPASS for DOMAIN_ALREADY_ONBOARDED_IN_ORG: find the previously onboarded domain in
 * the same IMS org, waitlist it (with an offboard review entry), revoke its ASO
 * enrollments, then re-run the PLG flow for the current domain.
 */
export async function bypassDisplaceOnboarded({ onboarding, reviewedBy, reviewedAt }, context) {
  const { ok, dataAccess, log } = context;
  const { PlgOnboarding } = dataAccess;

  const imsOrgId = onboarding.getImsOrgId();
  const records = await PlgOnboarding.allByImsOrgId(imsOrgId);
  const oldOnboarded = records.find(
    (r) => r.getDomain() !== onboarding.getDomain()
      && r.getStatus() === STATUSES.ONBOARDED,
  );
  if (oldOnboarded) {
    oldOnboarded.setStatus(STATUSES.OUTDATED);
    oldOnboarded.setWaitlistReason(null);
    oldOnboarded.setUpdatedBy('system');
    const oldReviews = oldOnboarded.getReviews() || [];
    oldOnboarded.setReviews([...oldReviews, {
      reason: null,
      decision: REVIEW_DECISIONS.OFFBOARDED,
      reviewedBy,
      reviewedAt,
      justification: 'System action to start onboarding for new domain in the same IMS org.',
    }]);
    await oldOnboarded.save();
    await postPlgOnboardingNotification(oldOnboarded, context);
    try {
      await revokeAsoSiteEnrollments(oldOnboarded, context);
    } catch (revokeErr) {
      log.warn(`Failed to revoke enrollments for offboarded domain ${oldOnboarded.getDomain()}: ${revokeErr.message}`);
    }
    log.info(`Offboarded old domain ${oldOnboarded.getDomain()} for IMS org ${imsOrgId}`);
  }

  await onboarding.save();
  const result = await performAsoPlgOnboarding(
    { domain: onboarding.getDomain(), imsOrgId },
    context,
  );
  return ok(PlgOnboardingDto.toAdminJSON(result));
}

/**
 * BYPASS for AEM_SITE_CHECK: validate the admin-supplied delivery type / author URL,
 * normalize it, and re-run the PLG flow with presets. Returns badRequest for any
 * input validation failure.
 */
/* eslint-disable no-param-reassign */
export async function bypassAemSiteCheck({ onboarding, siteConfig }, context) {
  const { badRequest, ok } = context;
  if (!siteConfig || !hasText(siteConfig.deliveryType)) {
    return badRequest('siteConfig with deliveryType is required for AEM_SITE_CHECK bypass');
  }
  const validDeliveryTypes = Object.values(SiteModel.DELIVERY_TYPES)
    .filter((t) => t !== SiteModel.DELIVERY_TYPES.OTHER);
  if (!validDeliveryTypes.includes(siteConfig.deliveryType)) {
    return badRequest(`deliveryType must be one of: ${validDeliveryTypes.join(', ')}`);
  }
  if (hasText(siteConfig.authorUrl)) {
    if (siteConfig.deliveryType === SiteModel.DELIVERY_TYPES.AEM_CS) {
      if (!/^https?:\/\//i.test(siteConfig.authorUrl)) {
        siteConfig.authorUrl = `https://${siteConfig.authorUrl}`;
      }
      if (!AEM_CS_AUTHOR_URL_PATTERN.test(siteConfig.authorUrl)) {
        return badRequest(
          'authorUrl for AEM_CS must match the pattern: https://author-pXXX-eYYY.adobeaemcloud.com',
        );
      }
    } else if (siteConfig.deliveryType === SiteModel.DELIVERY_TYPES.AEM_EDGE) {
      const hostname = siteConfig.authorUrl.replace(/^https?:\/\//i, '').split('/')[0];
      if (!EDS_HOST_PATTERN.test(hostname)) {
        return badRequest(
          'authorUrl for AEM_EDGE must be a valid EDS host (ref--repo--owner.aem.live or hlx.live)',
        );
      }
      siteConfig.authorUrl = hostname;
    } else if (!/^https?:\/\//i.test(siteConfig.authorUrl)) {
      return badRequest('authorUrl must be a valid HTTP(S) URL');
    }
  }

  await onboarding.save();
  const result = await performAsoPlgOnboarding(
    {
      domain: onboarding.getDomain(),
      imsOrgId: onboarding.getImsOrgId(),
      presetDeliveryType: siteConfig.deliveryType,
      /* c8 ignore next */
      presetAuthorUrl: siteConfig.authorUrl || null,
      presetProgramId: siteConfig.programId ?? null,
    },
    context,
  );
  return ok(PlgOnboardingDto.toAdminJSON(result));
}
/* eslint-enable no-param-reassign */

/**
 * BYPASS for DOMAIN_ALREADY_ASSIGNED. Two sub-paths:
 *  - alternateDomain: retire the current domain and start onboarding the alternate.
 *  - moveSite: transfer the site from its existing org to the current onboarding's org
 *    (only allowed when no active enrollments exist), then re-run the PLG flow.
 */
export async function bypassDomainAlreadyAssigned({ onboarding, siteConfig }, context) {
  const {
    badRequest, ok, dataAccess, log,
  } = context;
  const { Site, Organization } = dataAccess;

  const domain = onboarding.getDomain();
  const baseURL = onboarding.getBaseURL();
  let site = await Site.findByBaseURL(baseURL);

  if (!site) {
    return badRequest('Site no longer exists for this domain');
  }

  if (hasText(siteConfig?.alternateDomain)) {
    const altDomain = prepareDomain(siteConfig.alternateDomain);
    if (!isValidDomain(altDomain)) {
      log.warn(`PLG bypass rejected — invalid alternate domain syntax. raw=${JSON.stringify(siteConfig.alternateDomain)} normalized=${JSON.stringify(altDomain)} onboardingId=${onboarding.getId?.()}`);
      return badRequest(`Invalid alternate domain: must be a valid hostname or hostname/path (e.g. nba.com or nba.com/kings): ${altDomain}`);
    }
    if (!isSafeDomain(altDomain)) {
      log.warn(`PLG bypass rejected — unsafe alternate domain (SSRF gate). normalized=${JSON.stringify(altDomain)} onboardingId=${onboarding.getId?.()}`);
      return badRequest(`Invalid alternate domain: ${altDomain}`);
    }
    onboarding.setStatus(STATUSES.OUTDATED);
    onboarding.setWaitlistReason(null);
    await onboarding.save();
    await postPlgOnboardingNotification(onboarding, context);
    log.info(`Retiring domain ${domain}, starting onboarding for alternate domain ${altDomain}`);
    const result = await performAsoPlgOnboarding(
      { domain: altDomain, imsOrgId: onboarding.getImsOrgId() },
      context,
    );
    return ok(PlgOnboardingDto.toAdminJSON(result));
  }

  if (siteConfig?.moveSite) {
    const existingOrgId = site.getOrganizationId();
    const siteEnrollments = await site.getSiteEnrollments();
    if (siteEnrollments && siteEnrollments.length > 0) {
      const existingOrg = await Organization.findById(existingOrgId);
      /* c8 ignore next */
      return badRequest(`Cannot move domain ${domain} - it is already set up with active products in org '${existingOrg?.getName?.() || existingOrgId}'.`);
    }
    const currentOrgId = onboarding.getOrganizationId();
    if (!currentOrgId) {
      return badRequest('Onboarding record has no associated organization');
    }
    const currentImsOrgId = onboarding.getImsOrgId();
    /* c8 ignore next */
    const existingDeliveryConfig = site.getDeliveryConfig() || {};
    if (existingDeliveryConfig.imsOrgId) {
      site.setDeliveryConfig({ ...existingDeliveryConfig, imsOrgId: currentImsOrgId });
    }
    site = await reassignSiteOrganization(site, currentOrgId);
    log.info(`Moved site ${site.getId()} from org ${existingOrgId} to org ${currentOrgId}`);
    await onboarding.save();
    const result = await performAsoPlgOnboarding(
      { domain, imsOrgId: onboarding.getImsOrgId() },
      context,
    );
    return ok(PlgOnboardingDto.toAdminJSON(result));
  }

  return badRequest(
    'siteConfig.moveSite or siteConfig.alternateDomain is required for DOMAIN_ALREADY_ASSIGNED bypass',
  );
}

/**
 * BYPASS for NON_PROD_DOMAIN: admin has confirmed the domain should be onboarded despite
 * containing a non-production subdomain (qa, stage, dev, etc.). Sets nonProdCheckBypassed
 * in steps so the guard is skipped when the flow re-runs.
 */
export async function bypassNonProdDomain({ onboarding }, context) {
  const { ok } = context;
  onboarding.setSteps({ ...(onboarding.getSteps() || {}), nonProdCheckBypassed: true });
  const result = await performAsoPlgOnboarding(
    {
      domain: onboarding.getDomain(),
      imsOrgId: onboarding.getImsOrgId(),
    },
    context,
  );
  return ok(PlgOnboardingDto.toAdminJSON(result));
}
