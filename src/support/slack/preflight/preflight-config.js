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

import { AUTHORING_TYPES, hasText } from '@adobe/spacecat-shared-utils';

export const ERROR_MESSAGE_PREFIX = ':x: ';
export const SUCCESS_MESSAGE_PREFIX = ':white_check_mark: ';
export const PREFLIGHT_AUDIT_TYPE = 'preflight';

export const CS_AUTHORING_TYPES = [AUTHORING_TYPES.CS, AUTHORING_TYPES.CS_CW];

/**
 * @param {string} authoringType
 * @returns {boolean}
 */
export const isCSAuthoringType = (authoringType) => CS_AUTHORING_TYPES.includes(authoringType);

/**
 * @param {string} programId
 * @param {string} environmentId
 * @returns {{ externalOwnerId: string, externalSiteId: string }}
 */
export const toExternalDeliveryIds = (programId, environmentId) => ({
  externalOwnerId: `p${programId}`,
  externalSiteId: `e${environmentId}`,
});

/**
 * Extracts helix configuration from a helix preview URL
 * @param {string} previewUrl - The helix preview URL (e.g., main--site--owner.hlx.live)
 * @returns {Object|null} - The helix config object or null if invalid
 */
export function extractHelixConfigFromPreviewUrl(previewUrl) {
  const url = new URL(previewUrl);
  const domain = url.hostname;

  const regex = /^([\w-]+)--([\w-]+)--([\w-]+)\.(hlx\.live|aem\.live)$/;
  const match = domain.match(regex);

  if (!match) {
    return null;
  }

  return {
    hlxVersion: 5,
    rso: {
      ref: match[1],
      site: match[2],
      owner: match[3],
      tld: match[4],
    },
  };
}

/**
 * Returns human-readable labels for missing preflight site configuration.
 * @param {Object} site - The site object
 * @returns {string[]}
 */
export function getPreflightMissingConfigLabels(site) {
  const currentAuthoringType = site.getAuthoringType();
  const currentDeliveryConfig = site.getDeliveryConfig() || {};
  const currentHelixConfig = site.getHlxConfig() || {};

  const missingItems = [];
  if (!currentAuthoringType) {
    missingItems.push('Authoring Type');
    missingItems.push('Preview URL');
  } else if (currentAuthoringType === AUTHORING_TYPES.DA) {
    // Document authoring require helix config
    const hasHelixConfig = currentHelixConfig?.rso
      && Object.keys(currentHelixConfig.rso).length > 0;
    if (!hasHelixConfig) {
      missingItems.push('Helix Preview URL');
    }
  } else if (isCSAuthoringType(currentAuthoringType)) {
    // CS authoring types require program and environment IDs
    const hasDeliveryConfig = currentDeliveryConfig.programId
      && currentDeliveryConfig.environmentId;
    if (!hasDeliveryConfig) {
      missingItems.push('AEM CS Preview URL');
    }
  } else if (currentAuthoringType === AUTHORING_TYPES.AMS && !currentDeliveryConfig.authorURL) {
    // AMS authoring type requires an author URL
    missingItems.push('AMS URL');
  }

  return missingItems;
}

/**
 * Determines whether contentSourcePath is required for a CS or CS/Crosswalk site when
 * multiple sites in the same organization share the same program, environment, and
 * authoring type.
 * @param {Object} dataAccess
 * @param {Object} site
 * @param {string} programId
 * @param {string} environmentId
 * @param {string} authoringType
 * @returns {Promise<boolean>}
 */
export async function isContentSourcePathRequired(
  dataAccess,
  site,
  programId,
  environmentId,
  authoringType,
) {
  if (!hasText(programId) || !hasText(environmentId) || !isCSAuthoringType(authoringType)) {
    return false;
  }

  const { Site } = dataAccess;
  const { externalOwnerId, externalSiteId } = toExternalDeliveryIds(programId, environmentId);
  const siblings = await Site.allByExternalOwnerIdAndExternalSiteId(
    externalOwnerId,
    externalSiteId,
  );
  const organizationId = site.getOrganizationId();

  // Filter sites to only include ones with the same authoring type and organization ID
  const othersInOrgWithSameAuthoringType = siblings.filter(
    (candidate) => candidate.getId() !== site.getId()
      && candidate.getOrganizationId() === organizationId
      && candidate.getAuthoringType() === authoringType,
  );

  return othersInOrgWithSameAuthoringType.length >= 1;
}

/**
 * Checks whether a site has the configuration required to enable preflight.
 * @param {Object} site - The site object
 * @param {Object} context
 * @returns {Promise<{ ready: boolean, missingLabels: string[], needsContentSourcePath: boolean }>}
 */
export async function isPreflightSiteConfigReady(site, context) {
  // Check if the site has any missing configuration
  const missingLabels = getPreflightMissingConfigLabels(site);

  if (missingLabels.length > 0) {
    return { ready: false, missingLabels, needsContentSourcePath: false };
  }

  // Check if the site has contentSourcePath required for a CS or CS/Crosswalk site
  const authoringType = site.getAuthoringType();
  if (isCSAuthoringType(authoringType)) {
    const deliveryConfig = site.getDeliveryConfig() || {};
    const { programId, environmentId, contentSourcePath } = deliveryConfig;
    const contentSourcePathRequired = await isContentSourcePathRequired(
      context.dataAccess,
      site,
      programId,
      environmentId,
      authoringType,
    );

    if (contentSourcePathRequired && !hasText(contentSourcePath)) {
      return {
        ready: false,
        missingLabels: ['Content Source Path'],
        needsContentSourcePath: true,
      };
    }
  }

  return { ready: true, missingLabels: [], needsContentSourcePath: false };
}

/**
 * Posts a message with a button to configure preflight audit requirements
 * @param {Object} slackContext - The Slack context object
 * @param {Object} site - The site object
 * @param {string} auditType - The audit type (should be 'preflight')
 */
export async function promptPreflightConfig(slackContext, site, auditType) {
  const { say } = slackContext;
  const missingItems = getPreflightMissingConfigLabels(site);

  return say({
    text: `:warning: Preflight audit requires additional configuration for \`${site.getBaseURL()}\``,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: *Preflight audit requires additional configuration for:*\n\`${site.getBaseURL()}\`\n\n*Missing:*\n${missingItems.map((item) => `• ${item}`)
            .join('\n')}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Configure & Enable',
            },
            style: 'primary',
            action_id: 'open_preflight_config',
            value: JSON.stringify({
              siteId: site.getId(),
              auditType,
            }),
          },
        ],
      },
    ],
  });
}

/**
 * Enables the preflight audit handler for a site in configuration.
 * @param {Object} site
 * @param {Object} dataAccess
 * @returns {Promise<void>}
 */
export async function enablePreflightAuditForSite(site, dataAccess) {
  const { Configuration } = dataAccess;
  const configuration = await Configuration.findLatest();
  configuration.enableHandlerForSite(PREFLIGHT_AUDIT_TYPE, site);
  await configuration.save();
}
