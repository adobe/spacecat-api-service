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

export const PreflightDto = {
  toJSON: (preflight) => ({
    preflightId: preflight.getId(),
    status: preflight.getStatus(),
    url: preflight.getUrl(),
    createdAt: preflight.getCreatedAt(),
    createdBy: preflight.getCreatedBy(),
  }),

  toDetailJSON: (preflight) => ({
    preflightId: preflight.getId(),
    status: preflight.getStatus(),
    url: preflight.getUrl(),
    createdAt: preflight.getCreatedAt(),
    createdBy: preflight.getCreatedBy(),
    updatedAt: preflight.getUpdatedAt(),
    startedAt: preflight.getStartedAt(),
    endedAt: preflight.getEndedAt(),
    result: preflight.getResult(),
    error: preflight.getError(),
  }),
};
