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

import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';

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
    deliveryConfig: site.getDeliveryConfig(),
    gitHubURL: site.getGitHubURL(),
    organizationId: site.getOrganizationId(),
    isLive: site.getIsLive(),
    isLiveToggledAt: site.getIsLiveToggledAt(),
    createdAt: site.getCreatedAt(),
    updatedAt: site.getUpdatedAt(),
    config: Config.toDynamoItem(site.getConfig()),
    ...(audit && { audits: [AuditDto.toAbbreviatedJSON(audit)] }),
  }),

  // TODO: implement toCSV
  toCSV: () => '',

  // TODO: implement toXLS
  toXLS: () => null,
};
