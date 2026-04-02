/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { ConfigDto } from './config.js';
import { AuditDto } from './audit.js';

/**
 * Data transfer object for Site.
 */
export const SiteDto = {
  /**
   * Converts a Site object into a JSON object.
   * @param {Readonly<Site>} site - Site object.
   * @param {Audit[]} [audit] - Optional audit object.
   * @returns {{
   * id: string,
   * baseURL, gitHubURL: string,
   * name: string,
   * gitHubURL: string,
   * organizationId: string,
   * isLive: boolean,
   * createdAt: string,
   * updatedAt: string
   * }}
   */
  toJSON: (site, audit) => ({
    id: site.getId(),
    baseURL: site.getBaseURL(),
    name: site.getName(),
    hlxConfig: site.getHlxConfig(),
    deliveryType: site.getDeliveryType(),
    authoringType: site.getAuthoringType(),
    deliveryConfig: site.getDeliveryConfig(),
    gitHubURL: site.getGitHubURL(),
    organizationId: site.getOrganizationId(),
    isLive: site.getIsLive(),
    isSandbox: site.getIsSandbox(),
    isLiveToggledAt: site.getIsLiveToggledAt(),
    createdAt: site.getCreatedAt(),
    updatedAt: site.getUpdatedAt(),
    config: ConfigDto.toJSON(site.getConfig()),
    pageTypes: site.getPageTypes(),
    projectId: site.getProjectId(),
    isPrimaryLocale: site.getIsPrimaryLocale(),
    region: site.getRegion(),
    language: site.getLanguage(),
    ...(site.getCode() && { code: site.getCode() }),
    ...(audit && { audits: [AuditDto.toAbbreviatedJSON(audit)] }),
    updatedBy: site.getUpdatedBy(),
  }),

  /**
   * Slim representation for list endpoints to reduce payload size.
   * Only includes fields actively consumed by UI clients.
   * @param {Readonly<Site>} site - Site object.
   * @returns {object}
   */
  toListJSON: (site) => ({
    id: site.getId(),
    baseURL: site.getBaseURL(),
    name: site.getName(),
    organizationId: site.getOrganizationId(),
    deliveryType: site.getDeliveryType(),
    gitHubURL: site.getGitHubURL(),
    isLive: site.getIsLive(),
    isSandbox: site.getIsSandbox(),
    createdAt: site.getCreatedAt(),
    updatedAt: site.getUpdatedAt(),
    region: site.getRegion(),
    config: ConfigDto.toListJSON(site.getConfig()),
  }),

  /**
   * Minimal representation returning only essential fields.
   * Used when clients need only basic site identification.
   * @param {Readonly<Site>} site - Site object.
   * @returns {object}
   */
  toMinimalJSON: (site) => {
    const result = {
      id: site.getId(),
      baseURL: site.getBaseURL(),
    };

    // Add optional authoringType
    const authoringType = site.getAuthoringType();
    if (authoringType) {
      result.authoringType = authoringType;
    }

    // Add optional deliveryConfig.authorURL
    const deliveryConfig = site.getDeliveryConfig();
    if (deliveryConfig?.authorURL) {
      result.deliveryConfig = {
        authorURL: deliveryConfig.authorURL,
      };
    }

    // Add optional hlxConfig.rso.site
    const hlxConfig = site.getHlxConfig();
    if (hlxConfig?.rso?.site) {
      result.hlxConfig = {
        rso: {
          site: hlxConfig.rso.site,
        },
      };
    }

    return result;
  },

  // TODO: implement toCSV
  toCSV: () => '',

  // TODO: implement toXLS
  toXLS: () => null,
};
