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
   *   externalUserId: string,
   *   status: string,
   *   provider: string,
   *   lastSeenAt: string,
   *   emailId: string,
   *   firstName: string,
   *   lastName: string,
   *   metadata: any,
   *   createdAt: string,
   *   updatedAt: string
   * }}
   */
  toJSON: (trialUser) => ({
    id: trialUser.getId(),
    organizationId: trialUser.getOrganizationId(),
    externalUserId: trialUser.getExternalUserId(),
    status: trialUser.getStatus(),
    provider: trialUser.getProvider(),
    lastSeenAt: trialUser.getLastSeenAt(),
    emailId: trialUser.getEmailId(),
    firstName: trialUser.getFirstName(),
    lastName: trialUser.getLastName(),
    metadata: trialUser.getMetadata(),
    createdAt: trialUser.getCreatedAt(),
    updatedAt: trialUser.getUpdatedAt(),
  }),
};
