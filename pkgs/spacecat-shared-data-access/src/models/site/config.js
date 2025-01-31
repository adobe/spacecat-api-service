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

import Joi from 'joi';

export const configSchema = Joi.object({
  slack: Joi.object({
    workspace: Joi.string(),
    channel: Joi.string(),
    invitedUserCount: Joi.number().integer().min(0),
  }),
  imports: Joi.array().items(Joi.object({ type: Joi.string() }).unknown(true)),
  handlers: Joi.object().pattern(Joi.string(), Joi.object({
    mentions: Joi.object().pattern(Joi.string(), Joi.array().items(Joi.string())),
    excludedURLs: Joi.array().items(Joi.string()),
    manualOverwrites: Joi.array().items(Joi.object({
      brokenTargetURL: Joi.string().optional(),
      targetURL: Joi.string().optional(),
    })).optional(),
    fixedURLs: Joi.array().items(Joi.object({
      brokenTargetURL: Joi.string().optional(),
      targetURL: Joi.string().optional(),
    })).optional(),
    includedURLs: Joi.array().items(Joi.string()),
    groupedURLs: Joi.array().items(Joi.object({
      name: Joi.string(),
      pattern: Joi.string(),
    })).optional(),
  }).unknown(true)).unknown(true),
}).unknown(true);

export const DEFAULT_CONFIG = {
  slack: {},
  handlers: {
  },
};

// Function to validate incoming configuration
export function validateConfiguration(config) {
  const { error, value } = configSchema.validate(config);

  if (error) {
    throw new Error(`Configuration validation error: ${error.message}`);
  }

  return value; // Validated and sanitized configuration
}

export const Config = (data = {}) => {
  const validConfig = validateConfiguration(data);

  const state = { ...validConfig };
  const self = { state };
  self.getSlackConfig = () => state.slack;
  self.isInternalCustomer = () => state?.slack?.workspace === 'internal';
  self.getSlackMentions = (type) => state?.handlers?.[type]?.mentions?.slack;
  self.getHandlerConfig = (type) => state?.handlers?.[type];
  self.getHandlers = () => state.handlers;
  self.getImports = () => state.imports;
  self.getExcludedURLs = (type) => state?.handlers?.[type]?.excludedURLs;
  self.getManualOverwrites = (type) => state?.handlers?.[type]?.manualOverwrites;
  self.getFixedURLs = (type) => state?.handlers?.[type]?.fixedURLs;
  self.getIncludedURLs = (type) => state?.handlers?.[type]?.includedURLs;
  self.getGroupedURLs = (type) => state?.handlers?.[type]?.groupedURLs;

  self.updateSlackConfig = (channel, workspace, invitedUserCount) => {
    state.slack = {
      channel,
      workspace,
      invitedUserCount,
    };
  };

  self.updateImports = (imports) => {
    state.imports = imports;
  };

  self.updateSlackMentions = (type, mentions) => {
    state.handlers = state.handlers || {};
    state.handlers[type] = state.handlers[type] || {};
    state.handlers[type].mentions = state.handlers[type].mentions || {};
    state.handlers[type].mentions.slack = mentions;
  };

  self.updateExcludedURLs = (type, excludedURLs) => {
    state.handlers = state.handlers || {};
    state.handlers[type] = state.handlers[type] || {};
    state.handlers[type].excludedURLs = excludedURLs;
  };

  self.updateManualOverwrites = (type, manualOverwrites) => {
    state.handlers = state.handlers || {};
    state.handlers[type] = state.handlers[type] || {};
    state.handlers[type].manualOverwrites = manualOverwrites;
  };

  self.updateFixedURLs = (type, fixedURLs) => {
    state.handlers = state.handlers || {};
    state.handlers[type] = state.handlers[type] || {};
    state.handlers[type].fixedURLs = fixedURLs;
  };

  self.updateGroupedURLs = (type, groupedURLs) => {
    state.handlers = state.handlers || {};
    state.handlers[type] = state.handlers[type] || {};
    state.handlers[type].groupedURLs = groupedURLs;

    validateConfiguration(state);
  };

  return Object.freeze(self);
};

Config.fromDynamoItem = (dynamoItem) => Config(dynamoItem);

Config.toDynamoItem = (config) => ({
  slack: config.getSlackConfig(),
  handlers: config.getHandlers(),
  imports: config.getImports(),
});
