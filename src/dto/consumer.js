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

/**
 * Data Transfer Object for Consumer.
 */
export const ConsumerDto = {
  /**
   * Converts a Consumer entity into a JSON object.
   * @param {Readonly<Consumer>} consumer - Consumer entity.
   * @returns {object} JSON representation of the consumer.
   */
  toJSON: (consumer) => ({
    consumerId: consumer.getConsumerId(),
    clientId: consumer.getClientId(),
    technicalAccountId: consumer.getTechnicalAccountId(),
    imsOrgId: consumer.getImsOrgId(),
    consumerName: consumer.getConsumerName(),
    capabilities: consumer.getCapabilities(),
    status: consumer.getStatus(),
    revokedAt: consumer.getRevokedAt(),
    createdAt: consumer.getCreatedAt(),
    updatedAt: consumer.getUpdatedAt(),
    updatedBy: consumer.getUpdatedBy(),
  }),
};
