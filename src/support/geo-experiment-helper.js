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

const {
  CRON_EXPRESSION, EXPIRY_MS, PLATFORMS, PROVIDER_IDS,
} = GeoExperiment.SCHEDULE_CONFIG_KEYS;

/**
 * Per-strategy default schedule parameters used as fallback when
 * EXPERIMENT_SCHEDULE_CONFIG is not set or does not cover a phase.
 */
const DEFAULT_SCHEDULE_PARAMS = {
  [GeoExperiment.TYPES.ONSITE_OPPORTUNITY_DEPLOYMENT]: {
    pre: {
      [CRON_EXPRESSION]: '0 * * * *', // hourly
      [EXPIRY_MS]: 14 * 60 * 60 * 1000, // 14 hours
      [PLATFORMS]: ['chatgpt_free', 'perplexity'],
      [PROVIDER_IDS]: ['brightdata', 'openai_web_search'],
    },
    post: {
      [CRON_EXPRESSION]: '0 0 * * *', // daily
      [EXPIRY_MS]: 14 * 24 * 60 * 60 * 1000, // 14 days
      [PLATFORMS]: ['chatgpt_free', 'perplexity'],
      [PROVIDER_IDS]: ['brightdata', 'openai_web_search'],
    },
  },
};

/**
 * Validates a single phase config block.
 * All fields are optional — only present fields are validated.
 *
 * @param {object} phaseConfig
 * @param {string} path - e.g. "onsite_opportunity_deployment.pre" for error messages
 */
function validatePhaseConfig(phaseConfig, path) {
  const cronExpression = phaseConfig[CRON_EXPRESSION];
  const expiryMs = phaseConfig[EXPIRY_MS];
  const platforms = phaseConfig[PLATFORMS];
  const providerIds = phaseConfig[PROVIDER_IDS];

  if (cronExpression !== undefined && typeof cronExpression !== 'string') {
    throw new TypeError(`${path}.${CRON_EXPRESSION} must be a string`);
  }
  if (expiryMs !== undefined && (!Number.isInteger(expiryMs) || expiryMs <= 0)) {
    throw new TypeError(`${path}.${EXPIRY_MS} must be a positive integer`);
  }
  if (platforms !== undefined && !Array.isArray(platforms)) {
    throw new TypeError(`${path}.${PLATFORMS} must be an array`);
  }
  if (providerIds !== undefined && !Array.isArray(providerIds)) {
    throw new TypeError(`${path}.${PROVIDER_IDS} must be an array`);
  }
}

/**
 * Parses and validates the EXPERIMENT_SCHEDULE_CONFIG env var.
 * Returns null if the variable is absent (defaults will be used everywhere).
 * Throws on malformed JSON or invalid field types.
 *
 * @param {object} env
 * @returns {object|null}
 */
export function parseScheduleConfig(env) {
  const raw = env[GeoExperiment.SCHEDULE_CONFIG_ENV_VAR];
  if (!raw) return null;

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
    for (const phase of ['pre', 'post']) {
      if (strategyConfig[phase] !== undefined) {
        validatePhaseConfig(strategyConfig[phase], `${strategyType}.${phase}`);
      }
    }
  }

  return parsed;
}

/**
 * Returns the resolved schedule parameters for a strategy type and phase.
 * Fields from EXPERIMENT_SCHEDULE_CONFIG are merged over the per-strategy defaults.
 *
 * @param {object} env
 * @param {string} strategyType - e.g. GeoExperiment.TYPES.ONSITE_OPPORTUNITY_DEPLOYMENT
 * @param {'pre'|'post'} phase
 * @returns {{ cronExpression: string, expiryMs: number, platforms: string[],
 *   providerIds: string[] }}
 */
export function getScheduleParams(env, strategyType, phase) {
  const scheduleConfig = parseScheduleConfig(env);
  const defaults = DEFAULT_SCHEDULE_PARAMS[strategyType]?.[phase] ?? {};
  const overrides = scheduleConfig?.[strategyType]?.[phase] ?? {};
  return { ...defaults, ...overrides };
}

/**
 * Returns a metadata object for a new GeoExperiment.
 * Merges provided base fields with the full schedule config (pre + post) for
 * the given strategy type so the experimentation engine can read it later.
 *
 * @param {object} env
 * @param {object} base - Caller-supplied metadata fields (e.g. { urls })
 * @param {string} strategyType
 * @returns {object}
 */
export function buildExperimentMetadata(env, base, strategyType) {
  return {
    ...base,
    [GeoExperiment.METADATA_KEYS.SCHEDULE_CONFIG]: {
      pre: getScheduleParams(env, strategyType, 'pre'),
      post: getScheduleParams(env, strategyType, 'post'),
    },
  };
}
