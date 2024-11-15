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

import {
  createOpportunity,
} from '../temp-mocks/mocks.js';
// from @adobe/spacecat-shared-data-access/src/models/opportunity.js';

/**
 * Data transfer object for Site.
 */
export const OpportunityDto = {

  /**
   * Converts a JSON object into an Opportunity object.
   * @param {object } jsonObject - JSON object.
   * @returns {Readonly<Audit>} Opportunity object.
   */
  fromJson: (jsonObject) => {
    const opptyData = {
      id: jsonObject.id,
      siteId: jsonObject.siteId,
      auditId: jsonObject.auditId,
      runbook: jsonObject.runbook,
      type: jsonObject.type,
      data: jsonObject.data,
      origin: jsonObject.origin,
      title: jsonObject.title,
      description: jsonObject.description,
      guidance: jsonObject.guidance,
      tags: jsonObject.tags,
      createdAt: jsonObject.createdAt,
      createdBy: jsonObject.createdBy,
      updatedAt: jsonObject.updatedAt,
      updatedBy: jsonObject.updatedBy,
    };

    return createOpportunity(opptyData);
  },

  /**
   * Converts an Opportunity object into a JSON object.
   * @param {Readonly<Opportunity>} oppty - Opportunity object.
   * @returns {{
    * id: string,
    * siteId: string,
    * auditId: string,
    * runbook: string,
    * type: string,
    * data: object,
    * origin: string,
    * title: string,
    * description: string,
    * guidance: object,
    * tags: Array<string>,
    * createdAt: date,
    * createdBy: string,
    * updatedAt: date,
    * updatedBy: string
    * }} JSON object.
   */
  toJSON: (oppty) => ({
    id: oppty.getId(),
    siteId: oppty.getSiteId(),
    auditId: oppty.getAuditId(),
    runbook: oppty.getRunbook(),
    type: oppty.getType(),
    data: oppty.getData(),
    origin: oppty.getOrigin(),
    title: oppty.getTitle(),
    description: oppty.getDescription(),
    guidance: oppty.getGuidance(),
    tags: oppty.getTags(),
    createdAt: oppty.getCreatedAt(),
    createdBy: oppty.getCreatedBy(),
    updatedAt: oppty.getUpdatedAt(),
    updatedBy: oppty.getUpdatedBy(),
  }),
};
