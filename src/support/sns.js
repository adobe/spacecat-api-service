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
import {
  SNSClient,
  PublishCommand,
  CreateTopicCommand,
  GetTopicAttributesCommand,
} from "@aws-sdk/client-sns";

/**
 * @class SNS utility to publish messages to SNS
 * @param {string} region - AWS region
 * @param {object} log - log object (expects .debug() / .error())
 */
export class SNS {
  /** @type {Map<string, Promise<string>>} */
  #namedTopicArns = new Map();

  constructor(region, log) {
    this.snsClient = new SNSClient({ region });
    this.log = log;
  }

  /**
   * Publish a message to the specified SNS topic.
   *
   * @param {string} topicNameOrArn - Topic name (standard or FIFO, e.g. "my-topic.fifo") or full ARN
   * @param {object} message - The message payload (will be JSON.stringified)
   * @param {object} [options]
   * @param {string} [options.messageGroupId] - Required for FIFO topics
   * @param {string} [options.messageDeduplicationId] - Optional for FIFO topics (if content-based dedup is disabled)
   * @param {Record<string,{DataType:'String'|'Number'|'Binary',StringValue?:string,BinaryValue?:Uint8Array}>} [options.messageAttributes]
   * @returns {Promise<void>}
   */
  async publish(topicNameOrArn, message, options = {}) {
    const body = {
      ...message,
      timestamp: new Date().toISOString(),
    };

    const topicArn = await this.#toTopicArn(topicNameOrArn);

    const cmd = new PublishCommand({
      TopicArn: topicArn,
      Message: JSON.stringify(body),
      // FIFO-only fields (safe to pass undefined for standard topics)
      MessageGroupId: options.messageGroupId,
      MessageDeduplicationId: options.messageDeduplicationId,
      MessageAttributes: options.messageAttributes,
    });

    try {
      const data = await this.snsClient.send(cmd);
      this.log.debug(
        `Success, message published. MessageId: ${data.MessageId}`,
      );
    } catch (e) {
      const { name: type, $metadata, message: msg } = e;
      this.log.error(
        `Publish failed. Type: ${type}, HTTP: ${$metadata?.httpStatusCode}, Message: ${msg}`,
      );
      throw e;
    }
  }

  /**
   * Resolve a topic ARN from a name or pass through if already an ARN.
   * Uses CreateTopic for idempotent name->ARN resolution (works for both standard and FIFO).
   *
   * @param {string} topicNameOrArn
   * @returns {Promise<string>} Topic ARN
   */
  async #toTopicArn(topicNameOrArn) {
    if (typeof topicNameOrArn !== "string") {
      throw new Error("topicNameOrArn must be a string");
    }
    // Quick ARN check
    if (topicNameOrArn.startsWith("arn:aws:sns:")) {
      return topicNameOrArn;
    }

    let cached = this.#namedTopicArns.get(topicNameOrArn);
    if (!cached) {
      cached = this.#createOrGetTopicArn(topicNameOrArn);
      this.#namedTopicArns.set(topicNameOrArn, cached);
    }
    return cached;
  }

  /**
   * CreateTopic is idempotent. For FIFO topics, ensure the name ends with ".fifo".
   * You may also pass attributes like FifoTopic=true for FIFO.
   *
   * @param {string} topicName
   * @returns {Promise<string>}
   */
  async #createOrGetTopicArn(topicName) {
    const isFifo = topicName.endsWith(".fifo");
    const create = new CreateTopicCommand({
      Name: topicName,
      Attributes: isFifo ? { FifoTopic: "true" } : undefined,
    });

    const res = await this.snsClient.send(create);
    const arn = res.TopicArn;
    if (!arn || !arn.startsWith("arn:aws:sns:")) {
      throw new Error(`Unknown topic name: ${topicName}`);
    }
    return arn;
  }

  /**
   * Example helper similar to getQueueMessageCount (SNS doesn’t have a queue depth),
   * but you can fetch attributes if useful (e.g., display name).
   * @param {string} topicNameOrArn
   * @returns {Promise<Record<string,string>>}
   */
  async getTopicAttributes(topicNameOrArn) {
    const TopicArn = await this.#toTopicArn(topicNameOrArn);
    const cmd = new GetTopicAttributesCommand({ TopicArn });
    const res = await this.snsClient.send(cmd);
    return res.Attributes ?? {};
  }
}

/**
 * Wrapper to attach SNS to your context, mirroring your sqsWrapper ergonomics.
 */
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
