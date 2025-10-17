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
  ok, forbidden,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText, isNonEmptyObject,
  isObject,
  isString,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import { OrganizationDto } from '../dto/organization.js';
import { ProjectDto } from '../dto/project.js';
import { SiteDto } from '../dto/site.js';
import AccessControlUtil from '../support/access-control-util.js';
import { filterSitesForProductCode } from '../support/utils.js';
/**
 * Organizations controller. Provides methods to create, read, update and delete organizations.
 * @param {object} ctx - Context of the request.
 * @param {object} env - Environment object.
 * @returns {object} Organizations controller.
 * @constructor
 */
function OrganizationsController(ctx, env) {
  const X_PRODUCT_HEADER = 'x-product';
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
  const { SLACK_URL_WORKSPACE_EXTERNAL: slackExternalWorkspaceUrl } = env;
  const { Organization, Project, Site } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Creates an organization. The organization ID is generated automatically.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Organization response.
   */
  const createOrganization = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can create new Organizations');
    }

    try {
      const organization = await Organization.create(context.data);
      return createResponse(OrganizationDto.toJSON(organization), 201);
    } catch (e) {
      return badRequest(e.message);
    }
  };

  /**
   * Gets all organizations.
   * @returns {Promise<Response>} Array of organizations response.
   */
  const getAll = async () => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can view all Organizations');
    }

    const organizations = (await Organization.all())
      .map((organization) => OrganizationDto.toJSON(organization));
    return ok(organizations);
  };

  /**
   * Gets an organization by ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<object>} Organization.
   * @throws {Error} If organization ID is not provided.
   */
  const getByID = async (context) => {
    const organizationId = context.params?.organizationId;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    const organization = await Organization.findById(organizationId);
    if (!organization) {
      return notFound('Organization not found');
    }

    if (!await accessControlUtil.hasAccess(organization)) {
      return forbidden('Only users belonging to the organization can view it');
    }

    return ok(OrganizationDto.toJSON(organization));
  };

  /**
   * Gets an organization by its IMS organization ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<object>} Organization.
   * @throws {Error} If IMS organization ID is not provided, or if not found.
   */
  const getByImsOrgID = async (context) => {
    const imsOrgId = context.params?.imsOrgId;

    if (!hasText(imsOrgId)) {
      return badRequest('IMS org ID required');
    }

    const organization = await Organization.findByImsOrgId(imsOrgId);
    if (!organization) {
      return notFound(`Organization not found by IMS org ID: ${imsOrgId}`);
    }

    if (!await accessControlUtil.hasAccess(organization)) {
      return forbidden('Only users belonging to the organization can view it');
    }

    return ok(OrganizationDto.toJSON(organization));
  };

  /**
   * Gets an organization's Slack configuration by IMS organization ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<object>} Slack config object.
   * @throws {Error} If IMS org ID is not provided, org not found, or Slack config not found.
   */
  const getSlackConfigByImsOrgID = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can view Slack configurations');
    }
    const response = await getByImsOrgID(context);
    if (response.status !== 200) {
      return response;
    }

    const body = await response.json();
    const slack = body.config?.slack;

    if (hasText(slack?.channel)) {
      // This organization has a Slack channel configured
      return ok({
        ...slack,
        'channel-url': `${slackExternalWorkspaceUrl}/archives/${slack.channel}`,
      });
    }

    return notFound(`Slack config not found for IMS org ID: ${context.params.imsOrgId}`);
  };

  /**
   * Gets all sites for an organization.
   *
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Sites.
   */
  const getSitesForOrganization = async (context) => {
    const organizationId = context.params?.organizationId;
    const { pathInfo } = context;
    const productCode = pathInfo.headers[X_PRODUCT_HEADER];
    if (!hasText(productCode)) {
      return badRequest('Product code required');
    }

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    const organization = await Organization.findById(organizationId);
    if (!organization) {
      return notFound(`Organization not found by IMS org ID: ${organizationId}`);
    }

    if (!await accessControlUtil.hasAccess(organization)) {
      return forbidden('Only users belonging to the organization can view its sites');
    }

    const sites = await Site.allByOrganizationId(organizationId);

    const filteredSites = await filterSitesForProductCode(
      context,
      organization,
      sites,
      productCode,
    );

    return ok(filteredSites.map((site) => SiteDto.toJSON(site)));
  };

  /**
   * Removes an organization and all sites/audits associated with it.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Delete response.
   */
  const removeOrganization = async (context) => {
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can delete Organizations');
    }
    const organizationId = context.params?.organizationId;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    const organization = await Organization.findById(organizationId);

    if (!organization) {
      return notFound('Organization not found');
    }

    await organization.remove();

    return noContent();
  };

  /**
   * Updates an organization
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Organization response.
   */
  const updateOrganization = async (context) => {
    const organizationId = context.params?.organizationId;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    const organization = await Organization.findById(organizationId);
    if (!organization) {
      return notFound('Organization not found');
    }

    const requestBody = context.data;
    if (!isObject(requestBody)) {
      return badRequest('Request body required');
    }

    if (!await accessControlUtil.hasAccess(organization)) {
      return forbidden('Only users belonging to the organization can update it');
    }

    let updates = false;
    if (isString(requestBody.name) && requestBody.name !== organization.getName()) {
      organization.setName(requestBody.name);
      updates = true;
    }

    if (isString(requestBody.imsOrgId) && requestBody.imsOrgId !== organization.getImsOrgId()) {
      organization.setImsOrgId(requestBody.imsOrgId);
      updates = true;
    }

    if (isObject(requestBody.config)) {
      organization.setConfig(requestBody.config);
      updates = true;
    }

    if (updates) {
      const updatedOrganization = await organization.save();
      return ok(OrganizationDto.toJSON(updatedOrganization));
    }

    return badRequest('No updates provided');
  };

  /**
   * Gets all projects for an organization.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Projects for the organization.
   */
  const getProjectsByOrganizationId = async (context) => {
    const organizationId = context.params?.organizationId;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    const organization = await Organization.findById(organizationId);
    if (!organization) {
      return notFound('Organization not found');
    }

    if (!await accessControlUtil.hasAccess(organization)) {
      return forbidden('Only users belonging to the organization can view its projects');
    }

    const projects = await Project.allByOrganizationId(organizationId);

    return ok(projects.map((project) => ProjectDto.toJSON(project)));
  };

  /**
   * Gets all sites for an organization by project ID.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Sites for the organization and project.
   */
  const getSitesByProjectIdAndOrganizationId = async (context) => {
    const { organizationId, projectId } = context.params;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    if (!isValidUUID(projectId)) {
      return badRequest('Project ID required');
    }

    const organization = await Organization.findById(organizationId);
    if (!organization) {
      return notFound('Organization not found');
    }

    if (!await accessControlUtil.hasAccess(organization)) {
      return forbidden('Only users belonging to the organization can view its sites');
    }

    const sites = await Site.allByOrganizationIdAndProjectId(organizationId, projectId);

    return ok(sites.map((site) => SiteDto.toJSON(site)));
  };

  /**
   * Gets all sites for an organization by project name.
   * @param {object} context - Context of the request.
   * @returns {Promise<Response>} Sites for the organization and project.
   */
  const getSitesByProjectNameAndOrganizationId = async (context) => {
    const { organizationId, projectName } = context.params;

    if (!isValidUUID(organizationId)) {
      return badRequest('Organization ID required');
    }

    if (!hasText(projectName)) {
      return badRequest('Project name required');
    }

    const organization = await Organization.findById(organizationId);
    if (!organization) {
      return notFound('Organization not found');
    }

    if (!await accessControlUtil.hasAccess(organization)) {
      return forbidden('Only users belonging to the organization can view its sites');
    }

    const sites = await Site.allByOrganizationIdAndProjectName(organizationId, projectName);

    return ok(sites.map((site) => SiteDto.toJSON(site)));
  };

  return {
    createOrganization,
    getAll,
    getByID,
    getByImsOrgID,
    getSlackConfigByImsOrgID,
    getSitesForOrganization,
    getProjectsByOrganizationId,
    getSitesByProjectIdAndOrganizationId,
    getSitesByProjectNameAndOrganizationId,
    removeOrganization,
    updateOrganization,
  };
}

export default OrganizationsController;
