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
    status: oppty.getStatus(),
    createdAt: oppty.getCreatedAt(),
    updatedAt: oppty.getUpdatedAt(),
  }),
};
