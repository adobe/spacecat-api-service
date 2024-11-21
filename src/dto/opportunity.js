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

/**
 * Data transfer object for Site.
 */
export const OpportunityDto = {

  /**
   * Converts a JSON object into an Opportunity object.
   * @param {object } jsonObject - JSON object.
   * @returns {Readonly<Audit>} Opportunity object.

  fromJson: (jsonObject) => {
    const opptyData = {
      opportunityId: jsonObject.opportunityId,
      siteId: jsonObject.siteId,
      auditId: jsonObject.auditId,
      runbook: jsonObject.runbook,
      type: jsonObject.type,
      data: jsonObject.data,
      origin: jsonObject.origin,
      title: jsonObject.title,
      description: jsonObject.description,
      guidance: jsonObject.guidance,
      status: jsonObject.status,
      tags: jsonObject.tags,
      createdAt: jsonObject.createdAt,
      updatedAt: jsonObject.updatedAt,
    };

    return createOpportunity(opptyData);
  },
     */

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
    opportunityId: oppty.getOpportunityId(),
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
    status: oppty.getStatus(),
    createdAt: oppty.getCreatedAt(),
    updatedAt: oppty.getUpdatedAt(),
  }),
};
