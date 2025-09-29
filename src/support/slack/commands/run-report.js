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

import { isNonEmptyObject, isValidUrl } from '@adobe/spacecat-shared-utils';
import BaseCommand from './base.js';
import { postErrorMessage, extractURLFromSlackInput } from '../../../utils/slack/base.js';
import { REPORT_TYPES } from '../../../utils/constants.js';

const PHRASES = ['run report'];

/**
 * Validates a date string in YYYY-MM-DD format and returns the Date object if valid
 * @param {string} dateString - The date string to validate
 * @returns {Date|null} Date object if valid, null otherwise
 */
function validateAndCreateDate(dateString) {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateString)) {
    return null;
  }
  const date = new Date(dateString);
  // Check if the date is valid and if the parsed date matches the input string
  // This prevents dates like '2025-02-30' from being considered valid
  if (Number.isNaN(date.getTime()) || date.toISOString().split('T')[0] !== dateString) {
    return null;
  }
  return date;
}

/**
 * Sanitizes and formats a report name for consistency
 * @param {string} name - The raw name input from user
 * @returns {string} Sanitized name with first letter uppercase and trimmed
 */
function sanitizeReportName(name) {
  // Trim whitespace and normalize spaces
  const trimmed = name.trim().replace(/\s+/g, ' ');
  // Convert to lowercase first, then capitalize first letter
  const lowercased = trimmed.toLowerCase();
  return lowercased.charAt(0).toUpperCase() + lowercased.slice(1);
}

/**
 * Validates a period object (reportPeriod or comparisonPeriod)
 * @param {object} period - The period object to validate
 * @param {string} periodName - The name of the period for error messages
 * @returns {string|null} Error message if validation fails, null if valid
 */
function isValidPeriod(period, periodName) {
  // Validate and create Date objects once
  const startDate = validateAndCreateDate(period.startDate);
  if (!startDate) {
    return `${periodName} start date must be in YYYY-MM-DD format`;
  }

  const endDate = validateAndCreateDate(period.endDate);
  if (!endDate) {
    return `${periodName} end date must be in YYYY-MM-DD format`;
  }

  // Validate that start date is not after end date
  if (startDate > endDate) {
    return `${periodName} start date must be less than or equal to end date`;
  }

  return null;
}

/**
 * Factory function to create the RunReportCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {RunReportCommand} The RunReportCommand object.
 * @constructor
 */
function RunReportCommand(context) {
  const { log, dataAccess, env } = context;
  const { Site } = dataAccess;

  const baseCommand = BaseCommand({
    id: 'run-report',
    name: 'Run Report',
    description: 'Generate a report for a site with specified parameters including report type, name, report period, and comparison period.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site} {reportType} {name} {reportStartDate} {reportEndDate} {comparisonStartDate} {comparisonEndDate}`,
  });

  /**
   * Makes an API call to the reports endpoint
   * @param {string} siteId - The site ID
   * @param {object} reportData - The report data to send
   * @param {object} slackContext - The Slack context object
   * @returns {Promise<object>} The API response
   */
  const callReportsAPI = async (siteId, reportData, _) => {
    try {
      // Get the API base URL from environment or use a default
      const apiBaseUrl = env.SPACECAT_API_BASE_URL;
      const apiKey = env.USER_API_KEY;
      const apiUrl = `${apiBaseUrl}/sites/${siteId}/reports`;
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Add authorization header if needed
          ...(apiKey && { 'x-api-key': `${apiKey}` }),
        },
        body: JSON.stringify(reportData),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed with status ${response.status}: ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      log.error(`Failed to call reports API: ${error.message}`);
      throw error;
    }
  };

  /**
   * Handles the execution of the run report command
   * @param {string[]} args - The arguments provided to the command
   * @param {Object} slackContext - The Slack context object
   * @returns {Promise<void>}
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      // Parse arguments: site, reportType, name, reportStartDate, reportEndDate,
      // comparisonStartDate, comparisonEndDate
      const [
        siteInput,
        reportType,
        name,
        reportStartDate,
        reportEndDate,
        comparisonStartDate,
        comparisonEndDate,
      ] = args;

      // Validate required arguments (allow empty strings to pass through to period validation)
      if (siteInput === undefined || siteInput === null
          || reportType === undefined || reportType === null) {
        await say(`:warning: Missing required arguments. ${baseCommand.usage()}`);
        return;
      }

      // Extract and validate site URL
      const baseURL = extractURLFromSlackInput(siteInput);
      if (!isValidUrl(baseURL)) {
        await say(`:warning: Invalid site URL: ${siteInput}`);
        return;
      }
      // If name is not provided use a default one
      let reportName = name;
      if (reportName === undefined || reportName == null) {
        const { hostname } = new URL(baseURL);
        reportName = hostname.replace(/^www\./, '');
        reportName = reportName.charAt(0).toUpperCase() + reportName.slice(1);
      }
      let finalReportStartDate = reportStartDate;
      let finalReportEndDate = reportEndDate;
      if ((finalReportStartDate === undefined || finalReportStartDate == null)
        && (finalReportEndDate === undefined || finalReportEndDate == null)) {
        const d = new Date();
        d.setMonth(d.getMonth() - 1);
        [finalReportStartDate] = d.toISOString().split('T');
        [finalReportEndDate] = new Date().toISOString().split('T');
      }

      let finalComparisonStartDate = comparisonStartDate;
      let finalComparisonEndDate = comparisonEndDate;
      if ((finalComparisonStartDate === undefined || finalComparisonStartDate == null)
        && (finalComparisonEndDate === undefined || finalComparisonEndDate == null)) {
        const d = new Date();
        d.setMonth(d.getMonth() - 1);
        [finalComparisonEndDate] = d.toISOString().split('T');
        d.setMonth(d.getMonth() - 1);
        [finalComparisonStartDate] = d.toISOString().split('T');
      }

      // Find the site
      const site = await Site.findByBaseURL(baseURL);
      if (!isNonEmptyObject(site)) {
        await say(`:warning: Site not found: ${baseURL}`);
        return;
      }

      const siteId = site.getId();

      // Validate report type
      const validReportTypes = Object.values(REPORT_TYPES);
      if (!validReportTypes.includes(reportType)) {
        await say(`:warning: Invalid report type: ${reportType}. Valid types are: \`${validReportTypes.join('`, `')}\``);
        return;
      }

      // Sanitize the report name for consistency
      const sanitizedName = sanitizeReportName(reportName);

      // Build report data object
      const reportData = {
        reportType,
        name: sanitizedName,
        reportPeriod: {
          startDate: finalReportStartDate,
          endDate: finalReportEndDate,
        },
        comparisonPeriod: {
          startDate: finalComparisonStartDate,
          endDate: finalComparisonEndDate,
        },
      };

      // Send initial message
      await say(`:adobe-run: Generating ${reportType} report "${sanitizedName}" for site ${baseURL}...`);

      // Validate periods
      const reportPeriodError = isValidPeriod(reportData.reportPeriod, 'Report period');
      if (reportPeriodError) {
        await say(`:warning: ${reportPeriodError}`);
        return;
      }

      const comparisonPeriodError = isValidPeriod(reportData.comparisonPeriod, 'Comparison period');
      if (comparisonPeriodError) {
        await say(`:warning: ${comparisonPeriodError}`);
        return;
      }

      // Call the API
      const apiResponse = await callReportsAPI(siteId, reportData, slackContext);

      // Send success message
      await say(':white_check_mark: Report generation job queued successfully!\n'
        + `• Site: ${baseURL}\n`
        + `• Report Type: ${reportType}\n`
        + `• Report Name: ${sanitizedName}\n`
        + `• Report Period: ${finalReportStartDate} to ${finalReportEndDate}\n`
        + `• Comparison Period: ${finalComparisonStartDate} to ${finalComparisonEndDate}\n`
        + `• Report ID: ${apiResponse.reportId || 'N/A'}\n`
        + `• Status: ${apiResponse.status || 'processing'}`);
    } catch (error) {
      log.error(`Error running report: ${error.message}`);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default RunReportCommand;
