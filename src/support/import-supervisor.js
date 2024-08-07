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
 * @param {string} config.queueUrlPrefix - URL prefix for the import queues.
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
    queueUrlPrefix,
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
      if (job.getApiKey() === importApiKey) {
        throw new ErrorWithStatusCode(`Too Many Requests: API key ${importApiKey} cannot be used to start any more import jobs`, 429);
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
  async function createNewImportJob(urls, importQueueId, apiKey, options) {
    const newJob = {
      id: crypto.randomUUID(),
      baseURL: determineBaseURL(urls),
      importQueueId,
      apiKey,
      options,
      urlCount: urls.length,
      status: ImportJobStatus.RUNNING,
    };
    return dataAccess.createNewImportJob(newJob);
  }

  /**
   * Persist the URLs to import in the data layer, each as an import URL record.
   */
  async function persistUrls(jobId, urls) {
    // - Generate a urlId guid for this single URL
    // - Set status to 'pending'
    const urlRecords = [];
    for (const url of urls) {
      const urlRecord = {
        id: crypto.randomUUID(),
        jobId,
        url,
        status: 'PENDING',
      };
      // eslint-disable-next-line no-await-in-loop
      urlRecords.push(await dataAccess.createNewImportUrl(urlRecord));
    }
    return urlRecords;
  }

  /**
   * Queue each URL for import in the queue which has been claimed for the job. Each URL will be
   * queued as a single self-contained message along with the job details and import options.
   * @param {Array<object>} urlRecords - Array of URL records to queue.
   * @param {object} importJob - The import job record.
   * @param {string} importQueueId - The ID of the claimed import queue to use.
   */
  async function queueUrlsForImport(urlRecords, importJob, importQueueId) {
    log.info(`Queuing ${urlRecords.length} URLs for import in queue: ${importQueueId} (jobId: ${importJob.getId()}, baseUrl: ${importJob.getBaseURL()})`);
    // Iterate through all URLs and queue a message for each one in the (claimed) import queue
    for (const urlRecord of urlRecords) {
      const message = {
        processingType: 'import',
        jobId: importJob.getId(),
        options: importJob.getOptions(),
        urls: [
          {
            urlId: urlRecord.getId(),
            url: urlRecord.getUrl(),
            status: urlRecord.getStatus(),
          },
        ],
      };
      // eslint-disable-next-line no-await-in-loop
      await sqs.sendMessage(queueUrlPrefix + importQueueId, message);
    }
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
  async function startNewJob(urls, importApiKey, options, importScript) {
    log.info(`Import requested for ${urls.length} URLs, using import API key: ${importApiKey}`);

    // Determine if there is a free import queue
    const importQueueId = await getAvailableImportQueue(importApiKey);

    // If a queue is available, create the import-job record in dataAccess:
    const newImportJob = await createNewImportJob(urls, importQueueId, importApiKey, options);

    log.info(`New import job created for API key: ${importApiKey} with jobId: ${newImportJob.getId()}, baseUrl: ${newImportJob.getBaseURL()}, claiming importQueueId: ${importQueueId}`);

    // Custom import.js scripts are not initially supported.
    if (importScript) {
      await writeImportScriptToS3(newImportJob.getId(), importScript);
    }

    // Create 1 record per URL in the import-url table
    const urlRecords = await persistUrls(newImportJob.getId(), urls);

    // Queue all URLs for import
    await queueUrlsForImport(urlRecords, newImportJob, importQueueId);

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
    // Job must exist, and the import API key must match the one provided
    if (!job || job.getApiKey() !== importApiKey) {
      throw new ErrorWithStatusCode('Not found', 404);
    }

    return job;
  }

  /**
   * Gets the Api Key metadata based on the hashed key.
   * @param hashedKey
   * @return {Promise<null|{name: *, imsUserId: *, imsOrgId: *}>}
   */
  async function getApiKeyMetadata(hashedApiKey) {
    const metadata = await dataAccess.getApiKeyByHashedKey(hashedApiKey);
    if (metadata) {
      return {
        imsOrgId: metadata.imsOrgId,
        name: metadata.name,
        imsUserId: metadata.imsUserId,
      };
    }
    return null;
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
    getApiKeyMetadata,
  };
}

export default ImportSupervisor;
