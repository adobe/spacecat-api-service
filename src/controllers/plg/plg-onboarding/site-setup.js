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

/**
 * Re-parents a site's project so it ends up in the same org as the site.
 *
 * Onboarding reassigns only `site.organizationId` (see `reassignSiteOrganization`),
 * which leaves the site's project stranded in the org it was created under during
 * preonboarding (typically an internal/demo org). The org-scoped Studio UI groups
 * sites under `/organizations/{orgId}/projects`, so a site whose project lives in a
 * different org can't be resolved in the customer's scope and renders as
 * "Unassigned" — even though `site.organizationId` is correct. This is the
 * automated-onboarding twin of the manual Slack fix in SITES-46200
 * (`support/slack/actions/set-ims-org-modal.js` `reparentSiteProject`).
 *
 * Mutates `site` in place only in the split branch (where it sets a new projectId).
 * Returns `true` when the site was mutated so the caller can persist it; the solo
 * branch persists the project itself and the no-op branches return `false`.
 *
 * - No project on the site: nothing to do.
 * - Project already in the target org: nothing to do.
 * - Site is the only member of its project: move the whole project to the target
 *   org (the site keeps its projectId).
 * - Other sites still share the project: split — repoint this site to a project in
 *   the target org (find-or-create by name) so the siblings keep their project.
 *
 * @param {object} site - The site being re-parented (already has its new orgId set).
 * @param {string} targetOrgId - The Spacecat org id the site is moving to.
 * @param {object} context - Lambda context (provides dataAccess + log).
 * @returns {Promise<boolean>} `true` if `site` was mutated and needs a `save()`.
 */
export async function reparentSiteProjectToOrg(site, targetOrgId, context) {
  const { dataAccess, log } = context;
  const { Project, Site } = dataAccess;

  const projectId = site.getProjectId();
  if (!projectId) {
    return false;
  }

  const project = await Project.findById(projectId);
  if (!project) {
    log.warn(`plg-onboarding: site ${site.getId()} references missing project ${projectId}; skipping project re-parent`);
    return false;
  }

  if (project.getOrganizationId() === targetOrgId) {
    return false;
  }

  const sitesOnProject = await Site.allByProjectId(projectId);
  if (sitesOnProject.length <= 1) {
    // Solo site on the project — move the whole project to the target org.
    project.setOrganizationId(targetOrgId);
    await project.save();
    log.info(`plg-onboarding: moved project ${project.getId()} to org ${targetOrgId} so site ${site.getId()} stays resolvable in the site picker`);
    return false;
  }

  // Project is shared with sites staying behind — split it so the moved site
  // gets a project in the target org and the siblings keep theirs.
  const newProject = await createOrFindProject(site.getBaseURL(), targetOrgId, context);
  site.setProjectId(newProject.getId());
  log.info(`plg-onboarding: split site ${site.getId()} onto project ${newProject.getId()} in org ${targetOrgId}`);
  return true;
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
    if (enrolled.length === 0) {
      log.warn(`No config handlers could be enabled for site ${siteId}; skipping save`);
      return;
    }
    await configuration.save();
    log.info(`Enrolled site ${siteId} in config handlers: ${enrolled.join(', ')}`);
  } catch (error) {
    log.warn(`Failed to enroll site in config handlers: ${error.message}`);
  }
}
