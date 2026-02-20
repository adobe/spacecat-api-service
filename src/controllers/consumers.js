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
const IMMUTABLE_FIELDS = ['clientId', 'technicalAccountId', 'imsOrgId'];
const UPDATABLE_STATUSES = Object.values(ConsumerModel.STATUS)
  .filter((s) => s !== ConsumerModel.STATUS.REVOKED);

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
    return profile?.email || 'system';
  }

  async function notifySlack(message) {
    try {
      const slackClient = BaseSlackClient.createFrom(
        ctx,
        SLACK_TARGETS.WORKSPACE_INTERNAL,
      );
      const SLACK_CHANNEL_ID = ctx.env.S2S_SLACK_CHANNEL_ID;
      await slackClient.postMessage({
        channel: SLACK_CHANNEL_ID,
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
    const { consumerId } = context.params;

    if (!hasText(consumerId)) {
      return badRequest('consumerId is required');
    }

    try {
      const consumer = await Consumer.findById(consumerId);
      if (!consumer) {
        return notFound(`Consumer with consumerId ${consumerId} not found`);
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
    const { clientId } = context.params;

    if (!hasText(clientId)) {
      return badRequest('clientId is required');
    }

    try {
      const consumer = await Consumer.findByClientId(clientId);
      if (!consumer) {
        return notFound(`Consumer with clientId ${clientId} not found`);
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

      const { accessToken, consumerName, capabilities } = data;
      log.info(`Register consumer request: consumerName=${consumerName}`);

      if (!hasText(accessToken)) {
        throw new ErrorWithStatusCode('accessToken is required', STATUS_BAD_REQUEST);
      }
      if (!hasText(consumerName)) {
        throw new ErrorWithStatusCode('consumerName is required', STATUS_BAD_REQUEST);
      }
      if (!Array.isArray(capabilities) || capabilities.length === 0) {
        throw new ErrorWithStatusCode('capabilities must be a non-empty array', STATUS_BAD_REQUEST);
      }

      log.info('Validating TA access token with IMS');
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

      log.info(`IMS validateAccessToken response: ${JSON.stringify(tokenPayload)}`);

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
      log.info(`Token resolved: clientId=${clientId}, imsOrgId=${imsOrgId}`);

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

      log.info(`Creating consumer: clientId=${clientId}, consumerName=${consumerName}`);
      const consumer = await Consumer.create({
        clientId,
        technicalAccountId,
        imsOrgId,
        consumerName,
        capabilities,
        status: ConsumerModel.STATUS.ACTIVE,
        updatedBy: getUpdatedBy(),
      });

      const registerMsg = 'A new consumer registered:'
        + ` clientId=${clientId}, consumerName=${consumerName},`
        + ` imsOrgId=${imsOrgId},`
        + ` capabilities=[${capabilities.join(', ')}],`
        + ` by=${getUpdatedBy()}`;
      log.info(registerMsg);
      await notifySlack(registerMsg);

      return createResponse(ConsumerDto.toJSON(consumer), STATUS_CREATED);
    } catch (error) {
      if (error instanceof ErrorWithStatusCode) {
        return createErrorResponse(error);
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
        return notFound(`Consumer with consumerId ${consumerId} not found`);
      }

      if (consumer.getStatus() === ConsumerModel.STATUS.REVOKED) {
        throw new ErrorWithStatusCode(
          'Cannot update a revoked consumer',
          STATUS_BAD_REQUEST,
        );
      }

      const changes = [];

      if (hasText(data.consumerName)) {
        changes.push(`consumerName: "${consumer.getConsumerName()}" -> "${data.consumerName}"`);
        consumer.setConsumerName(data.consumerName);
      }

      if (Array.isArray(data.capabilities)) {
        changes.push(`capabilities: [${consumer.getCapabilities().join(', ')}] -> [${data.capabilities.join(', ')}]`);
        consumer.setCapabilities(data.capabilities);
      }

      if (hasText(data.status)) {
        changes.push(`status: "${consumer.getStatus()}" -> "${data.status}"`);
        consumer.setStatus(data.status);
      }

      consumer.setUpdatedBy(getUpdatedBy());
      await consumer.save();

      const updateMsg = `Consumer updated: consumerId=${consumerId},`
        + ` changes=[${changes.join('; ')}],`
        + ` by=${getUpdatedBy()}`;
      log.info(updateMsg);
      await notifySlack(updateMsg);

      return ok(ConsumerDto.toJSON(consumer));
    } catch (error) {
      if (error instanceof ErrorWithStatusCode) {
        return createErrorResponse(error);
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
        return notFound(`Consumer with consumerId ${consumerId} not found`);
      }

      if (consumer.getStatus() === ConsumerModel.STATUS.REVOKED) {
        throw new ErrorWithStatusCode(
          'Consumer is already revoked',
          STATUS_BAD_REQUEST,
        );
      }

      consumer.setStatus(ConsumerModel.STATUS.REVOKED);
      consumer.setRevokedAt(new Date().toISOString());
      consumer.setUpdatedBy(getUpdatedBy());

      await consumer.save();

      const revokeMsg = 'Consumer revoked:'
        + ` consumerId=${consumerId}, by=${getUpdatedBy()}`;
      log.info(revokeMsg);
      await notifySlack(revokeMsg);

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
