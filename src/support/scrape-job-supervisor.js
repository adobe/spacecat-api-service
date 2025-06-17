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

import { ScrapeJob as ScrapeJobModel } from '@adobe/spacecat-shared-data-access';
import { isValidUUID } from '@adobe/spacecat-shared-utils';

import { ErrorWithStatusCode } from './utils.js';

/**
 * Scrape Supervisor provides functionality to start and manage scrape jobs.
 * @param {object} services - The services required by the handler.
 * @param {DataAccess} services.dataAccess - Data access.
 * @param {object} services.sqs - AWS Simple Queue Service client.
 * @param {object} services.s3 - AWS S3 client and related helpers.
 * @param {object} services.log - Logger.
 * @param {object} config - Scrape configuration details.
 * @param {Array<string>} config.queues - Array of available scrape queues.
 * @param {string} config.scrapeWorkerQueue - URL of the scrape worker queue.
 * @param {string} config.s3Bucket - S3 bucket name where scrape artifacts will be stored.
 * @returns {object} Scrape Supervisor.
 */
function ScrapeJobSupervisor(services, config) {
  function validateServices() {
    const requiredServices = ['dataAccess', 'sqs', 'log'];
    requiredServices.forEach((service) => {
      if (!services[service]) {
        throw new Error(`Invalid services: ${service} is required`);
      }
    });
  }

  validateServices();
  const {
    dataAccess, sqs, log,
  } = services;

  const { ScrapeJob } = dataAccess;

  const {
    queues = [], // Array of scrape queues
    scrapeWorkerQueue, // URL of the scrape worker queue
  } = config;

  /**
   * Get the queue with the least number of messages.
   */
  async function getAvailableScrapeQueue() {
    const countMessages = async (queue) => {
      const count = await sqs.getQueueMessageCount(queue);
      return { queue, count };
    };

    const arrProm = queues.map(
      (queue) => countMessages(queue),
    );
    const queueMessageCounts = await Promise.all(arrProm);

    if (queueMessageCounts.length === 0) {
      return null;
    }

    // get the queue with the lowest number of messages
    const queueWithLeastMessages = queueMessageCounts.reduce(
      (min, current) => (min.count < current.count ? min : current),
    );
    log.info(`Queue with least messages: ${queueWithLeastMessages.queue}`);
    return queueWithLeastMessages.queue;
  }

  function determineBaseURL(urls) {
    // Initially, we will just use the domain of the first URL
    const url = new URL(urls[0]);
    return `${url.protocol}//${url.hostname}`;
  }

  /**
   * Create a new scrape job by claiming one of the free scrape queues, persisting the scrape job
   * metadata, and setting the job status to 'RUNNING'.
   * @param {Array<string>} urls - The list of URLs to scrape.
   * @param {string} scrapeQueueId - Name of the queue to use for this scrape job.
   * @param {string} processingType - The scrape handler to be used for the scrape job.
   * @param {object} options - Client provided options for the scrape job.
   * @param {object} customHeaders - Custom headers to be sent with each request.
   * @returns {Promise<ScrapeJob>}
   */
  async function createNewScrapeJob(
    urls,
    scrapeQueueId,
    processingType,
    options,
    customHeaders = null,
  ) {
    const jobData = {
      baseURL: determineBaseURL(urls),
      scrapeQueueId,
      processingType,
      options,
      urlCount: urls.length,
      status: ScrapeJobModel.ScrapeJobStatus.RUNNING,
      customHeaders,
    };
    log.info(`Creating a new scrape job. Job data: ${JSON.stringify(jobData)}`);
    return ScrapeJob.create(jobData);
  }

  /**
   * Get all scrape jobs between the specified start and end dates.
   * @param {string} startDate - The start date of the range.
   * @param {string} endDate - The end date of the range.
   * @returns {Promise<ScrapeJob[]>}
   */
  async function getScrapeJobsByDateRange(startDate, endDate) {
    return ScrapeJob.allByDateRange(startDate, endDate);
  }

  /**
   * Queue all URLs as a single message for processing by another function. This will enable
   * the controller to respond with a new job ID ASAP, while the individual URLs are queued up
   * asynchronously.
   * @param {Array<string>} urls - Array of URL records to queue.
   * @param {object} scrapeJob - The scrape job record.
   * @param {object} customHeaders - Optional custom headers to be sent with each request.
   */
  async function queueUrlsForScrapeWorker(urls, scrapeJob, customHeaders) {
    log.info(`Starting a new scrape job of baseUrl: ${scrapeJob.getBaseURL()} with ${urls.length}`
      + ` URLs. This new job has claimed: ${scrapeJob.getScrapeQueueId()} `
      + `(jobId: ${scrapeJob.getId()})`);

    const options = scrapeJob.getOptions();
    const processingType = scrapeJob.getProcessingType();

    // Send a single message containing all URLs and the new job ID
    const message = {
      processingType,
      jobId: scrapeJob.getId(),
      urls,
      customHeaders,
      options,
    };

    await sqs.sendMessage(scrapeWorkerQueue, message);
  }

  /**
   * Starts a new scrape job.
   * @param {Array<string>} urls - The URLs to scrape.
   * @param {object} options - Optional configuration params for the scrape job.
   * @param {object} customHeaders - Optional custom headers to be sent with each request.
   * @returns {Promise<ScrapeJob>}
   */
  async function startNewJob(
    urls,
    processingType,
    options,
    customHeaders,
  ) {
    const baseURL = determineBaseURL(urls);
    // Determine if there is a free scrape queue
    const scrapeQueueId = await getAvailableScrapeQueue(baseURL);

    if (scrapeQueueId === null) {
      throw new ErrorWithStatusCode('Service Unavailable: No scrape queue available', 503);
    }

    // If a queue is available, create the scrape-job record in dataAccess:
    const newScrapeJob = await createNewScrapeJob(
      urls,
      scrapeQueueId,
      processingType,
      options,
      customHeaders,
    );

    log.info(
      'New scrape job created:\n'
      + `- baseUrl: ${newScrapeJob.getBaseURL()}\n`
      + `- urlCount: ${urls.length}\n`
      + `- jobId: ${newScrapeJob.getId()}\n`
      + `- scrapeQueueId: ${scrapeQueueId}\n`
      + `- customHeaders: ${JSON.stringify(customHeaders)}\n`
      + `- options: ${JSON.stringify(options)}`,
    );

    // Queue all URLs for scrape as a single message. This enables the controller to respond with
    // a job ID ASAP, while the individual URLs are queued up asynchronously by another function.
    await queueUrlsForScrapeWorker(urls, newScrapeJob, customHeaders);

    return newScrapeJob;
  }

  /**
   * Get an scrape job from the data layer.
   * used to start the job.
   * @param {string} jobId - The ID of the job.
   * @returns {Promise<ScrapeJob>}
   */
  async function getScrapeJob(jobId) {
    if (!isValidUUID(jobId)) {
      throw new ErrorWithStatusCode('Job ID is required', 400);
    }

    return ScrapeJob.findById(jobId);
  }

  // /**
  //  * Get the progress of an import job.
  //  * @param {string} jobId - The ID of the job.
  //  * @returns {Promise<{pending: number, redirect: number, completed: number, failed: number}>}
  //  */
  // async function getScrapeJobProgress(jobId) {
  //   // verify that the job exists
  //   const job = await getScrapeJob(jobId);

  //   // get the url entries for the job
  //   const urls = await ScrapeUrl.allByScrapeJobId(job.getId());

  //   // merge all url entries into a single object
  //   return urls.reduce((acc, url) => {
  //     // intentionally ignore RUNNING as currently no code will flip the url to a running state
  //     // eslint-disable-next-line default-case
  //     switch (url.getStatus()) {
  //       case ScrapeJobModel.ScrapeUrlStatus.PENDING:
  //         acc.pending += 1;
  //         break;
  //       case ScrapeJobModel.ScrapeUrlStatus.REDIRECT:
  //         acc.redirect += 1;
  //         break;
  //       case ScrapeJobModel.ScrapeUrlStatus.COMPLETE:
  //         acc.completed += 1;
  //         break;
  //       case ScrapeJobModel.ScrapeUrlStatus.FAILED:
  //         acc.failed += 1;
  //         break;
  //     }
  //     return acc;
  //   }, {
  //     pending: 0,
  //     redirect: 0,
  //     completed: 0,
  //     failed: 0,
  //   });
  // }

  // /**
  //  * Delete an scrape job and all associated URLs.
  //  * @param {string} jobId - The ID of the job.
  //  * @returns {Promise<ScrapeJob>} Resolves once the deletion is complete.
  //  */
  // async function deleteScrapeJob(jobId) {
  //   // Fetch the job.
  //   const job = await getScrapeJob(jobId);
  //   log.info(`Deletion of scrape job with jobId: ${jobId}`);

  //   return job.remove();
  // }

  return {
    startNewJob,
    getScrapeJob,
    getScrapeJobsByDateRange,
    // getScrapeJobProgress,
    // deleteScrapeJob,
  };
}

export default ScrapeJobSupervisor;
