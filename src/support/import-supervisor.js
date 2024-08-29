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

import { ImportJobStatus } from '@adobe/spacecat-shared-data-access';
import { hasText } from '@adobe/spacecat-shared-utils';
import crypto from 'crypto';
import { hashWithSHA256 } from '@adobe/spacecat-shared-http-utils';
import { ErrorWithStatusCode } from './utils.js';

const PRE_SIGNED_URL_TTL_SECONDS = 3600; // 1 hour

/**
 * Import Supervisor provides functionality to start and manage import jobs.
 * @param {object} services - The services required by the handler.
 * @param {DataAccess} services.dataAccess - Data access.
 * @param {object} services.sqs - AWS Simple Queue Service client.
 * @param {object} services.s3 - AWS S3 client and related helpers.
 * @param {object} services.log - Logger.
 * @param {object} config - Import configuration details.
 * @param {Array<string>} config.queues - Array of available import queues.
 * @param {string} config.importWorkerQueue - URL of the import worker queue.
 * @param {string} config.s3Bucket - S3 bucket name where import artifacts will be stored.
 * @returns {object} Import Supervisor.
 */
function ImportSupervisor(services, config) {
  function validateServices() {
    const requiredServices = ['dataAccess', 'sqs', 's3', 'log'];
    requiredServices.forEach((service) => {
      if (!services[service]) {
        throw new Error(`Invalid services: ${service} is required`);
      }
    });
  }

  validateServices();
  const {
    dataAccess, sqs, s3: {
      s3Client, GetObjectCommand, PutObjectCommand, getSignedUrl,
    }, log,
  } = services;
  const {
    queues = [], // Array of import queues
    importWorkerQueue, // URL of the import worker queue
    s3Bucket,
    maxLengthImportScript,
  } = config;
  const IMPORT_RESULT_ARCHIVE_NAME = 'import-result.zip';

  /**
   * Get an available import queue name that is not currently in use. Throws an error if no queue
   * is currently available.
   */
  async function getAvailableImportQueue(importApiKey) {
    const runningImportJobs = await dataAccess.getImportJobsByStatus(ImportJobStatus.RUNNING);

    // Check that this import API key has capacity to start an import job
    for (const job of runningImportJobs) {
      const hashedApiKey = hashWithSHA256(importApiKey);
      if (job.getHashedApiKey() === hashedApiKey) {
        throw new ErrorWithStatusCode(`Too Many Requests: API key hash ${hashedApiKey} cannot be used to start any more import jobs`, 429);
      }
    }

    const activeQueues = runningImportJobs.map((job) => job.getImportQueueId());

    // Find an import queue that is not in use
    for (const candidateQueue of queues) {
      if (!activeQueues.includes(candidateQueue)) {
        return candidateQueue;
      }
    }
    throw new ErrorWithStatusCode('Service Unavailable: No import queue available', 503);
  }

  function determineBaseURL(urls) {
    // Initially, we will just use the domain of the first URL
    const url = new URL(urls[0]);
    return `${url.protocol}//${url.hostname}`;
  }

  /**
   * Create a new import job by claiming one of the free import queues, persisting the import job
   * metadata, and setting the job status to 'RUNNING'.
   * @param {Array<string>} urls - The list of URLs to import.
   * @param {string} importQueueId - Name of the queue to use for this import job.
   * @param {string} apiKey - API key used to authenticate the import job request.
   * @param {object} options - Client provided options for the import job.
   * @returns {Promise<ImportJob>}
   */
  async function createNewImportJob(urls, importQueueId, hashedApiKey, options, initiatedBy) {
    const newJob = {
      id: crypto.randomUUID(),
      baseURL: determineBaseURL(urls),
      importQueueId,
      hashedApiKey,
      options,
      urlCount: urls.length,
      status: ImportJobStatus.RUNNING,
      initiatedBy,
    };
    return dataAccess.createNewImportJob(newJob);
  }

  /**
   * Get all import jobs between the specified start and end dates.
   * @param {string} startDate - The start date of the range.
   * @param {string} endDate - The end date of the range.
   * @returns {Promise<ImportJob[]>}
   */
  async function getImportJobsByDateRange(startDate, endDate) {
    return dataAccess.getImportJobsByDateRange(startDate, endDate);
  }

  /**
   * Queue all URLs as a single message for processing by another function. This will enable
   * the controller to respond with a new job ID ASAP, while the individual URLs are queued up
   * asynchronously.
   * @param {Array<string>} urls - Array of URL records to queue.
   * @param {object} importJob - The import job record.
   */
  async function queueUrlsForImportWorker(urls, importJob) {
    log.info(`Starting a new import job of baseUrl: ${importJob.getBaseURL()} with ${urls.length}`
      + ` URLs. This new job has claimed: ${importJob.getImportQueueId()} `
      + `(jobId: ${importJob.getId()})`);

    // Send a single message containing all URLs and the new job ID
    const message = {
      processingType: 'import',
      jobId: importJob.getId(),
      urls,
    };

    await sqs.sendMessage(importWorkerQueue, message);
  }

  async function writeImportScriptToS3(jobId, importScript) {
    if (!hasText(importScript)) {
      throw new ErrorWithStatusCode('Bad Request: importScript should be a string', 400);
    }

    // Check for the length of the importScript
    if (importScript.length > maxLengthImportScript) {
      throw new ErrorWithStatusCode(`Bad Request: importScript should be less than ${maxLengthImportScript} characters`, 400);
    }

    let decodedScript;
    try {
      decodedScript = Buffer.from(importScript, 'base64').toString('utf-8');
    } catch {
      throw new ErrorWithStatusCode('Bad Request: importScript should be a base64 encoded string', 400);
    }

    const key = `imports/${jobId}/import.js`;
    const command = new PutObjectCommand({ Bucket: s3Bucket, Key: key, Body: decodedScript });
    try {
      await s3Client.send(command);
    } catch {
      throw new ErrorWithStatusCode(`Internal Server Error: Failed to write import script to S3 for jobId: ${jobId}`, 500);
    }
  }

  /**
   * Starts a new import job.
   * @param {Array<string>} urls - The URLs to import.
   * @param {string} importApiKey - The API key to use for the import job.
   * @param {object} options - Optional configuration params for the import job.
   * @param {string} importScript - Optional custom Base64 encoded import script.
   * @returns {Promise<ImportJob>}
   */
  async function startNewJob(urls, importApiKey, options, importScript, initiatedBy) {
    // Determine if there is a free import queue
    const importQueueId = await getAvailableImportQueue(importApiKey);

    // Hash the API Key to ensure it is not stored in plain text
    const hashedApiKey = hashWithSHA256(importApiKey);

    // If a queue is available, create the import-job record in dataAccess:
    const newImportJob = await createNewImportJob(
      urls,
      importQueueId,
      hashedApiKey,
      options,
      initiatedBy,
    );

    log.info('New import job created:\n'
      + `- baseUrl: ${newImportJob.getBaseURL()}\n`
      + `- urlCount: ${urls.length}\n`
      + `- apiKeyName: ${initiatedBy.apiKeyName}\n`
      + `- jobId: ${newImportJob.getId()}\n`
      + `- importQueueId: ${importQueueId}`);

    // Write the import script to S3, if provided
    if (importScript) {
      await writeImportScriptToS3(newImportJob.getId(), importScript);
    }

    // Queue all URLs for import as a single message. This enables the controller to respond with
    // a job ID ASAP, while the individual URLs are queued up asynchronously by another function.
    await queueUrlsForImportWorker(urls, newImportJob);

    return newImportJob;
  }

  /**
   * Get an import job from the data layer. Verifies the API key to ensure it matches the one
   * used to start the job.
   * @param {string} jobId - The ID of the job.
   * @param {string} importApiKey - API key that was provided to start the job.
   * @returns {Promise<ImportJobDto>}
   */
  async function getImportJob(jobId, importApiKey) {
    if (!hasText(jobId)) {
      throw new ErrorWithStatusCode('Job ID is required', 400);
    }

    const job = await dataAccess.getImportJobByID(jobId);
    let hashedApiKey;
    if (job) {
      hashedApiKey = hashWithSHA256(importApiKey);
    }
    // Job must exist, and the import API key must match the one provided
    if (!job || job.getHashedApiKey() !== hashedApiKey) {
      throw new ErrorWithStatusCode('Not found', 404);
    }

    return job;
  }

  /**
   * For COMPLETE jobs, get a pre-signed URL for the import archive file stored in S3.
   * @param {ImportJob} job - The import job.
   * @returns {Promise<string>}
   */
  async function getJobArchiveSignedUrl(job) {
    if (job.getStatus() !== ImportJobStatus.COMPLETE) {
      throw new ErrorWithStatusCode('Archive not available, job is still running', 404);
    }

    try {
      const key = `imports/${job.getId()}/${IMPORT_RESULT_ARCHIVE_NAME}`;
      const command = new GetObjectCommand({ Bucket: s3Bucket, Key: key });

      return getSignedUrl(s3Client, command, { expiresIn: PRE_SIGNED_URL_TTL_SECONDS });
    } catch (err) {
      log.error(`Failed to generate pre-signed S3 URL for jobId: ${job.getId()}`, err);
      throw new ErrorWithStatusCode('Error occurred generating a pre-signed job result URL', 500);
    }
  }

  return {
    startNewJob,
    getImportJob,
    getJobArchiveSignedUrl,
    getImportJobsByDateRange,
  };
}

export default ImportSupervisor;
