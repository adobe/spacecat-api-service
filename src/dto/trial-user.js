/*
 * Copyright 2025 Adobe. All rights reserved.
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
 * Data transfer object for TrialUser.
 */
export const TrialUserDto = {
  /**
   * Converts a TrialUser object into a JSON object.
   * @param {Readonly<TrialUser>} trialUser - TrialUser object.
   * @returns {{
   *   id: string,
   *   organizationId: string,
   *   emailId: string,
   *   firstName: string,
   *   lastName: string,
   *   externalUserId: string,
   *   provider: string,
   *   status: string,
   *   lastSeenAt: string,
   *   metadata: any,
   *   createdAt: string,
   *   updatedAt: string,
   *   updatedBy: string
   * }}
   */
  toJSON: (trialUser) => ({
    id: trialUser.getId(),
    organizationId: trialUser.getOrganizationId(),
    emailId: trialUser.getEmailId(),
    firstName: trialUser.getFirstName(),
    lastName: trialUser.getLastName(),
    externalUserId: trialUser.getExternalUserId(),
    status: trialUser.getStatus(),
    lastSeenAt: trialUser.getLastSeenAt(),
    metadata: trialUser.getMetadata(),
    createdAt: trialUser.getCreatedAt(),
    updatedAt: trialUser.getUpdatedAt(),
    updatedBy: trialUser.getUpdatedBy(),
  }),
};
