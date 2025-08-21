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
 * Data transfer object for Report.
 */
export const ReportDto = {
  /**
   * Converts a Report object into a JSON object.
   * @param {Readonly<Report>} report - Report object from spacecat-shared.
   * @param {object} [presignedUrlObject] - Optional object containing
   * presigned URLs and expiration times.
   * @returns {{
   * id: string,
   * siteId: string,
   * reportType: string,
   * status: string,
   * reportPeriod: { startDate: string, endDate: string },
   * comparisonPeriod: { startDate: string, endDate: string },
   * storagePath: string,
   * createdAt: string,
   * updatedAt: string,
   * updatedBy: string,
   * data?: { rawPresignedUrl?: string,
   *  rawPresignedUrlExpiresAt?: string,
   *  mystiquePresignedUrl?: string,
   *  mystiquePresignedUrlExpiresAt?: string
   * }
   * }}
   */
  toJSON: (report, presignedUrlObject) => {
    const result = {
      id: report.getId(),
      siteId: report.getSiteId(),
      reportType: report.getReportType(),
      status: report.getStatus(),
      reportPeriod: report.getReportPeriod(),
      comparisonPeriod: report.getComparisonPeriod(),
      storagePath: report.getStoragePath(),
      createdAt: report.getCreatedAt(),
      updatedAt: report.getUpdatedAt(),
      updatedBy: report.getUpdatedBy(),
    };

    // Add presigned URLs and expiration times in optional "data" field if provided
    if (presignedUrlObject
      && (presignedUrlObject.rawPresignedUrl
        || presignedUrlObject.mystiquePresignedUrl)) {
      result.data = {};
      if (presignedUrlObject.rawPresignedUrl) {
        result.data.rawPresignedUrl = presignedUrlObject.rawPresignedUrl;
      }
      if (presignedUrlObject.rawPresignedUrlExpiresAt) {
        result.data.rawPresignedUrlExpiresAt = presignedUrlObject.rawPresignedUrlExpiresAt;
      }
      if (presignedUrlObject.mystiquePresignedUrl) {
        result.data.mystiquePresignedUrl = presignedUrlObject.mystiquePresignedUrl;
      }
      if (presignedUrlObject.mystiquePresignedUrlExpiresAt) {
        result.data.mystiquePresignedUrlExpiresAt = presignedUrlObject
          .mystiquePresignedUrlExpiresAt;
      }
    }

    return result;
  },

  /**
   * Converts a Report object into a JSON object for queue messages.
   * @param {Readonly<Report>} report - Report object from spacecat-shared.
   * @param {string} jobId - The job ID for tracking.
   * @param {string} initiatedBy - The user who initiated the report.
   * @returns {{
   * reportId: string,
   * siteId: string,
   * reportType: string,
   * reportPeriod: { startDate: string, endDate: string },
   * comparisonPeriod: { startDate: string, endDate: string },
   * timestamp: string,
   * initiatedBy: string
   * }}
   */
  toQueueMessage: (report, jobId, name, initiatedBy) => ({
    reportId: jobId,
    siteId: report.getSiteId(),
    name,
    reportType: report.getReportType(),
    reportPeriod: report.getReportPeriod(),
    storagePath: report.getStoragePath(),
    comparisonPeriod: report.getComparisonPeriod(),
    timestamp: new Date().toISOString(),
    initiatedBy,
  }),
};
