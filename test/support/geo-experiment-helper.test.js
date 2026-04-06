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

/* eslint-env mocha */

import { expect } from 'chai';
import { GeoExperiment } from '@adobe/spacecat-shared-data-access';
import {
  parseScheduleConfig,
  getScheduleParams,
  buildExperimentMetadata,
} from '../../src/support/geo-experiment-helper.js';

const { TYPES, METADATA_KEYS, SCHEDULE_CONFIG_ENV_VAR } = GeoExperiment;
const ONSITE = TYPES.ONSITE_OPPORTUNITY_DEPLOYMENT;

describe('geo-experiment-helper', () => {
  // ─── parseScheduleConfig ─────────────────────────────────────────────────────

  describe('parseScheduleConfig', () => {
    it('returns null when env var is absent', () => {
      expect(parseScheduleConfig({})).to.equal(null);
    });

    it('returns parsed config with a valid env var', () => {
      const config = {
        [ONSITE]: {
          pre: {
            cronExpression: '0 * * * *', expiryMs: 3600000, platforms: ['chatgpt_free'], providerIds: ['brightdata'],
          },
          post: {
            cronExpression: '0 0 * * *', expiryMs: 86400000, platforms: ['perplexity'], providerIds: ['openai_web_search'],
          },
        },
      };
      const env = { [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify(config) };
      expect(parseScheduleConfig(env)).to.deep.equal(config);
    });

    it('throws SyntaxError on invalid JSON', () => {
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: 'not-json' })).to.throw(SyntaxError, SCHEDULE_CONFIG_ENV_VAR);
    });

    it('throws TypeError when env var is a JSON array', () => {
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: '[]' })).to.throw(TypeError, SCHEDULE_CONFIG_ENV_VAR);
    });

    it('throws TypeError when a strategy config is not an object', () => {
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({ [ONSITE]: 'bad' }) })).to.throw(TypeError, ONSITE);
    });

    it('throws TypeError when cronExpression is not a string', () => {
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({ [ONSITE]: { pre: { cronExpression: 42 } } }) })).to.throw(TypeError, 'cronExpression');
    });

    it('throws TypeError when expiryMs is not a positive integer', () => {
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({ [ONSITE]: { pre: { expiryMs: -1 } } }) })).to.throw(TypeError, 'expiryMs');
    });

    it('throws TypeError when expiryMs is a float', () => {
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({ [ONSITE]: { pre: { expiryMs: 1.5 } } }) })).to.throw(TypeError, 'expiryMs');
    });

    it('throws TypeError when platforms is not an array', () => {
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({ [ONSITE]: { post: { platforms: 'chatgpt_free' } } }) })).to.throw(TypeError, 'platforms');
    });

    it('throws TypeError when providerIds is not an array', () => {
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({ [ONSITE]: { post: { providerIds: 'brightdata' } } }) })).to.throw(TypeError, 'providerIds');
    });
  });

  // ─── getScheduleParams ───────────────────────────────────────────────────────

  describe('getScheduleParams', () => {
    it('returns built-in defaults when env var is absent', () => {
      const params = getScheduleParams({}, ONSITE, 'pre');
      expect(params).to.include.keys('cronExpression', 'expiryMs', 'platforms', 'providerIds');
      expect(params.cronExpression).to.be.a('string');
      expect(params.expiryMs).to.be.a('number');
      expect(params.platforms).to.be.an('array').that.is.not.empty;
      expect(params.providerIds).to.be.an('array').that.is.not.empty;
    });

    it('overrides only the fields present in the env var config', () => {
      const env = { [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({ [ONSITE]: { pre: { cronExpression: '*/30 * * * *' } } }) };
      const params = getScheduleParams(env, ONSITE, 'pre');
      expect(params.cronExpression).to.equal('*/30 * * * *');
      expect(params.platforms).to.be.an('array').that.is.not.empty;
    });

    it('fully overrides all fields when all are provided', () => {
      const custom = {
        cronExpression: '0 6 * * *', expiryMs: 7200000, platforms: ['perplexity'], providerIds: ['openai_web_search'],
      };
      const env = { [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({ [ONSITE]: { post: custom } }) };
      expect(getScheduleParams(env, ONSITE, 'post')).to.deep.equal(custom);
    });

    it('returns empty object for unknown strategy type', () => {
      expect(getScheduleParams({}, 'unknown_strategy', 'pre')).to.deep.equal({});
    });
  });

  // ─── buildExperimentMetadata ─────────────────────────────────────────────────

  describe('buildExperimentMetadata', () => {
    it('merges base fields with scheduleConfig', () => {
      const result = buildExperimentMetadata({}, { urls: ['https://example.com'] }, ONSITE);
      expect(result.urls).to.deep.equal(['https://example.com']);
      expect(result[METADATA_KEYS.SCHEDULE_CONFIG]).to.be.an('object');
      expect(result[METADATA_KEYS.SCHEDULE_CONFIG].pre).to.include.keys('cronExpression', 'expiryMs', 'platforms', 'providerIds');
      expect(result[METADATA_KEYS.SCHEDULE_CONFIG].post).to.include.keys('cronExpression', 'expiryMs', 'platforms', 'providerIds');
    });

    it('scheduleConfig in metadata reflects env-var overrides', () => {
      const env = { [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({ [ONSITE]: { post: { cronExpression: '0 6 * * *' } } }) };
      const result = buildExperimentMetadata(env, {}, ONSITE);
      expect(result[METADATA_KEYS.SCHEDULE_CONFIG].post.cronExpression).to.equal('0 6 * * *');
    });

    it('does not mutate the base object', () => {
      const base = { urls: ['https://example.com'] };
      buildExperimentMetadata({}, base, ONSITE);
      expect(base).to.not.have.key(METADATA_KEYS.SCHEDULE_CONFIG);
    });
  });
});
