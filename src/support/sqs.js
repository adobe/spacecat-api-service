/*
 * Copyright 2023 Adobe. All rights reserved.
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
  SendMessageCommand, SQSClient, PurgeQueueCommand, GetQueueUrlCommand,
} from '@aws-sdk/client-sqs';

/**
 * @class SQS utility to send messages to SQS
 * @param {string} region - AWS region
 * @param {object} log - log object
 */
export class SQS {
  /** @type {Map<string, Promise<string>>} */
  #namedQueueURLs = new Map();

  constructor(region, log) {
    this.sqsClient = new SQSClient({ region });
    this.log = log;
  }

  /**
   * Send a message to the specified SQS queue.
   *
   * @param {string|URL} queueNameOrUrl - The name or URL of the SQS queue.
   * @param {object} message - The message to send.
   * @returns {Promise<void>} - Promise that resolves when the message is sent.
   */
  async sendMessage(queueNameOrUrl, message) {
    const body = {
      ...message,
      timestamp: new Date().toISOString(),
    };

    const queueUrl = await this.#toQueueUrl(queueNameOrUrl);
    const msgCommand = new SendMessageCommand({
      MessageBody: JSON.stringify(body),
      QueueUrl: queueUrl,
    });

    try {
      const data = await this.sqsClient.send(msgCommand);
      this.log.info(`Success, message sent. MessageID:  ${data.MessageId}`);
    } catch (e) {
      const { type, code, message: msg } = e;
      this.log.error(`Message sent failed. Type: ${type}, Code: ${code}, Message: ${msg}`);
      throw e;
    }
  }

  /**
   * Purge the queue identified by its queueUrl.
   * @param {string} queueNameOrUrl - The name or URL of the queue to be purged.
   * @returns {Promise<void>} - Promise that resolves when the queue is purged
   */
  async purgeQueue(queueNameOrUrl) {
    const queueUrl = await this.#toQueueUrl(queueNameOrUrl);
    const purgeQueueCommand = new PurgeQueueCommand({ QueueUrl: queueUrl });

    try {
      await this.sqsClient.send(purgeQueueCommand);
      this.log.info(`Success, queue purged. QueueUrl: ${queueUrl}`);
    } catch (e) {
      const { type, code, message: msg } = e;
      this.log.error(`Queue purge failed. Type: ${type}, Code: ${code}, Message: ${msg}`);
      throw e;
    }
  }

  /**
   * Retrieve the URL for a queue if it's not a URL already.
   *
   * If a queue name is passed in rather than a URL, the URL for that queue is retrieved
   * from AWS and returned.
   * @param {string|URL} queueNameOrUrl - The name or URL of the queue.
   * @returns {Promise<string>} - The URL of the queue.
   */
  async #toQueueUrl(queueNameOrUrl) {
    if (typeof queueNameOrUrl !== 'string' || URL.canParse(queueNameOrUrl)) {
      return String(queueNameOrUrl);
    }

    const namedQueueURLs = this.#namedQueueURLs;
    let queueUrl = namedQueueURLs.get(queueNameOrUrl);
    if (!queueUrl) {
      queueUrl = this.#retrieveQueueUrl(queueNameOrUrl);
      namedQueueURLs.set(queueNameOrUrl, queueUrl);
    }

    return queueUrl;
  }

  /**
   * Retrieve the URL for a queue by its name.
   *
   * @param {string} queueName - The name of the queue.
   * @returns {Promise<string>} - The URL of the queue.
   */
  async #retrieveQueueUrl(queueName) {
    const response = await this.sqsClient.send(new GetQueueUrlCommand({ QueueName: queueName }));
    const url = response.QueueUrl;
    if (!url || !URL.canParse(url)) {
      throw new Error(`Unknown queue name: ${queueName}`);
    }
    return url;
  }
}

export default function sqsWrapper(fn) {
  return async (request, context) => {
    if (!context.sqs) {
      const { log } = context;
      const { region } = context.runtime;
      context.sqs = new SQS(region, log);
    }

    return fn(request, context);
  };
}
