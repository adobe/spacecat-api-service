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
 * Data transfer object for Project.
 */
export const ProjectDto = {
  /**
   * Converts a Project object into a JSON object.
   * @param {Readonly<Project>} project - Project object.
   * @returns {{
   *   id: string,
   *   name: string,
   *   organizationId: string,
   *   createdAt: string,
   *   updatedAt: string
   * }}
   */
  toJSON: (project) => ({
    id: project.getId(),
    name: project.getName(),
    organizationId: project.getOrganizationId(),
    createdAt: project.getCreatedAt(),
    updatedAt: project.getUpdatedAt(),
  }),
};
