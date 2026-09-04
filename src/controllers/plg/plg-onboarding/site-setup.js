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

import { deriveProjectName } from '../../../support/utils.js';

// Config handlers turned on for every PLG site. scrape-top-pages must precede
// broken-backlinks (its dependency). Failures are logged and swallowed — onboarding
// continues even if a handler can't be enabled.
export const PLG_CONFIG_HANDLERS = [
  'summit-plg',
  'scrape-top-pages',
  'broken-backlinks',
  'alt-text',
  'cwv',
];

export async function createOrFindProject(baseURL, organizationId, context) {
  const { dataAccess, log } = context;
  const { Project } = dataAccess;
  const projectName = (context.deriveProjectName || deriveProjectName)(baseURL);

  const existingProject = (
    await Project.allByOrganizationId(organizationId)
  ).find((p) => p.getProjectName() === projectName);

  if (existingProject) {
    log.debug(`Found existing project ${existingProject.getId()}`);
    return existingProject;
  }

  const newProject = await Project.create({ projectName, organizationId });
  log.info(`Created project ${newProject.getId()} for ${baseURL}`);
  return newProject;
}

export async function enrollPlgConfigHandlers(site, context) {
  const { dataAccess, log } = context;
  const siteId = site.getId();
  try {
    const { Configuration } = dataAccess;
    const configuration = await Configuration.findLatest();
    const enrolled = [];
    PLG_CONFIG_HANDLERS.forEach((handler) => {
      try {
        configuration.enableHandlerForSite(handler, site);
        enrolled.push(handler);
      } catch (error) {
        log.warn(`Failed to enable handler ${handler} for site ${siteId}: ${error.message}`);
      }
    });
    await configuration.save();
    log.info(`Enrolled site ${siteId} in config handlers: ${enrolled.join(', ')}`);
  } catch (error) {
    log.warn(`Failed to enroll site in config handlers: ${error.message}`);
  }
}
