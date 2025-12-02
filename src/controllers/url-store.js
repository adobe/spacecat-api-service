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

import {
  badRequest,
  notFound,
  ok,
  createResponse,
  noContent,
} from '@adobe/spacecat-shared-http-utils';
import {
  hasText,
  isObject,
  isNonEmptyObject,
  isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { ValidationError } from '@adobe/spacecat-shared-data-access';
import { UrlDto } from '../dto/url.js';

/**
 * URL Store controller.
 * @param {object} ctx - Context of the request.
 * @returns {object} URL Store controller.
 * @constructor
 */
function UrlStoreController(ctx) {
  if (!isNonEmptyObject(ctx)) {
    throw new Error('Context required');
  }
  const { dataAccess } = ctx;
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }
  const { Url } = dataAccess;
  if (!isObject(Url)) {
    throw new Error('Url Collection not available');
  }

  /**
   * returns a response for a data access error.
   * If there's a ValidationError it will return a 400 response, and the
   * validation error message coming from the data access layer.
   * If there's another kind of error, it will return a 500 response.
   * The error message in the 500 response is overriden by passing the message parameter
   * to avoid exposing internal error messages to the client.
   * @param {*} e - error
   * @param {*} message - error message to override 500 error messages
   * @returns a response
   */
  function handleDataAccessError(e, message) {
    if (e instanceof ValidationError) {
      return badRequest(e.message);
    }
    return createResponse({ message }, 500);
  }

  /**
   * Gets all URLs with pagination.
   * @param {Object} context of the request
   * @returns {Promise<Response>} Array of URLs response.
   */
  const getAll = async (context) => {
    const limit = parseInt(context.data?.limit, 10) || 50;
    const offset = parseInt(context.data?.offset, 10) || 0;

    if (limit < 1 || limit > 100) {
      return badRequest('Limit must be between 1 and 100');
    }
    if (offset < 0) {
      return badRequest('Offset must be non-negative');
    }

    try {
      const urls = await Url.all();
      const total = urls.length;
      const paginatedUrls = urls
        .slice(offset, offset + limit)
        .map((url) => UrlDto.toJSON(url));

      return ok({
        urls: paginatedUrls,
        total,
        limit,
        offset,
      });
    } catch (e) {
      return handleDataAccessError(e, 'Error retrieving URLs');
    }
  };

  /**
   * Gets URLs filtered by type.
   * @param {Object} context of the request
   * @returns {Promise<Response>} Array of URLs response.
   */
  const getByType = async (context) => {
    const type = context.params?.type;
    const limit = parseInt(context.data?.limit, 10) || 50;
    const offset = parseInt(context.data?.offset, 10) || 0;

    if (!hasText(type)) {
      return badRequest('Type required');
    }
    if (limit < 1 || limit > 100) {
      return badRequest('Limit must be between 1 and 100');
    }
    if (offset < 0) {
      return badRequest('Offset must be non-negative');
    }

    try {
      const urls = await Url.allByType(type);
      const total = urls.length;
      const paginatedUrls = urls
        .slice(offset, offset + limit)
        .map((url) => UrlDto.toJSON(url));

      return ok({
        urls: paginatedUrls,
        total,
        limit,
        offset,
      });
    } catch (e) {
      return handleDataAccessError(e, 'Error retrieving URLs by type');
    }
  };

  /**
   * Gets URLs filtered by status.
   * @param {Object} context of the request
   * @returns {Promise<Response>} Array of URLs response.
   */
  const getByStatus = async (context) => {
    const status = context.params?.status;
    const limit = parseInt(context.data?.limit, 10) || 50;
    const offset = parseInt(context.data?.offset, 10) || 0;

    if (!hasText(status)) {
      return badRequest('Status required');
    }
    if (limit < 1 || limit > 100) {
      return badRequest('Limit must be between 1 and 100');
    }
    if (offset < 0) {
      return badRequest('Offset must be non-negative');
    }

    try {
      const urls = await Url.allByStatus(status);
      const total = urls.length;
      const paginatedUrls = urls
        .slice(offset, offset + limit)
        .map((url) => UrlDto.toJSON(url));

      return ok({
        urls: paginatedUrls,
        total,
        limit,
        offset,
      });
    } catch (e) {
      return handleDataAccessError(e, 'Error retrieving URLs by status');
    }
  };

  /**
   * Gets a URL by ID.
   * @param {Object} context of the request
   * @returns {Promise<Response>} URL response.
   */
  const getByID = async (context) => {
    const urlId = context.params?.urlId;

    if (!isValidUUID(urlId)) {
      return badRequest('URL ID required');
    }

    try {
      const url = await Url.findById(urlId);
      if (!url) {
        return notFound('URL not found');
      }
      return ok(UrlDto.toJSON(url));
    } catch (e) {
      return handleDataAccessError(e, 'Error retrieving URL');
    }
  };

  /**
   * Creates a URL
   * @param {Object} context of the request
   * @return {Promise<Response>} URL response.
   */
  const createUrl = async (context) => {
    if (!isNonEmptyObject(context.data)) {
      return badRequest('No data provided');
    }

    const { url, type, status = 'active', siteId, metadata } = context.data;

    if (!hasText(url)) {
      return badRequest('URL required');
    }
    if (!hasText(type)) {
      return badRequest('Type required');
    }

    try {
      const urlData = {
        url,
        type,
        status,
        ...(siteId && { siteId }),
        ...(metadata && { metadata }),
      };

      const newUrl = await Url.create(urlData);
      return createResponse(UrlDto.toJSON(newUrl), 201);
    } catch (e) {
      return handleDataAccessError(e, 'Error creating URL');
    }
  };

  /**
   * Updates data for a URL
   * @param {Object} context of the request
   * @returns {Promise<Response>} the updated URL data
   */
  const patchUrl = async (context) => {
    const urlId = context.params?.urlId;

    if (!isValidUUID(urlId)) {
      return badRequest('URL ID required');
    }

    if (!isNonEmptyObject(context.data)) {
      return badRequest('No updates provided');
    }

    try {
      const url = await Url.findById(urlId);
      if (!url) {
        return notFound('URL not found');
      }

      const { url: urlString, type, status, siteId, metadata } = context.data;
      let hasUpdates = false;

      if (urlString && urlString !== url.getUrl()) {
        hasUpdates = true;
        url.setUrl(urlString);
      }
      if (type && type !== url.getType()) {
        hasUpdates = true;
        url.setType(type);
      }
      if (status && status !== url.getStatus()) {
        hasUpdates = true;
        url.setStatus(status);
      }
      if (siteId !== undefined && siteId !== url.getSiteId()) {
        hasUpdates = true;
        url.setSiteId(siteId);
      }
      if (isNonEmptyObject(metadata)) {
        hasUpdates = true;
        url.setMetadata(metadata);
      }

      if (hasUpdates) {
        const updatedUrl = await url.save();
        return ok(UrlDto.toJSON(updatedUrl));
      }

      return badRequest('No updates provided');
    } catch (e) {
      return handleDataAccessError(e, 'Error updating URL');
    }
  };

  /**
   * Removes a URL.
   * @param {object} context - Context of the request.
   * @return {Promise<Response>} Delete response.
   */
  const removeUrl = async (context) => {
    const urlId = context.params?.urlId;

    if (!isValidUUID(urlId)) {
      return badRequest('URL ID required');
    }

    try {
      const url = await Url.findById(urlId);
      if (!url) {
        return notFound('URL not found');
      }

      await url.remove();
      return noContent();
    } catch (e) {
      return handleDataAccessError(e, 'Error removing URL');
    }
  };

  return {
    createUrl,
    getAll,
    getByID,
    getByType,
    getByStatus,
    patchUrl,
    removeUrl,
  };
}

export default UrlStoreController;





