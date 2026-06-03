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
  badRequest,
  createResponse,
  forbidden,
  notFound,
  ok,
} from '@adobe/spacecat-shared-http-utils';
import { hasText, isNonEmptyObject } from '@adobe/spacecat-shared-utils';
import { Consumer as ConsumerModel } from '@adobe/spacecat-shared-data-access';

import { BaseSlackClient, SLACK_TARGETS } from '@adobe/spacecat-shared-slack-client';
import {
  STATUS_BAD_REQUEST,
  STATUS_CREATED,
  STATUS_INTERNAL_SERVER_ERROR,
} from '../utils/constants.js';

import { ErrorWithStatusCode } from '../support/utils.js';
import { ConsumerDto } from '../dto/consumer.js';
import AccessControlUtil from '../support/access-control-util.js';

const HEADER_ERROR = 'x-error';
const IMS_TA_TOKEN_HEADER = 'x-ta-access-token';
const IMMUTABLE_FIELDS = ['clientId', 'technicalAccountId', 'imsOrgId'];
const UPDATABLE_STATUSES = Object.values(ConsumerModel.STATUS)
  .filter((s) => s !== ConsumerModel.STATUS.REVOKED);

function getHeaderCaseInsensitive(headers, name) {
  const lower = name.toLowerCase();
  const key = Object.keys(headers).find((k) => k.toLowerCase() === lower);
  return key ? headers[key] : undefined;
}

function validateCapabilities(Consumer, capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new ErrorWithStatusCode('capabilities must be a non-empty array', STATUS_BAD_REQUEST);
  }
  const invalidElement = capabilities.find((c) => typeof c !== 'string' || !hasText(c));
  if (invalidElement !== undefined) {
    throw new ErrorWithStatusCode(
      'All capability elements must be non-empty strings in entity:operation format (e.g. site:read)',
      STATUS_BAD_REQUEST,
    );
  }
  try {
    Consumer.validateCapabilities(capabilities);
  } catch (validationErr) {
    throw new ErrorWithStatusCode(validationErr.message, STATUS_BAD_REQUEST);
  }
}

function createErrorResponse(error) {
  const statusCode = error.status || STATUS_INTERNAL_SERVER_ERROR;
  return createResponse(
    { message: error.message },
    statusCode,
    { [HEADER_ERROR]: error.message },
  );
}

/**
 * Consumers Controller. Provides methods for managing API consumers
 * (Technical Accounts) such as register, list, get, and update.
 *
 * @param {object} ctx - Context of the universal serverless function.
 * @returns {object} Consumers controller.
 * @constructor
 */
function ConsumersController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }

  const { dataAccess, log, imsClient } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  const { Consumer } = dataAccess;

  const accessControlUtil = AccessControlUtil.fromContext(ctx);
  const { authInfo } = ctx.attributes;

  function getUpdatedBy() {
    const profile = authInfo.getProfile();
    const email = profile?.email;
    if (!hasText(email)) {
      log.warn('Auth profile lacks email; using updatedBy fallback for audit trail');
      return 'system';
    }
    return email;
  }

  async function notifySlack(message) {
    const channelId = ctx.env?.S2S_SLACK_CHANNEL_ID;
    if (!hasText(channelId)) {
      log.warn('S2S_SLACK_CHANNEL_ID is not configured; skipping Slack notification');
      return;
    }
    try {
      const slackClient = BaseSlackClient.createFrom(
        ctx,
        SLACK_TARGETS.WORKSPACE_INTERNAL,
      );
      await slackClient.postMessage({
        channel: channelId,
        text: message,
      });
    } catch (e) {
      log.error(`Failed to send Slack notification: ${e.message}`);
    }
  }

  /**
   * Returns all registered consumers.
   * Restricted to admin users.
   * @returns {Promise<Response>} 200 with list of consumers.
   */
  const getAll = async () => {
    if (!accessControlUtil.hasS2SAdminAccess()) {
      return forbidden('Only S2S admins can list consumers');
    }

    try {
      const consumers = await Consumer.all();
      return ok(consumers.map(ConsumerDto.toJSON));
    } catch (error) {
      log.error(`Failed to list consumers: ${error.message}`);
      return createErrorResponse(
        new ErrorWithStatusCode('Failed to retrieve consumers', STATUS_INTERNAL_SERVER_ERROR),
      );
    }
  };

  /**
   * Returns a single consumer by consumerId.
   *
   * @param {object} context - Request context.
   * @returns {Promise<Response>} 200 with consumer data or 404 if not found.
   */
  const getByConsumerId = async (context) => {
    if (!accessControlUtil.hasS2SAdminAccess()) {
      return forbidden('Only S2S admins can view consumers');
    }

    const { consumerId } = context.params;

    if (!hasText(consumerId)) {
      return badRequest('consumerId is required');
    }

    try {
      const consumer = await Consumer.findById(consumerId);
      if (!consumer) {
        return notFound('Consumer not found');
      }

      return ok(ConsumerDto.toJSON(consumer));
    } catch (error) {
      log.error(`Failed to get consumer ${consumerId}: ${error.message}`);
      return createErrorResponse(
        new ErrorWithStatusCode('Failed to retrieve consumer', STATUS_INTERNAL_SERVER_ERROR),
      );
    }
  };

  /**
   * Returns a single consumer by clientId (IMS OAuth client_id).
   *
   * @param {object} context - Request context.
   * @returns {Promise<Response>} 200 with consumer data or 404 if not found.
   */
  const getByClientId = async (context) => {
    if (!accessControlUtil.hasS2SAdminAccess()) {
      return forbidden('Only S2S admins can view consumers');
    }

    const { clientId } = context.params;

    if (!hasText(clientId)) {
      return badRequest('clientId is required');
    }

    try {
      const consumer = await Consumer.findByClientId(clientId);
      if (!consumer) {
        return notFound('Consumer not found');
      }

      return ok(ConsumerDto.toJSON(consumer));
    } catch (error) {
      log.error(`Failed to get consumer by clientId ${clientId}: ${error.message}`);
      return createErrorResponse(
        new ErrorWithStatusCode('Failed to retrieve consumer', STATUS_INTERNAL_SERVER_ERROR),
      );
    }
  };

  /**
   * Registers a new consumer by validating the provided IMS access token
   * and extracting the Technical Account identity (clientId, technicalAccountId, imsOrgId).
   * The access token must be provided via the x-ta-access-token header (avoids body logging).
   *
   * Known limitation: TOCTOU race — a concurrent request could register the same clientId
   * between the duplicate check and the create. The data layer also performs this check
   * but has no database-level unique constraint on clientId. A unique constraint on
   * clientId in the data layer would be the proper guard. Until then, duplicate creation
   * is possible under concurrent registration of the same clientId.
   *
   * @param {object} context - Request context.
   * @returns {Promise<Response>} 201 with the newly registered consumer.
   */
  const register = async (context) => {
    if (!accessControlUtil.hasS2SAdminAccess()) {
      return forbidden('Only S2S admins can register consumers');
    }

    const { data } = context;

    try {
      if (!isNonEmptyObject(data)) {
        throw new ErrorWithStatusCode('Request body is required', STATUS_BAD_REQUEST);
      }

      const headers = context.pathInfo?.headers || {};
      const accessToken = getHeaderCaseInsensitive(headers, IMS_TA_TOKEN_HEADER);
      const { consumerName, capabilities } = data;
      log.info(`Register consumer request: consumerName=${consumerName}`);

      if (!hasText(accessToken)) {
        throw new ErrorWithStatusCode(
          'Technical Account access token is required. Provide it via the x-ta-access-token header.',
          STATUS_BAD_REQUEST,
        );
      }
      if (!hasText(consumerName)) {
        throw new ErrorWithStatusCode('consumerName is required', STATUS_BAD_REQUEST);
      }
      validateCapabilities(Consumer, capabilities);

      let tokenPayload;
      try {
        tokenPayload = await imsClient.validateAccessToken(accessToken);
      } catch (e) {
        log.error(`IMS token validation failed: ${e.message}`);
        throw new ErrorWithStatusCode(
          'Invalid or expired Technical Account access token',
          STATUS_BAD_REQUEST,
        );
      }

      if (!tokenPayload?.token) {
        throw new ErrorWithStatusCode(
          'IMS validation response does not contain token data',
          STATUS_BAD_REQUEST,
        );
      }

      const {
        client_id: clientId,
        user_id: technicalAccountId,
        org: imsOrgId,
      } = tokenPayload.token;
      if (!hasText(clientId) || !hasText(technicalAccountId) || !hasText(imsOrgId)) {
        throw new ErrorWithStatusCode(
          'Access token does not contain required Technical Account identity fields',
          STATUS_BAD_REQUEST,
        );
      }

      const existing = await Consumer.findByClientId(clientId);
      if (existing) {
        log.info(`Consumer with clientId=${clientId} already exists, rejecting`);
        throw new ErrorWithStatusCode(
          `Consumer with clientId ${clientId} is already registered`,
          STATUS_BAD_REQUEST,
        );
      }

      const updatedBy = getUpdatedBy();
      const consumer = await Consumer.create({
        clientId,
        technicalAccountId,
        imsOrgId,
        consumerName,
        capabilities,
        status: ConsumerModel.STATUS.ACTIVE,
        updatedBy,
      });

      const safeCapabilities = capabilities.map((c) => `\`${c}\``).join(', ');
      const registerMsg = ':new: *New Consumer Registered*\n'
        + `• *Name:* \`${consumerName}\`\n`
        + `• *Client ID:* \`${clientId}\`\n`
        + `• *IMS Org:* \`${imsOrgId}\`\n`
        + `• *Capabilities:* ${safeCapabilities}\n`
        + `• *Registered by:* \`${updatedBy}\``;
      log.info(registerMsg);
      notifySlack(registerMsg);

      return createResponse(ConsumerDto.toJSON(consumer), STATUS_CREATED);
    } catch (error) {
      if (error instanceof ErrorWithStatusCode) {
        return createErrorResponse(error);
      }
      if (error?.name === 'ValidationError') {
        return badRequest(error.message);
      }
      log.error(`Failed to register consumer: ${error.message}`);
      return createErrorResponse(
        new ErrorWithStatusCode('Failed to register consumer', STATUS_INTERNAL_SERVER_ERROR),
      );
    }
  };

  /**
   * Updates a consumer identified by clientId.
   * clientId, technicalAccountId, and imsOrgId are immutable.
   * revokedAt cannot be set via update — use the revoke endpoint.
   * status cannot be set to REVOKED via update — use the revoke endpoint.
   * Revoked consumers cannot be updated.
   *
   * @param {object} context - Request context.
   * @returns {Promise<Response>} 200 with the updated consumer.
   */
  const update = async (context) => {
    if (!accessControlUtil.hasS2SAdminAccess()) {
      return forbidden('Only S2S admins can update consumers');
    }

    const { consumerId } = context.params;
    const { data } = context;

    try {
      if (!hasText(consumerId)) {
        throw new ErrorWithStatusCode('consumerId is required', STATUS_BAD_REQUEST);
      }

      if (!isNonEmptyObject(data)) {
        throw new ErrorWithStatusCode('Request body is required', STATUS_BAD_REQUEST);
      }

      const immutableViolations = IMMUTABLE_FIELDS.filter((field) => data[field] !== undefined);
      if (immutableViolations.length > 0) {
        throw new ErrorWithStatusCode(
          `The following fields are immutable and cannot be updated: ${immutableViolations.join(', ')}`,
          STATUS_BAD_REQUEST,
        );
      }

      if (data.revokedAt !== undefined) {
        throw new ErrorWithStatusCode(
          'revokedAt cannot be set via update. Use the revoke endpoint instead',
          STATUS_BAD_REQUEST,
        );
      }

      if (hasText(data.status) && !UPDATABLE_STATUSES.includes(data.status)) {
        throw new ErrorWithStatusCode(
          `Invalid status for update. Must be one of: ${UPDATABLE_STATUSES.join(', ')}`,
          STATUS_BAD_REQUEST,
        );
      }

      const consumer = await Consumer.findById(consumerId);
      if (!consumer) {
        return notFound('Consumer not found');
      }

      if (consumer.getStatus() === ConsumerModel.STATUS.REVOKED) {
        throw new ErrorWithStatusCode(
          'Cannot update a revoked consumer',
          STATUS_BAD_REQUEST,
        );
      }

      const changes = [];

      if (hasText(data.consumerName)) {
        changes.push(`  › *consumerName:* \`${consumer.getConsumerName()}\` → \`${data.consumerName}\``);
        consumer.setConsumerName(data.consumerName);
      }

      if (Array.isArray(data.capabilities)) {
        validateCapabilities(Consumer, data.capabilities);
        const oldCaps = consumer.getCapabilities().map((c) => `\`${c}\``).join(', ');
        const newCaps = data.capabilities.map((c) => `\`${c}\``).join(', ');
        changes.push(`  › *capabilities:* [${oldCaps}] → [${newCaps}]`);
        consumer.setCapabilities(data.capabilities);
      }

      if (hasText(data.status)) {
        changes.push(`  › *status:* \`${consumer.getStatus()}\` → \`${data.status}\``);
        consumer.setStatus(data.status);
      }

      const updatedBy = getUpdatedBy();
      consumer.setUpdatedBy(updatedBy);
      await consumer.save();

      const updateMsg = ':pencil2: *Consumer Updated*\n'
        + `• *Consumer ID:* \`${consumerId}\`\n`
        + `• *Changes:*\n${changes.join('\n')}\n`
        + `• *Updated by:* \`${updatedBy}\``;
      log.info(updateMsg);
      notifySlack(updateMsg);

      return ok(ConsumerDto.toJSON(consumer));
    } catch (error) {
      if (error instanceof ErrorWithStatusCode) {
        return createErrorResponse(error);
      }
      if (error?.name === 'ValidationError') {
        return badRequest(error.message);
      }
      log.error(`Failed to update consumer ${consumerId}: ${error.message}`);
      return createErrorResponse(
        new ErrorWithStatusCode('Failed to update consumer', STATUS_INTERNAL_SERVER_ERROR),
      );
    }
  };

  /**
   * Revokes a consumer identified by consumerId.
   * Sets status to REVOKED and records the revocation timestamp.
   *
   * @param {object} context - Request context.
   * @returns {Promise<Response>} 200 with the revoked consumer.
   */
  const revoke = async (context) => {
    if (!accessControlUtil.hasS2SAdminAccess()) {
      return forbidden('Only S2S admins can revoke consumers');
    }

    const { consumerId } = context.params;

    try {
      if (!hasText(consumerId)) {
        throw new ErrorWithStatusCode('consumerId is required', STATUS_BAD_REQUEST);
      }

      const consumer = await Consumer.findById(consumerId);
      if (!consumer) {
        return notFound('Consumer not found');
      }

      if (consumer.getStatus() === ConsumerModel.STATUS.REVOKED) {
        throw new ErrorWithStatusCode(
          'Consumer is already revoked',
          STATUS_BAD_REQUEST,
        );
      }

      const updatedBy = getUpdatedBy();
      consumer.setStatus(ConsumerModel.STATUS.REVOKED);
      consumer.setRevokedAt(new Date().toISOString());
      consumer.setUpdatedBy(updatedBy);

      await consumer.save();

      const revokeMsg = ':rotating_light: *Consumer Revoked*\n'
        + `• *Consumer ID:* \`${consumerId}\`\n`
        + `• *Revoked by:* \`${updatedBy}\``;
      log.info(revokeMsg);
      notifySlack(revokeMsg);

      return ok(ConsumerDto.toJSON(consumer));
    } catch (error) {
      if (error instanceof ErrorWithStatusCode) {
        return createErrorResponse(error);
      }
      log.error(`Failed to revoke consumer ${consumerId}: ${error.message}`);
      return createErrorResponse(
        new ErrorWithStatusCode('Failed to revoke consumer', STATUS_INTERNAL_SERVER_ERROR),
      );
    }
  };

  return {
    getAll,
    getByConsumerId,
    getByClientId,
    register,
    update,
    revoke,
  };
}

export default ConsumersController;
