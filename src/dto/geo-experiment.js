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

export const GeoExperimentDto = {
  toJSON(experiment) {
    return {
      id: experiment.getId(),
      siteId: experiment.getSiteId(),
      opportunityId: experiment.getOpportunityId(),
      type: experiment.getType(),
      name: experiment.getName(),
      status: experiment.getStatus(),
      phase: experiment.getPhase(),
      preScheduleId: experiment.getPreScheduleId() ?? null,
      postScheduleId: experiment.getPostScheduleId() ?? null,
      suggestionIds: experiment.getSuggestionIds(),
      promptsCount: experiment.getPromptsCount(),
      promptsLocation: experiment.getPromptsLocation() ?? null,
      metadata: experiment.getMetadata() ?? null,
      error: experiment.getError() ?? null,
      startTime: experiment.getStartTime() ?? null,
      endTime: experiment.getEndTime() ?? null,
      updatedBy: experiment.getUpdatedBy(),
      createdAt: experiment.getCreatedAt(),
      updatedAt: experiment.getUpdatedAt(),
    };
  },
};
