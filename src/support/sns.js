/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';

/**
 * @class SNS utility to publish messages to SNS topics.
 * @param {string} region - AWS region.
 * @param {object} log - Logger object.
 */
export class SNS {
  constructor(region, log) {
    this.snsClient = new SNSClient({ region });
    this.log = log;
  }

  /**
   * Publish a message to an SNS topic ARN.
   *
   * @param {string} topicArn - SNS topic ARN (must be pre-provisioned).
   * @param {object} message - Message payload.
   * @param {object} [options] - Optional publish options.
   * @param {string} [options.messageGroupId] - FIFO topic group id.
   * @param {string} [options.messageDeduplicationId] - FIFO deduplication id.
   * @returns {Promise<void>} Promise that resolves when publish succeeds.
   */
  async publish(topicArn, message, options = {}) {
    if (typeof topicArn !== 'string' || !topicArn.startsWith('arn:aws:sns:')) {
      throw new Error('topicArn must be a valid SNS topic ARN');
    }

    const cmd = new PublishCommand({
      TopicArn: topicArn,
      Message: JSON.stringify(message),
      MessageGroupId: options.messageGroupId,
      MessageDeduplicationId: options.messageDeduplicationId,
    });

    try {
      const data = await this.snsClient.send(cmd);
      this.log.debug(`Success, message published. MessageId: ${data.MessageId}`);
    } catch (e) {
      const { name: type, $metadata, message: msg } = e;
      this.log.error(`Publish failed. Type: ${type}, HTTP: ${$metadata?.httpStatusCode}, Message: ${msg}`);
      throw e;
    }
  }
}

export default function snsWrapper(fn) {
  return async (request, context) => {
    if (!context.sns) {
      const { log } = context;
      const { region } = context.runtime;
      context.sns = new SNS(region, log);
    }

    return fn(request, context);
  };
}
