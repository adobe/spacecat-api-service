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

import {
  createResponse,
  badRequest,
  noContent,
  notFound,
  ok,
  forbidden,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isNonEmptyObject,
  isObject,
  isString,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import { ProjectDto } from '../dto/project.js';
import { SiteDto } from '../dto/site.js';
import AccessControlUtil from '../support/access-control-util.js';

/**
 * Projects controller. Provides methods to create, read, update and delete projects.
 * @param {object} ctx - Context of the request.
 * @param {object} env - Environment object.
 * @returns {object} Projects controller.
 * @constructor
 */
function ProjectsController(ctx, env) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  if (!isNonEmptyObject(env)) {
    throw new Error('Environment object required');
  }

  const { Project, Site } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Creates a project. The project ID is generated automatically.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Project response.
   */
  const createProject = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can create new projects');
    }

    try {
      const project = await Project.create(context.data);
      return createResponse(ProjectDto.toJSON(project), 201);
    } catch (e) {
      return badRequest(e.message);
    }
  };

  /**
   * Gets all projects.
   * @returns {Promise<Response>} Array of projects response.
   */
  const getAll = async () => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can view all projects');
    }

    const projects = (await Project.all())
      .map((project) => ProjectDto.toJSON(project));
    return ok(projects);
  };

  /**
   * Gets a project by ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<object>} Project.
   * @throws {Error} If project ID is not provided.
   */
  const getByID = async (context) => {
    const projectId = context.params?.projectId;

    if (!isValidUUID(projectId)) {
      return badRequest('Project ID required');
    }

    const project = await Project.findById(projectId);
    if (!project) {
      return notFound('Project not found');
    }

    if (!await accessControlUtil.hasAccess(project)) {
      return forbidden('Only users belonging to the organization can view its projects');
    }

    return ok(ProjectDto.toJSON(project));
  };

  /**
   * Gets all sites with primary locale for a project.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Sites with primary locale.
   */
  const getPrimaryLocaleSites = async (context) => {
    const projectId = context.params?.projectId;

    if (!isValidUUID(projectId)) {
      return badRequest('Project ID required');
    }

    const project = await Project.findById(projectId);
    if (!project) {
      return notFound('Project not found');
    }

    if (!await accessControlUtil.hasAccess(project)) {
      return forbidden('Only users belonging to the organization can view its project sites');
    }

    const sites = await project.getPrimaryLocaleSites();

    return ok(sites.map((site) => SiteDto.toJSON(site)));
  };

  /**
   * Removes a project.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Delete response.
   */
  const removeProject = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can delete projects');
    }

    const projectId = context.params?.projectId;

    if (!isValidUUID(projectId)) {
      return badRequest('Project ID required');
    }

    const project = await Project.findById(projectId);

    if (!project) {
      return notFound('Project not found');
    }

    await project.remove();

    return noContent();
  };

  /**
   * Updates a project
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Project response.
   */
  const updateProject = async (context) => {
    const projectId = context.params?.projectId;

    if (!isValidUUID(projectId)) {
      return badRequest('Project ID required');
    }

    const project = await Project.findById(projectId);
    if (!project) {
      return notFound('Project not found');
    }

    const requestBody = context.data;
    if (!isObject(requestBody)) {
      return badRequest('Request body required');
    }

    if (!await accessControlUtil.hasAccess(project)) {
      return forbidden('Only users belonging to the organization can update its projects');
    }

    let updates = false;
    if (isString(requestBody.projectName) && requestBody.projectName !== project.getProjectName()) {
      project.setProjectName(requestBody.projectName);
      updates = true;
    }

    if (isValidUUID(requestBody.organizationId)
        && requestBody.organizationId !== project.getOrganizationId()) {
      project.setOrganizationId(requestBody.organizationId);
      updates = true;
    }

    if (updates) {
      const updatedProject = await project.save();
      return ok(ProjectDto.toJSON(updatedProject));
    }

    return badRequest('No updates provided');
  };

  /**
   * Gets all sites for a project by project ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Sites for the project.
   */
  const getSitesByProjectId = async (context) => {
    const projectId = context.params?.projectId;

    if (!isValidUUID(projectId)) {
      return badRequest('Project ID required');
    }

    const project = await Project.findById(projectId);
    if (!project) {
      return notFound('Project not found');
    }

    if (!await accessControlUtil.hasAccess(project)) {
      return forbidden('Only users belonging to the organization can view its project sites');
    }

    const sites = await Site.allByProjectId(projectId);

    return ok(sites.map((site) => SiteDto.toJSON(site)));
  };

  /**
   * Gets all sites for a project by project name.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Sites for the project.
   */
  const getSitesByProjectName = async (context) => {
    const projectName = context.params?.projectName;

    if (!hasText(projectName)) {
      return badRequest('Project name required');
    }

    const project = await Project.findByProjectName(projectName);
    if (!project) {
      return notFound('Project not found');
    }

    if (!await accessControlUtil.hasAccess(project)) {
      return forbidden('Only users belonging to the organization can view its project sites');
    }

    const sites = await Site.allByProjectName(projectName);

    return ok(sites.map((site) => SiteDto.toJSON(site)));
  };

  return {
    createProject,
    getAll,
    getByID,
    getPrimaryLocaleSites,
    getSitesByProjectId,
    getSitesByProjectName,
    removeProject,
    updateProject,
  };
}

export default ProjectsController;
