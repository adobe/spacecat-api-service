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
 * Data transfer object for SentimentTopic.
 * Composite primary key: siteId + topicId
 */
export const SentimentTopicDto = {

  /**
   * Converts a SentimentTopic object into a JSON object.
   * @param {Readonly<SentimentTopic>} topic - SentimentTopic object.
   * @returns {{
   *  siteId: string,
   *  topicId: string,
   *  name: string,
   *  description: string|undefined,
   *  topicName: string,
   *  subPrompts: string[],
   *  audits: string[],
   *  enabled: boolean,
   *  createdAt: string,
   *  updatedAt: string,
   *  createdBy: string,
   *  updatedBy: string,
   * }} JSON object.
   */
  toJSON: (topic) => ({
    siteId: topic.getSiteId(),
    topicId: topic.getTopicId(),
    name: topic.getName(),
    description: topic.getDescription(),
    topicName: topic.getTopicName(),
    subPrompts: topic.getSubPrompts() || [],
    audits: topic.getAudits() || [],
    enabled: topic.getEnabled(),
    createdAt: topic.getCreatedAt(),
    updatedAt: topic.getUpdatedAt(),
    createdBy: topic.getCreatedBy(),
    updatedBy: topic.getUpdatedBy(),
  }),
};
