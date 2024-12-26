/*
 * Copyright 2024 Adobe. All rights reserved.
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
 * Data transfer object for Import Job.
 */
export const ImportJobDto = {
  /**
   * Converts an Import Job object into a JSON object.
   */
  toJSON: (importJob) => ({
    id: importJob.getId(),
    baseURL: importJob.getBaseURL(),
    options: importJob.getOptions(),
    startedAt: importJob.getStartedAt(),
    endedAt: importJob.getEndedAt(),
    duration: importJob.getDuration(),
    status: importJob.getStatus(),
    urlCount: importJob.getUrlCount(),
    initiatedBy: importJob.getInitiatedBy(),
    successCount: importJob.getSuccessCount(),
    failedCount: importJob.getFailedCount(),
    redirectCount: importJob.getRedirectCount(),
    hasCustomHeaders: importJob.getHasCustomHeaders(),
    hasCustomImportJs: importJob.getHasCustomImportJs(),
  }),
};
