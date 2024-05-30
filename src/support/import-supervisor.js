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

import { ErrorWithStatusCode } from './utils.js';

function ImportSupervisor(services) {
  function validateServices() {
    const requiredServices = ['dataAccess', 'sqs', 's3Client', 'env', 'log'];
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
    IMPORT_QUEUES, // Comma separated list of import queues
    IMPORT_S3_BUCKET,
  } = env;
  const IMPORT_RESULT_ARCHIVE_NAME = 'import-result.zip';

  function getAvailableImportQueue() {
    const runningImportJobs = dataAccess.getAllRunningImportJobs();
    const importQueues = IMPORT_QUEUES.split(',');

    // Find an import queue that is not in use
    for (const queue of importQueues) {
      if (!runningImportJobs.includes(queue)) {
        return queue;
      }
    }
    throw new ErrorWithStatusCode('Service Unavailable: No import queue available', 503);
  }

  async function createNewImportJob(urls, importQueue, importApiKey, options) {
    // - Claim one of the free import queues
    // - Set the import-job metadata
    // - Set the status to 'running'
    const newJob = {
      urls,
      importQueue,
      importApiKey,
      options,
      status: 'running',
    };
    return dataAccess.createImportJob(newJob);
  }

  async function persistUrls(jobId, urls) {
    // - Generate a urlId guid for this single URL
    // - Set status to 'pending'
    for (const url of urls) {
      const urlRecord = {
        jobId,
        url,
        status: 'pending',
      };
      // eslint-disable-next-line no-await-in-loop
      await dataAccess.createImportUrl(urlRecord);
    }
  }

  async function startNewJob(urls, importApiKey, options) {
    log.info(`Import requested for ${urls.length} URLs, import API key: ${importApiKey}`);

    // Determine if there is a free import queue
    const importQueue = await getAvailableImportQueue();

    // If a queue is available, create the import-job record in dataAccess:
    const newImportJob = await createNewImportJob(urls, importQueue, importApiKey, options);

    // TODO: Write import.js to the S3 bucket, at {S3_BUCKET_NAME}/{jobId}/import.js
    // TODO: Custom import.js scripts are not initially supported.

    // Create 1 record per URL in the import-url table
    const urlRecords = await persistUrls(newImportJob.jobId, urls);

    // Iterate through all URLs and queue a message for each one in the (claimed) import-queue
    for (const urlRecord of urlRecords) {
      const message = {
        jobId: newImportJob.jobId,
        urlId: urlRecord.urlId,
        url: urlRecord.url,
      };
      // eslint-disable-next-line no-await-in-loop
      await sqs.sendMessage(importQueue, message);
    }

    return newImportJob;
  }

  // eslint-disable-next-line no-unused-vars
  async function getJobStatus(jobId) {
    return {};
  }

  // eslint-disable-next-line no-unused-vars
  async function getJobArchiveStream(jobId, importApiKey) {
    // Read a file from s3 then return it
    try {
      // TODO: read the import job record first to confirm that the import API key matches

      const key = `${jobId}/${IMPORT_RESULT_ARCHIVE_NAME}`;
      return s3Client.getObject({ Bucket: IMPORT_S3_BUCKET, Key: key }).createReadStream();
    } catch (err) {
      log.error('getJobArchive request failed.', err);
      throw new ErrorWithStatusCode('Error occurred reading job archive file from S3', 500);
    }
  }

  return {
    startNewJob,
    getJobStatus,
    getJobArchiveStream,
  };
}

export default ImportSupervisor;
