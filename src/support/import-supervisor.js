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

function ImportSupervisor(services) {
  function validateServices() {
    const requiredServices = ['log', 'sqsClient', 's3Client'];
    requiredServices.forEach((service) => {
      if (!services[service]) {
        throw new Error(`Invalid services: ${service} is required`);
      }
    });
  }

  validateServices();
  // eslint-disable-next-line no-unused-vars
  const { log, sqsClient, s3Client } = services;

  // eslint-disable-next-line no-unused-vars
  async function startNewJob(urls, importApiKey, options) {
    log.info(`Import requested with ${urls.length} URLs and import API key: ${importApiKey}`);

    // Query data access for all 'running' import jobs
    // Determine if there is a free import queue

    // If no queue is available, throw new Error('Service Unavailable: No import queue available')

    // If a queue is available, create the import-job record in dataAccess:
    // - Generate a jobId guid for this job
    // - Claim one of the free import queues
    // - Set the import-job metadata
    // - Set the status to 'running'

    // Write import.js to the S3 bucket, at {S3_BUCKET_NAME}/{jobId}/import.js

    // Create 1 record per URL in the import-url table
    // - Generate a urlId guid for this single URL
    // - Set status to 'pending'

    // Iterate through all URLs and queue a message for each one in the (claimed) import-queue
    // Each message must contain:
    // - urlId
    // - jobId
    // - options
    // - urls (with the single URL as the only element)

    return {};
  }

  // eslint-disable-next-line no-unused-vars
  async function getJobStatus(jobId) {
    return {};
  }

  // eslint-disable-next-line no-unused-vars
  async function getJobArchive(jobId) {
    return {};
  }

  return {
    startNewJob,
    getJobStatus,
    getJobArchive,
  };
}

export default ImportSupervisor;
