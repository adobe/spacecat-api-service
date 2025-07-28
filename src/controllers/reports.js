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
  badRequest,
  forbidden,
  notFound,
  ok,
  internalServerError,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';

import AccessControlUtil from '../support/access-control-util.js';
import { ReportDto } from '../dto/report.js';

/**
 * Reports controller. Provides methods to create and manage report generation jobs.
 * @param {object} ctx - Context of the request.
 * @param {object} log - Logger.
 * @param {object} env - Environment variables.
 * @returns {object} Reports controller.
 * @constructor
 */
function ReportsController(ctx, log, env) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess, sqs } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Site, Report } = dataAccess;
  const accessControlUtil = AccessControlUtil.fromContext(ctx);

  /**
   * Creates a report generation job for a specific site and report type.
   * @param {object} context - Context of the request.
   * @param {object} context.params - Request parameters.
   * @param {string} context.params.siteId - The site ID.
   * @param {object} context.data - Request body data.
   * @param {string} context.data.reportType - The type of report to generate.
   * @return {Promise<Response>} Report job response.
   */
  const createReport = async (context) => {
    const { siteId } = context.params;
    const { data } = context;

    // Validate site ID
    if (!isValidUUID(siteId)) {
      return badRequest('Valid site ID is required');
    }

    // Validate request data
    if (!isNonEmptyObject(data)) {
      return badRequest('Request data is required');
    }

    const { reportType } = data;

    // Validate report type
    if (!hasText(reportType)) {
      return badRequest('Report type is required');
    }

    try {
      // Check if site exists
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      // Check access control
      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('User does not have access to this site');
      }

      // Get the reports queue URL from environment
      const reportsQueueUrl = env.REPORT_JOBS_QUEUE_URL;
      if (!hasText(reportsQueueUrl)) {
        log.error('REPORT_JOBS_QUEUE_URL environment variable is not configured');
        return internalServerError('Reports queue is not configured');
      }

      // Create report data for the spacecat-shared Report model
      const reportData = {
        siteId,
        reportType,
        reportPeriod: data.reportPeriod,
        comparisonPeriod: data.comparisonPeriod,
      };

      // Create the Report entity using spacecat-shared
      const report = await Report.create(reportData);

      // Use the report ID as the job ID
      const jobId = report.getId();

      // Get user information for tracking
      const initiatedBy = context.attributes?.user?.email || 'unknown';

      // Create the message to send to the report-jobs queue using the DTO
      const reportMessage = ReportDto.toQueueMessage(report, jobId, initiatedBy);

      // Send message to the report-jobs queue
      await sqs.sendMessage(reportsQueueUrl, reportMessage);

      log.info(`Report job queued successfully for site ${siteId}, report type: ${reportType}, jobId: ${jobId}`);

      // Return response with current structure plus new fields
      return ok({
        message: 'Report generation job queued successfully',
        siteId,
        reportType,
        status: 'queued',
        jobId,
        timestamp: reportMessage.timestamp,
      });
    } catch (error) {
      log.error(`Failed to create report job: ${error.message}`);
      return internalServerError(`Failed to create report job: ${error.message}`);
    }
  };

  /**
   * Retrieves all reports for a specific site.
   * @param {object} context - Context of the request.
   * @param {object} context.params - Request parameters.
   * @param {string} context.params.siteId - The site ID.
   * @return {Promise<Response>} Response containing all reports for the site.
   */
  const getAllReportsBySiteId = async (context) => {
    const { siteId } = context.params;

    // Validate site ID
    if (!isValidUUID(siteId)) {
      return badRequest('Valid site ID is required');
    }

    try {
      // Check if site exists
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      // Check access control
      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('User does not have access to this site');
      }

      // Get all reports for the site
      const reports = await Report.allBySiteId(siteId);

      // Convert reports to JSON using the DTO
      const reportsJson = reports.map((report) => ReportDto.toJSON(report));

      log.info(`Retrieved ${reports.length} reports for site ${siteId}`);

      return ok({
        siteId,
        reports: reportsJson,
        count: reports.length,
      });
    } catch (error) {
      log.error(`Failed to get reports for site ${siteId}: ${error.message}`);
      return internalServerError(`Failed to get reports: ${error.message}`);
    }
  };

  /**
   * Retrieves a specific report for a site.
   * @param {object} context - Context of the request.
   * @param {object} context.params - Request parameters.
   * @param {string} context.params.siteId - The site ID.
   * @param {string} context.params.reportId - The report ID to retrieve.
   * @return {Promise<Response>} Response containing the report data.
   */
  const getReport = async (context) => {
    const { siteId, reportId } = context.params;

    // Validate site ID
    if (!isValidUUID(siteId)) {
      return badRequest('Valid site ID is required');
    }

    // Validate report ID
    if (!isValidUUID(reportId)) {
      return badRequest('Valid report ID is required');
    }

    try {
      // Check if site exists
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      // Check access control
      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('User does not have access to this site');
      }

      // Check if report exists
      const report = await Report.findById(reportId);
      if (!report) {
        return notFound('Report not found');
      }

      // Verify the report belongs to the specified site
      if (report.getSiteId() !== siteId) {
        return badRequest('Report does not belong to the specified site');
      }

      // Convert report to JSON using the DTO
      const reportJSON = ReportDto.toJSON(report);

      log.info(`Retrieved report ${reportId} for site ${siteId}`);

      return ok(reportJSON);
    } catch (error) {
      log.error(`Failed to get report ${reportId} for site ${siteId}: ${error.message}`);
      return internalServerError(`Failed to get report: ${error.message}`);
    }
  };

  /**
   * Deletes a specific report for a site.
   * @param {object} context - Context of the request.
   * @param {object} context.params - Request parameters.
   * @param {string} context.params.siteId - The site ID.
   * @param {string} context.params.reportId - The report ID to delete.
   * @return {Promise<Response>} Response confirming report deletion.
   */
  const deleteReport = async (context) => {
    const { siteId, reportId } = context.params;

    // Validate site ID
    if (!isValidUUID(siteId)) {
      return badRequest('Valid site ID is required');
    }

    // Validate report ID
    if (!isValidUUID(reportId)) {
      return badRequest('Valid report ID is required');
    }

    try {
      // Check if site exists
      const site = await Site.findById(siteId);
      if (!site) {
        return notFound('Site not found');
      }

      // Check access control
      if (!await accessControlUtil.hasAccess(site)) {
        return forbidden('User does not have access to this site');
      }

      // Check if report exists
      const report = await Report.findById(reportId);
      if (!report) {
        return notFound('Report not found');
      }

      // Verify the report belongs to the specified site
      if (report.getSiteId() !== siteId) {
        return badRequest('Report does not belong to the specified site');
      }

      // Delete the report
      await report.remove();

      log.info(`Report ${reportId} deleted successfully for site ${siteId}`);

      return ok({
        message: 'Report deleted successfully',
        siteId,
        reportId,
      });
    } catch (error) {
      log.error(`Failed to delete report ${reportId} for site ${siteId}: ${error.message}`);
      return internalServerError(`Failed to delete report: ${error.message}`);
    }
  };

  return {
    createReport,
    getAllReportsBySiteId,
    getReport,
    deleteReport,
  };
}

export default ReportsController;
