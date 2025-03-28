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

export const IMPORT_TYPES = {
  ORGANIC_KEYWORDS: 'organic-keywords',
  ORGANIC_TRAFFIC: 'organic-traffic',
  TOP_PAGES: 'top-pages',
  ALL_TRAFFIC: 'all-traffic',
};

export const IMPORT_DESTINATIONS = {
  DEFAULT: 'default',
};

export const IMPORT_SOURCES = {
  AHREFS: 'ahrefs',
  GSC: 'google',
  RUM: 'rum',
};

const IMPORT_BASE_KEYS = {
  destinations: Joi.array().items(Joi.string().valid(IMPORT_DESTINATIONS.DEFAULT)).required(),
  sources: Joi.array().items(Joi.string().valid(...Object.values(IMPORT_SOURCES))).required(),
  // not required for now due backward compatibility
  enabled: Joi.boolean().default(true),
  url: Joi.string().uri().optional(), // optional url to override
};

export const IMPORT_TYPE_SCHEMAS = {
  [IMPORT_TYPES.ORGANIC_KEYWORDS]: Joi.object({
    type: Joi.string().valid(IMPORT_TYPES.ORGANIC_KEYWORDS).required(),
    ...IMPORT_BASE_KEYS,
    geo: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(100)
      .optional(),
    pageUrl: Joi.string().uri().optional(),
  }),
  [IMPORT_TYPES.ORGANIC_TRAFFIC]: Joi.object({
    type: Joi.string().valid(IMPORT_TYPES.ORGANIC_TRAFFIC).required(),
    ...IMPORT_BASE_KEYS,
  }),
  [IMPORT_TYPES.ALL_TRAFFIC]: Joi.object({
    type: Joi.string().valid(IMPORT_TYPES.ALL_TRAFFIC).required(),
    ...IMPORT_BASE_KEYS,
  }),
  [IMPORT_TYPES.TOP_PAGES]: Joi.object({
    type: Joi.string().valid(IMPORT_TYPES.TOP_PAGES).required(),
    ...IMPORT_BASE_KEYS,
    geo: Joi.string().optional(),
    limit: Joi.number().integer().min(1).max(2000)
      .optional(),
  }),
};

export const DEFAULT_IMPORT_CONFIGS = {
  'organic-keywords': {
    type: 'organic-keywords',
    destinations: ['default'],
    sources: ['ahrefs'],
    enabled: true,
  },
  'organic-traffic': {
    type: 'organic-traffic',
    destinations: ['default'],
    sources: ['ahrefs'],
    enabled: true,
  },
  'all-traffic': {
    type: 'all-traffic',
    destinations: ['default'],
    sources: ['rum'],
    enabled: true,
  },
  'top-pages': {
    type: 'top-pages',
    destinations: ['default'],
    sources: ['ahrefs'],
    enabled: true,
    geo: 'global',
  },
};

export const configSchema = Joi.object({
  slack: Joi.object({
    workspace: Joi.string(),
    channel: Joi.string(),
    invitedUserCount: Joi.number().integer().min(0),
  }),
  imports: Joi.array().items(
    Joi.alternatives().try(...Object.values(IMPORT_TYPE_SCHEMAS)),
  ),
  brandConfig: Joi.object({
    brandId: Joi.string().required(),
  }).optional(),
  fetchConfig: Joi.object({
    headers: Joi.object().pattern(Joi.string(), Joi.string()),
    overrideBaseURL: Joi.string().uri().optional(),
  }).optional(),
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
    movingAvgThreshold: Joi.number().min(1).optional(),
    percentageChangeThreshold: Joi.number().min(1).optional(),
    latestMetrics: Joi.object({
      pageViewsChange: Joi.number(),
      ctrChange: Joi.number(),
      projectedTrafficValue: Joi.number(),
    }),
  }).unknown(true)).unknown(true),
}).unknown(true);

export const DEFAULT_CONFIG = {
  slack: {},
  handlers: {},
};

// Function to validate incoming configuration
export function validateConfiguration(config) {
  const { error, value } = configSchema.validate(config);

  if (error) {
    throw new Error(`Configuration validation error: ${error.message}`, { cause: error });
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
  self.getLatestMetrics = (type) => state?.handlers?.[type]?.latestMetrics;
  self.getFetchConfig = () => state?.fetchConfig;
  self.getBrandConfig = () => state?.brandConfig;

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

  self.updateLatestMetrics = (type, latestMetrics) => {
    state.handlers = state.handlers || {};
    state.handlers[type] = state.handlers[type] || {};
    state.handlers[type].latestMetrics = latestMetrics;
  };

  self.updateFetchConfig = (fetchConfig) => {
    state.fetchConfig = fetchConfig;
  };

  self.updateBrandConfig = (brandConfig) => {
    state.brandConfig = brandConfig;
  };

  self.enableImport = (type, config = {}) => {
    if (!IMPORT_TYPE_SCHEMAS[type]) {
      throw new Error(`Unknown import type: ${type}`);
    }

    const defaultConfig = DEFAULT_IMPORT_CONFIGS[type];
    const newConfig = {
      ...defaultConfig, ...config, type, enabled: true,
    };

    // Validate the new config against its schema
    const { error } = IMPORT_TYPE_SCHEMAS[type].validate(newConfig);
    if (error) {
      throw new Error(`Invalid import config: ${error.message}`);
    }

    state.imports = state.imports || [];
    // Remove existing import of same type if present
    state.imports = state.imports.filter((imp) => imp.type !== type);
    state.imports.push(newConfig);

    validateConfiguration(state);
  };

  self.disableImport = (type) => {
    if (!state.imports) return;

    state.imports = state.imports.map(
      (imp) => (imp.type === type ? { ...imp, enabled: false } : imp),
    );

    validateConfiguration(state);
  };

  self.getImportConfig = (type) => state.imports?.find((imp) => imp.type === type);

  self.isImportEnabled = (type) => {
    const config = self.getImportConfig(type);
    return config?.enabled ?? false;
  };

  return Object.freeze(self);
};

Config.fromDynamoItem = (dynamoItem) => Config(dynamoItem);

Config.toDynamoItem = (config) => ({
  slack: config.getSlackConfig(),
  handlers: config.getHandlers(),
  imports: config.getImports(),
  fetchConfig: config.getFetchConfig(),
  brandConfig: config.getBrandConfig(),
});
