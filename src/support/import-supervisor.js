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

import { ImportJob as ImportJobModel } from '@adobe/spacecat-shared-data-access';
import { hashWithSHA256 } from '@adobe/spacecat-shared-http-utils';
import { isValidUUID } from '@adobe/spacecat-shared-utils';

import { ErrorWithStatusCode } from './utils.js';
import { STATUS_BAD_REQUEST } from '../utils/constants.js';

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

  const { ImportJob, ImportUrl } = dataAccess;

  const {
    queues = [], // Array of import queues
    importWorkerQueue, // URL of the import worker queue
    s3Bucket,
    importQueueUrlPrefix, // URL prefix for the queues assigned to particular import jobs
  } = config;
  const IMPORT_RESULT_ARCHIVE_NAME = 'import-result.zip';

  /**
   * Get an available import queue name that is not currently in use. Throws an error if no queue
   * is currently available.
   */
  async function getAvailableImportQueue(hashedApiKey) {
    const runningImportJobs = await ImportJob.allByStatus(ImportJobModel.ImportJobStatus.RUNNING);

    // Check that this import API key has capacity to start an import job
    for (const job of runningImportJobs) {
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
   * @param {string} hashedApiKey - API key used to authenticate the import job request.
   * @param {object} options - Client provided options for the import job.
   * @param initiatedBy - Details about the initiator of the import job.
   * @param {boolean} hasCustomHeaders - Whether custom headers are provided. Defaults to false.
   * @param {boolean} hasCustomImportJs - Whether custom import JS is provided. Defaults to false.
   * @returns {Promise<ImportJob>}
   */
  async function createNewImportJob(
    urls,
    importQueueId,
    hashedApiKey,
    options,
    initiatedBy,
    hasCustomHeaders = false,
    hasCustomImportJs = false,
  ) {
    return ImportJob.create({
      baseURL: determineBaseURL(urls),
      importQueueId,
      hashedApiKey,
      options,
      urlCount: urls.length,
      status: ImportJobModel.ImportJobStatus.RUNNING,
      initiatedBy,
      hasCustomHeaders,
      hasCustomImportJs,
    });
  }

  /**
   * Get all import jobs between the specified start and end dates.
   * @param {string} startDate - The start date of the range.
   * @param {string} endDate - The end date of the range.
   * @returns {Promise<ImportJob[]>}
   */
  async function getImportJobsByDateRange(startDate, endDate) {
    return ImportJob.allByDateRange(startDate, endDate);
  }

  /**
   * Queue all URLs as a single message for processing by another function. This will enable
   * the controller to respond with a new job ID ASAP, while the individual URLs are queued up
   * asynchronously.
   * @param {Array<string>} urls - Array of URL records to queue.
   * @param {object} importJob - The import job record.
   * @param {object} customHeaders - Optional custom headers to be sent with each request.
   */
  async function queueUrlsForImportWorker(urls, importJob, customHeaders) {
    log.info(`Starting a new import job of baseUrl: ${importJob.getBaseURL()} with ${urls.length}`
      + ` URLs. This new job has claimed: ${importJob.getImportQueueId()} `
      + `(jobId: ${importJob.getId()})`);

    const options = importJob.getOptions();
    let processingType;

    if (options?.type === undefined || options.type === ImportJobModel.ImportOptionTypes.DOC) {
      processingType = 'import';
    } else if (options.type === ImportJobModel.ImportOptionTypes.XWALK) {
      processingType = 'import-xwalk';
    }

    // Send a single message containing all URLs and the new job ID
    const message = {
      processingType,
      jobId: importJob.getId(),
      urls,
      customHeaders,
    };

    await sqs.sendMessage(importWorkerQueue, message);
  }

  async function writeFileToS3(filename, jobId, importScript) {
    const key = `imports/${jobId}/${filename}`;
    const command = new PutObjectCommand({ Bucket: s3Bucket, Key: key, Body: importScript });
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
   * @param {object} initiatedBy - Details about the initiator of the import job.
   * @param {object} customHeaders - Optional custom headers to be sent with each request.
   * @param {string} models - The component-models.json file for the xwalk job.
   * @param {string} filters - The component-filters.json file for the xwalk job.
   * @param {string} definitions - The component-definitions.json file for the xwalk job.
   * @returns {Promise<ImportJob>}
   */
  async function startNewJob(
    urls,
    importApiKey,
    options,
    importScript,
    initiatedBy,
    customHeaders,
    models,
    filters,
    definitions,
  ) {
    // Hash the API Key to ensure it is not stored in plain text
    const hashedApiKey = hashWithSHA256(importApiKey);

    // Determine if there is a free import queue
    const importQueueId = await getAvailableImportQueue(hashedApiKey);

    // If a queue is available, create the import-job record in dataAccess:
    const newImportJob = await createNewImportJob(
      urls,
      importQueueId,
      hashedApiKey,
      options,
      initiatedBy,
      !!customHeaders,
      !!importScript,
    );

    log.info(
      'New import job created:\n'
      + `- baseUrl: ${newImportJob.getBaseURL()}\n`
      + `- urlCount: ${urls.length}\n`
      + `- apiKeyName: ${initiatedBy.apiKeyName}\n`
      + `- jobId: ${newImportJob.getId()}\n`
      + `- importQueueId: ${importQueueId}\n`
      + `- hasCustomImportJs: ${!!importScript}\n`
      + `- hasCustomHeaders: ${!!customHeaders}\n`
      + `- options: ${JSON.stringify(options)}`,
    );

    // Write the import script to S3, if provided
    if (importScript) {
      await writeFileToS3('import.js', newImportJob.getId(), importScript);
    }

    // if the job type is 'xwalk', then we need to write the 3 files to S3
    if (options?.type === ImportJobModel.ImportOptionTypes.XWALK) {
      log.info('Writing component models, filters, and definitions to S3 for jobId: ', newImportJob.getId());
      await writeFileToS3('component-models.json', newImportJob.getId(), models);
      await writeFileToS3('component-filters.json', newImportJob.getId(), filters);
      await writeFileToS3('component-definition.json', newImportJob.getId(), definitions);
    }

    // Queue all URLs for import as a single message. This enables the controller to respond with
    // a job ID ASAP, while the individual URLs are queued up asynchronously by another function.
    await queueUrlsForImportWorker(urls, newImportJob, customHeaders);

    return newImportJob;
  }

  /**
   * Get an import job from the data layer. Verifies the API key to ensure it matches the one
   * used to start the job.
   * @param {string} jobId - The ID of the job.
   * @param {string} importApiKey - API key that was provided to start the job.
   * @returns {Promise<ImportJob>}
   */
  async function getImportJob(jobId, importApiKey) {
    if (!isValidUUID(jobId)) {
      throw new ErrorWithStatusCode('Job ID is required', 400);
    }

    const job = await ImportJob.findById(jobId);
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
    if (job.getStatus() !== ImportJobModel.ImportJobStatus.COMPLETE) {
      throw new ErrorWithStatusCode(`Archive not available, job status is: ${job.getStatus()}`, 404);
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

  /**
   * Get the progress of an import job.
   * @param {string} jobId - The ID of the job.
   * @param {string} importApiKey - API key that was provided to start the job.
   * @returns {Promise<{pending: number, redirect: number, completed: number, failed: number}>}
   */
  async function getImportJobProgress(jobId, importApiKey) {
    // verify that the job exists
    const job = await getImportJob(jobId, importApiKey);

    // get the url entries for the job
    const urls = await ImportUrl.allByImportJobId(job.getId());

    // merge all url entries into a single object
    return urls.reduce((acc, url) => {
      // intentionally ignore RUNNING as currently no code will flip the url to a running state
      // eslint-disable-next-line default-case
      switch (url.getStatus()) {
        case ImportJobModel.ImportUrlStatus.PENDING:
          acc.pending += 1;
          break;
        case ImportJobModel.ImportUrlStatus.REDIRECT:
          acc.redirect += 1;
          break;
        case ImportJobModel.ImportUrlStatus.COMPLETE:
          acc.completed += 1;
          break;
        case ImportJobModel.ImportUrlStatus.FAILED:
          acc.failed += 1;
          break;
      }
      return acc;
    }, {
      pending: 0,
      redirect: 0,
      completed: 0,
      failed: 0,
    });
  }

  /**
   * Delete an import job and all associated URLs.
   * @param {string} jobId - The ID of the job.
   * @param {string} importApiKey - API key provided to the delete request.
   * @returns {Promise<ImportJob>} Resolves once the deletion is complete.
   */
  async function deleteImportJob(jobId, importApiKey) {
    // Fetch the job. This also confirms the API key matches the one used to start the job.
    const job = await getImportJob(jobId, importApiKey);
    log.info(`Deletion of import job with jobId: ${jobId} invoked by hashed API key: ${hashWithSHA256(importApiKey)}`);

    return job.remove();
  }

  /**
   * Check if an import job is in a terminal state.
   * @param {object} job - The import job.
   * @returns {boolean} - true if the job is in a terminal state, false otherwise.
   */
  function isJobInTerminalState(job) {
    return job.getStatus() === ImportJobModel.ImportJobStatus.FAILED
        || job.getStatus() === ImportJobModel.ImportJobStatus.COMPLETE
        || job.getStatus() === ImportJobModel.ImportJobStatus.STOPPED;
  }

  /**
   * Stop an import job.
   * @param {string} jobId - The ID of the job.
   * @param {string} importApiKey - API key provided to the stop request.
   * @returns {Promise<void>} Resolves once the job is stopped.
   */
  async function stopImportJob(jobId, importApiKey) {
    // Fetch the job. This also confirms the API key matches the one used to start the job.
    const job = await getImportJob(jobId, importApiKey);

    // Check if the job already has a status of FAILED or COMPLETE or STOPPED
    // Do not stop a job that is already in a terminal state
    if (isJobInTerminalState(job)) {
      throw new ErrorWithStatusCode(`Job with jobId: ${jobId} cannot be stopped as it is already in a terminal state`, STATUS_BAD_REQUEST);
    }

    job.setStatus(ImportJobModel.ImportJobStatus.STOPPED);
    await job.save();

    log.info(`Stopping import job with jobId: ${jobId} invoked by hashed API key: ${hashWithSHA256(importApiKey)}`);

    log.info(`Purging the queue ${importQueueUrlPrefix}${job.getImportQueueId()} for the import job with jobId: ${jobId}`);

    await sqs.purgeQueue(`${importQueueUrlPrefix}${job.getImportQueueId()}`);

    log.info(`Import job with jobId: ${jobId} has been stopped successfully`);
  }

  return {
    startNewJob,
    getImportJob,
    getJobArchiveSignedUrl,
    getImportJobsByDateRange,
    getImportJobProgress,
    deleteImportJob,
    stopImportJob,
  };
}

export default ImportSupervisor;
