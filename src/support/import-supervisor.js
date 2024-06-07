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

import { IMPORT_JOB_STATUS } from '@adobe/spacecat-shared-data-access/src/models/importer/import-job.js';
import { hasText } from '@adobe/spacecat-shared-utils';
import { ErrorWithStatusCode } from './utils.js';

const JOB_STATUS_RUNNING = 'RUNNING';

/**
 * Import Supervisor provides functionality to start and manage import jobs.
 * @param {object} services - The services required by the handler.
 */
function ImportSupervisor(services) {
  function validateServices() {
    const requiredServices = ['dataAccess', 'sqs', 's3', 'env', 'log'];
    requiredServices.forEach((service) => {
      if (!services[service]) {
        throw new Error(`Invalid services: ${service} is required`);
      }
    });
  }

  validateServices();
  const {
    dataAccess, sqs, s3Client, log, env,
  } = services;
  const {
    IMPORT_QUEUE_URL_PREFIX,
    IMPORT_QUEUES, // Comma separated list of import queues
    IMPORT_S3_BUCKET,
  } = env;
  const IMPORT_RESULT_ARCHIVE_NAME = 'import-result.zip';

  async function getAvailableImportQueue() {
    const runningImportJobs = await dataAccess.getImportJobsByStatus(JOB_STATUS_RUNNING);
    const importQueues = IMPORT_QUEUES.split(',');

    // Find an import queue that is not in use
    for (const queue of importQueues) {
      if (!runningImportJobs.includes(queue)) {
        return queue;
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
   * metadata, and setting the job status to 'running'.
   * @param {Array<string>} urls the list of URLs to import
   * @param {string} importQueueId the name of the queue to use for this import job
   * @param {string} apiKey the API key used to authenticate the import request
   * @param {object} options client provided options for the import job
   * @returns {Promise<*>}
   */
  async function createNewImportJob(urls, importQueueId, apiKey, options) {
    const newJob = {
      id: crypto.randomUUID(),
      baseURL: determineBaseURL(urls),
      importQueueId,
      apiKey,
      options,
      status: IMPORT_JOB_STATUS.RUNNING,
    };
    return dataAccess.createNewImportJob(newJob);
  }

  /**
   * Persist the list of URLs to import in the data layer.
   * @param {string} jobId
   * @param {Array<string>} urls
   * @returns {Promise[object]}
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
   * @param {Array<object>} urlRecords
   * @param {object} importJob
   * @param {string} importQueueId
   */
  async function queueUrlsForImport(urlRecords, importJob, importQueueId) {
    // Iterate through all URLs and queue a message for each one in the (claimed) import-queue
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
      await sqs.sendMessage(IMPORT_QUEUE_URL_PREFIX + importQueueId, message);
    }
  }

  async function startNewJob(urls, importApiKey, options) {
    log.info(`Import requested for ${urls.length} URLs, using import API key: ${importApiKey}`);

    // Determine if there is a free import queue
    const importQueueId = await getAvailableImportQueue();

    // If a queue is available, create the import-job record in dataAccess:
    const newImportJob = await createNewImportJob(urls, importQueueId, importApiKey, options);

    // Custom import.js scripts are not initially supported.
    // Future: Write import.js to the S3 bucket, at {S3_BUCKET_NAME}/{jobId}/import.js

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
      throw new ErrorWithStatusCode('Job not found', 404);
    }

    return job;
  }

  // eslint-disable-next-line no-unused-vars
  async function getJobArchiveSignedUrl(jobId, importApiKey) {
    try {
      const job = await getImportJob(jobId, importApiKey);
      const key = `${job.getId()}/${IMPORT_RESULT_ARCHIVE_NAME}`;
      return s3Client.getObject({ Bucket: IMPORT_S3_BUCKET, Key: key }).createReadStream();
    } catch (err) {
      log.error('getJobArchive request failed.', err);
      throw new ErrorWithStatusCode('Error occurred reading job archive file from S3', 500);
    }
  }

  return {
    startNewJob,
    getImportJob,
    getJobArchiveSignedUrl,
  };
}

export default ImportSupervisor;
