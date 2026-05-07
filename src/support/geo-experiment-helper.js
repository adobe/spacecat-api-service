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

import { GeoExperiment } from '@adobe/spacecat-shared-data-access';

/**
 * Validates a single phase config block.
 * All fields are optional — only present fields are validated.
 *
 * @param {object} phaseConfig
 * @param {string} path - e.g. "onsite_opportunity_deployment.pre" for error messages
 */
function validatePhaseConfig(phaseConfig, path) {
  const {
    cronExpression, expiryMs, platforms, providerIds,
  } = phaseConfig;

  if (cronExpression !== undefined && typeof cronExpression !== 'string') {
    throw new TypeError(`${path}.cronExpression must be a string`);
  }
  if (expiryMs !== undefined && (!Number.isInteger(expiryMs) || expiryMs <= 0)) {
    throw new TypeError(`${path}.expiryMs must be a positive integer`);
  }
  if (platforms !== undefined && !Array.isArray(platforms)) {
    throw new TypeError(`${path}.platforms must be an array`);
  }
  if (providerIds !== undefined && !Array.isArray(providerIds)) {
    throw new TypeError(`${path}.providerIds must be an array`);
  }
}

/**
 * Parses and validates the EXPERIMENT_SCHEDULE_CONFIG env var.
 * Returns null if the variable is absent (defaults will be used everywhere).
 * Throws on malformed JSON or invalid field types.
 *
 * Expected shape:
 * {
 *   "<strategyType>": {
 *     "default": { "pre": { ... }, "post": { ... } },
 *     "<opportunityType>": { "pre": { ... }, "post": { ... } }
 *   }
 * }
 *
 * @param {object} env
 * @returns {object|null}
 */
export function parseScheduleConfig(env, log) {
  const raw = env?.[GeoExperiment.SCHEDULE_CONFIG_ENV_VAR];
  if (!raw) {
    log?.warn(`[geo-experiment-helper] ${GeoExperiment.SCHEDULE_CONFIG_ENV_VAR} is not set`);
    return null;
  }
  log?.info(`[geo-experiment-helper] ${GeoExperiment.SCHEDULE_CONFIG_ENV_VAR} : ${JSON.stringify(raw)}`);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SyntaxError(
      `${GeoExperiment.SCHEDULE_CONFIG_ENV_VAR} contains invalid JSON: ${err.message}`,
    );
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
    throw new TypeError(
      `${GeoExperiment.SCHEDULE_CONFIG_ENV_VAR} must be a JSON object`,
    );
  }

  for (const [strategyType, strategyConfig] of Object.entries(parsed)) {
    if (typeof strategyConfig !== 'object' || strategyConfig === null) {
      throw new TypeError(
        `${GeoExperiment.SCHEDULE_CONFIG_ENV_VAR}: ${strategyType} must be an object`,
      );
    }
    for (const [oppTypeKey, oppTypeConfig] of Object.entries(strategyConfig)) {
      if (typeof oppTypeConfig !== 'object' || oppTypeConfig === null) {
        throw new TypeError(
          `${GeoExperiment.SCHEDULE_CONFIG_ENV_VAR}: ${strategyType}.${oppTypeKey} must be an object`,
        );
      }
      for (const phase of ['pre', 'post']) {
        if (oppTypeConfig[phase] !== undefined) {
          validatePhaseConfig(oppTypeConfig[phase], `${strategyType}.${oppTypeKey}.${phase}`);
        }
      }
    }
  }

  return parsed;
}

/**
 * Returns the resolved schedule parameters for a strategy type, opportunity type, and phase.
 *
 * Merge order (lower wins):
 *   1. "default" key in EXPERIMENT_SCHEDULE_CONFIG for the strategy (field-level)
 *   2. Opportunity-type key in EXPERIMENT_SCHEDULE_CONFIG (field-level)
 *
 * The opportunity type key is lowercased before lookup.
 *
 * @param {object} env
 * @param {string} strategyType - e.g. GeoExperiment.TYPES.ONSITE_OPPORTUNITY_DEPLOYMENT
 * @param {string} opportunityType - e.g. "recover-content-visibility"
 * @param {'pre'|'post'} phase
 * @returns {object}
 */
export function getScheduleParams(context, strategyType, opportunityType, phase) {
  const scheduleConfig = parseScheduleConfig(context.env, context.log);
  const strategyConfig = scheduleConfig?.[strategyType] ?? {};
  const defaultOverrides = strategyConfig.default?.[phase] ?? {};
  const oppTypeOverrides = strategyConfig[opportunityType?.toLowerCase()]?.[phase] ?? {};
  return { ...defaultOverrides, ...oppTypeOverrides };
}

/**
 * Returns a metadata object for a new GeoExperiment.
 * Merges provided base fields with the fully resolved schedule config (pre + post)
 * for the given strategy and opportunity types, so the experimentation engine can
 * read them later without needing to re-resolve.
 *
 * @param {object} context - Request context
 * @param {object} base - Caller-supplied metadata fields (e.g. { urls })
 * @param {string} strategyType
 * @param {string} opportunityType
 * @returns {object}
 */
export function buildExperimentMetadata(context, base, strategyType, opportunityType) {
  return {
    ...base,
    [GeoExperiment.METADATA_KEYS.SCHEDULE_CONFIG]: {
      pre: getScheduleParams(context, strategyType, opportunityType, 'pre'),
      post: getScheduleParams(context, strategyType, opportunityType, 'post'),
    },
  };
}
