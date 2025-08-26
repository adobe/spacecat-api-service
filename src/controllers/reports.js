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
import {
  Report as ReportModel,
} from '@adobe/spacecat-shared-data-access';

import AccessControlUtil from '../support/access-control-util.js';
import { ReportDto } from '../dto/report.js';
import { sendReportTriggerMessage } from '../support/utils.js';

/**
 * Validates a period object (reportPeriod or comparisonPeriod)
 * @param {object} period - The period object to validate
 * @param {string} periodName - The name of the period for error messages
 * @returns {string|null} Error message if validation fails, null if valid
 */
function isValidPeriod(period, periodName) {
  if (!isNonEmptyObject(period)) {
    return `${periodName} is required`;
  }

  if (!hasText(period.startDate)) {
    return `${periodName} start date is required`;
  }

  if (!hasText(period.endDate)) {
    return `${periodName} end date is required`;
  }

  // Validate date format (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(period.startDate)) {
    return `${periodName} start date must be in YYYY-MM-DD format`;
  }

  if (!dateRegex.test(period.endDate)) {
    return `${periodName} end date must be in YYYY-MM-DD format`;
  }

  // Validate that dates can be parsed
  const parsedStartDate = new Date(period.startDate);
  if (Number.isNaN(parsedStartDate.getTime())) {
    return `${periodName} start date is not a valid date`;
  }

  const parsedEndDate = new Date(period.endDate);
  if (Number.isNaN(parsedEndDate.getTime())) {
    return `${periodName} end date is not a valid date`;
  }

  // Validate that start date is not after end date
  if (parsedStartDate > parsedEndDate) {
    return `${periodName} start date must be less than or equal to end date`;
  }

  return null;
}

/**
 * Compares two period objects for equality
 * @param {object} period1 - First period object with startDate and endDate
 * @param {object} period2 - Second period object with startDate and endDate
 * @returns {boolean} True if periods are equal, false otherwise
 */
function comparePeriods(period1, period2) {
  if (!period1 || !period2) {
    return false;
  }

  // Compare startDate and endDate properties
  return period1.startDate === period2.startDate && period1.endDate === period2.endDate;
}

async function generatePresignedUrl(s3, bucket, key) {
  const {
    s3Client,
    getSignedUrl,
    GetObjectCommand,
  } = s3;

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  // 7 days
  const expiresIn = 60 * 60 * 24 * 7;
  const expiresAt = new Date(Date.now() + (expiresIn * 1000));

  const url = await getSignedUrl(s3Client, command, { expiresIn });

  return {
    url,
    expiresAt: expiresAt.toISOString(),
  };
}

async function deleteS3Object(s3, bucket, key) {
  const {
    s3Client,
    DeleteObjectCommand,
  } = s3;

  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  return s3Client.send(command);
}

async function uploadS3Object(s3, bucket, key, data) {
  const {
    s3Client,
    PutObjectCommand,
  } = s3;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json',
  });

  return s3Client.send(command);
}

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
  const { dataAccess, sqs, s3 } = ctx;
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
   * @param {object} context.data.reportPeriod - The report period with startDate
   *   and endDate.
   * @param {string} context.data.reportPeriod.startDate - The start date for the
   *   report period.
   * @param {string} context.data.reportPeriod.endDate - The end date for the report period.
   * @param {object} context.data.comparisonPeriod - The comparison period with startDate
   *   and endDate.
   * @param {string} context.data.comparisonPeriod.startDate - The start date for the
   *   comparison period.
   * @param {string} context.data.comparisonPeriod.endDate - The end date for the
   *   comparison period.
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

    const { reportType, name } = data;

    if (!hasText(name)) {
      return badRequest('Report name is required');
    }

    // Validate report type
    if (!hasText(reportType)) {
      return badRequest('Report type is required');
    }

    // Validate report period
    const reportPeriodError = isValidPeriod(data.reportPeriod, 'Report period');
    if (reportPeriodError) {
      return badRequest(reportPeriodError);
    }

    // Validate comparison period
    const comparisonPeriodError = isValidPeriod(data.comparisonPeriod, 'Comparison period');
    if (comparisonPeriodError) {
      return badRequest(comparisonPeriodError);
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

      // Check if a report with the same parameters already exists
      const existingReports = await Report.allBySiteId(siteId);
      // Filter out failed reports (only consider successful & processing reports
      // for duplicate checking)
      const filteredReports = existingReports.filter((report) => (
        report.getStatus() === ReportModel.STATUSES.SUCCESS
        || report.getStatus() === ReportModel.STATUSES.PROCESSING
      ));
      const existingReport = filteredReports.find((report) => {
        const reportData = report.getReportType();
        const reportPeriod = report.getReportPeriod();
        const comparisonPeriod = report.getComparisonPeriod();

        // Check if report type matches
        if (reportData !== reportType) {
          return false;
        }

        // Compare report periods using dedicated function
        const periodsMatch = comparePeriods(reportPeriod, data.reportPeriod);
        const comparisonPeriodsMatch = comparePeriods(comparisonPeriod, data.comparisonPeriod);

        return periodsMatch && comparisonPeriodsMatch;
      });

      if (existingReport) {
        log.info(`Report already exists for site ${siteId} with the same parameters`);
        return badRequest('A report with the same type and duration already exists for this site');
      }

      // Get the reports queue URL from environment
      const { REPORT_JOBS_QUEUE_URL: reportsQueueUrl } = env;
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
      const reportMessage = ReportDto.toQueueMessage(report, jobId, name, initiatedBy);

      // Send message to the report-jobs queue
      await sendReportTriggerMessage(sqs, reportsQueueUrl, reportMessage, reportType);

      log.info(`Report job queued successfully for site ${siteId}, report type: ${reportType}, jobId: ${jobId}`);

      // Return response with current structure plus new fields
      return ok({
        message: 'Report generation job queued successfully',
        siteId,
        reportType,
        status: 'processing',
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
    const { S3_REPORT_BUCKET: bucketName } = env;
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

      // Convert reports to JSON using the DTO, with presigned URLs for successful reports
      const reportsJson = await Promise.all(reports.map(async (report) => {
        // Only generate presigned URLs for successful reports
        if (report.getStatus() === 'success') {
          try {
            const rawReportKey = `${report.getRawStoragePath()}report.json`;
            const mystiqueReportKey = `${report.getEnhancedStoragePath()}report.json`;
            const rawPresignedUrlResult = await generatePresignedUrl(s3, bucketName, rawReportKey);
            const mystiquePresignedUrlResult = await generatePresignedUrl(
              s3,
              bucketName,
              mystiqueReportKey,
            );
            const presignedUrlObject = {
              rawPresignedUrl: rawPresignedUrlResult.url,
              rawPresignedUrlExpiresAt: rawPresignedUrlResult.expiresAt,
              mystiquePresignedUrl: mystiquePresignedUrlResult.url,
              mystiquePresignedUrlExpiresAt: mystiquePresignedUrlResult.expiresAt,
            };
            return ReportDto.toJSON(report, presignedUrlObject);
          } catch (urlError) {
            log.warn(`Failed to generate presigned URLs for report ${report.getId()}: ${urlError.message}`);
            return ReportDto.toJSON(report);
          }
        }
        return ReportDto.toJSON(report);
      }));

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
    const { S3_REPORT_BUCKET: bucketName } = env;
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

      if (report.getStatus() !== ReportModel.STATUSES.SUCCESS) {
        return badRequest('Report is still processing.');
      }

      // Verify the report belongs to the specified site
      if (report.getSiteId() !== siteId) {
        return badRequest('Report does not belong to the specified site');
      }

      const rawReportKey = `${report.getRawStoragePath()}report.json`;
      const mystiqueReportKey = `${report.getEnhancedStoragePath()}report.json`;
      const rawPresignedUrlResult = await generatePresignedUrl(s3, bucketName, rawReportKey);
      const mystiquePresignedUrlResult = await generatePresignedUrl(
        s3,
        bucketName,
        mystiqueReportKey,
      );
      const presignedUrlObject = {
        rawPresignedUrl: rawPresignedUrlResult.url,
        rawPresignedUrlExpiresAt: rawPresignedUrlResult.expiresAt,
        mystiquePresignedUrl: mystiquePresignedUrlResult.url,
        mystiquePresignedUrlExpiresAt: mystiquePresignedUrlResult.expiresAt,
      };
      // Convert report to JSON using the DTO
      const reportJSON = ReportDto.toJSON(report, presignedUrlObject);

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
    const { S3_REPORT_BUCKET: bucketName, S3_MYSTIQUE_BUCKET: mystiqueBucketName } = env;

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

      if (report.getStatus() === ReportModel.STATUSES.SUCCESS && report.getRawStoragePath()) {
        const rawReportKey = `${report.getRawStoragePath()}report.json`;
        const mystiqueReportKey = `${report.getEnhancedStoragePath()}report.json`;

        try {
          // Delete both S3 files
          await Promise.all([
            deleteS3Object(s3, bucketName, rawReportKey),
            deleteS3Object(s3, mystiqueBucketName, mystiqueReportKey),
          ]);
          log.info(`S3 files deleted for report ${reportId}: ${rawReportKey}, ${mystiqueReportKey}`);
        } catch (s3Error) {
          // Log S3 deletion error but continue with database deletion
          log.warn(`Failed to delete S3 files for report ${reportId}: ${s3Error.message}`);
        }
      }

      // Delete the report from database
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

  /**
   * Updates the enhanced report data in S3 for a specific report.
   * @param {object} context - Context of the request.
   * @param {object} context.params - Request parameters.
   * @param {string} context.params.siteId - The site ID.
   * @param {string} context.params.reportId - The report ID to update.
   * @param {object} context.data - Request body data containing the new report data.
   * @return {Promise<Response>} Response confirming report update.
   */
  const patchReport = async (context) => {
    const { siteId, reportId } = context.params;
    const { data } = context;
    const { S3_MYSTIQUE_BUCKET: bucketName } = env;

    // Validate site ID
    if (!isValidUUID(siteId)) {
      return badRequest('Valid site ID is required');
    }

    // Validate report ID
    if (!isValidUUID(reportId)) {
      return badRequest('Valid report ID is required');
    }

    // Validate request data
    if (!isNonEmptyObject(data)) {
      return badRequest('Request data is required');
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

      // Only allow updates for successful reports
      if (report.getStatus() !== ReportModel.STATUSES.SUCCESS) {
        return badRequest('Can only update reports that are in success status');
      }

      // Check if report has a storage path
      if (!report.getEnhancedStoragePath()) {
        return badRequest('Report does not have a valid storage path');
      }

      // Upload the new enhanced report data to S3
      const mystiqueReportKey = `${report.getEnhancedStoragePath()}report.json`;

      try {
        await uploadS3Object(s3, bucketName, mystiqueReportKey, data);
        log.info(`Enhanced report updated successfully for report ${reportId} at key: ${mystiqueReportKey}`);
      } catch (s3Error) {
        log.error(`Failed to upload enhanced report to S3 for report ${reportId}: ${s3Error.message}`);
        return internalServerError(`Failed to update report in S3: ${s3Error.message}`);
      }

      // Update the report's lastModified timestamp
      await report.save();

      log.info(`Report ${reportId} enhanced data updated successfully for site ${siteId}`);

      return ok({
        message: 'Enhanced report updated successfully',
        siteId,
        reportId,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      log.error(`Failed to update enhanced report ${reportId} for site ${siteId}: ${error.message}`);
      return internalServerError(`Failed to update report: ${error.message}`);
    }
  };

  return {
    createReport,
    getAllReportsBySiteId,
    getReport,
    deleteReport,
    patchReport,
  };
}

export default ReportsController;
