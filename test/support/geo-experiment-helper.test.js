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

import { expect } from 'chai';
import sinon from 'sinon';
import { GeoExperiment } from '@adobe/spacecat-shared-data-access';
import {
  parseScheduleConfig,
  getScheduleParams,
  buildExperimentMetadata,
} from '../../src/support/geo-experiment-helper.js';

const { TYPES, METADATA_KEYS, SCHEDULE_CONFIG_ENV_VAR } = GeoExperiment;
const ONSITE = TYPES.ONSITE_OPPORTUNITY_DEPLOYMENT;
const OPP_TYPE = 'recover-content-visibility';

describe('geo-experiment-helper', () => {
  const sandbox = sinon.createSandbox();
  let mockLog;

  beforeEach(() => {
    mockLog = {
      warn: sandbox.stub(),
      info: sandbox.stub(),
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  /** @param {Record<string, unknown>} env */
  function scheduleContext(env) {
    return { env, log: mockLog };
  }

  // ─── parseScheduleConfig ─────────────────────────────────────────────────────

  describe('parseScheduleConfig', () => {
    it('returns null when env var is absent', () => {
      expect(parseScheduleConfig({}, mockLog)).to.equal(null);
      sinon.assert.calledOnce(mockLog.warn);
    });

    it('returns null when env object is undefined', () => {
      expect(parseScheduleConfig(undefined, mockLog)).to.equal(null);
      sinon.assert.calledOnce(mockLog.warn);
    });

    it('returns parsed config with a valid env var', () => {
      const config = {
        [ONSITE]: {
          default: {
            pre: {
              cronExpression: '0 * * * *', expiryMs: 3600000, platforms: ['chatgpt_free'], providerIds: ['brightdata'],
            },
            post: {
              cronExpression: '0 0 * * *', expiryMs: 86400000, platforms: ['perplexity'], providerIds: ['openai_web_search'],
            },
          },
          [OPP_TYPE]: {
            pre: { cronExpression: '*/15 * * * *' },
          },
        },
      };
      const env = { [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify(config) };
      expect(parseScheduleConfig(env, mockLog)).to.deep.equal(config);
      sinon.assert.calledOnce(mockLog.info);
    });

    it('throws SyntaxError on invalid JSON', () => {
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: 'not-json' }, mockLog)).to.throw(SyntaxError, SCHEDULE_CONFIG_ENV_VAR);
    });

    it('throws TypeError when env var is a JSON array', () => {
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: '[]' }, mockLog)).to.throw(TypeError, SCHEDULE_CONFIG_ENV_VAR);
    });

    it('throws TypeError when a strategy config is not an object', () => {
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({ [ONSITE]: 'bad' }) }, mockLog)).to.throw(TypeError, ONSITE);
    });

    it('throws TypeError when an opportunity type config is not an object', () => {
      const config = { [ONSITE]: { [OPP_TYPE]: 'bad' } };
      const env = { [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify(config) };
      expect(() => parseScheduleConfig(env, mockLog)).to.throw(TypeError, OPP_TYPE);
    });

    it('throws TypeError when cronExpression is not a string', () => {
      const config = { [ONSITE]: { default: { pre: { cronExpression: 42 } } } };
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify(config) }, mockLog)).to.throw(TypeError, 'cronExpression');
    });

    it('throws TypeError when expiryMs is not a positive integer', () => {
      const config = { [ONSITE]: { default: { pre: { expiryMs: -1 } } } };
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify(config) }, mockLog)).to.throw(TypeError, 'expiryMs');
    });

    it('throws TypeError when expiryMs is a float', () => {
      const config = { [ONSITE]: { default: { pre: { expiryMs: 1.5 } } } };
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify(config) }, mockLog)).to.throw(TypeError, 'expiryMs');
    });

    it('throws TypeError when platforms is not an array', () => {
      const config = { [ONSITE]: { [OPP_TYPE]: { post: { platforms: 'chatgpt_free' } } } };
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify(config) }, mockLog)).to.throw(TypeError, 'platforms');
    });

    it('throws TypeError when providerIds is not an array', () => {
      const config = { [ONSITE]: { [OPP_TYPE]: { post: { providerIds: 'brightdata' } } } };
      expect(() => parseScheduleConfig({ [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify(config) }, mockLog)).to.throw(TypeError, 'providerIds');
    });
  });

  // ─── getScheduleParams ───────────────────────────────────────────────────────

  describe('getScheduleParams', () => {
    it('returns empty object when env var is absent', () => {
      expect(getScheduleParams(scheduleContext({}), ONSITE, OPP_TYPE, 'pre')).to.deep.equal({});
    });

    it('returns empty object for unknown strategy type', () => {
      expect(getScheduleParams(scheduleContext({}), 'unknown_strategy', OPP_TYPE, 'pre')).to.deep.equal({});
    });

    it('applies default key config (field-level)', () => {
      const env = {
        [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({
          [ONSITE]: { default: { pre: { cronExpression: '*/30 * * * *' } } },
        }),
      };
      const params = getScheduleParams(scheduleContext(env), ONSITE, OPP_TYPE, 'pre');
      expect(params.cronExpression).to.equal('*/30 * * * *');
      expect(params.platforms).to.be.undefined;
    });

    it('applies opportunity type overrides over default key (field-level)', () => {
      const env = {
        [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({
          [ONSITE]: {
            default: { pre: { cronExpression: '*/30 * * * *', expiryMs: 1000 } },
            [OPP_TYPE]: { pre: { cronExpression: '0 * * * *' } },
          },
        }),
      };
      const params = getScheduleParams(scheduleContext(env), ONSITE, OPP_TYPE, 'pre');
      expect(params.cronExpression).to.equal('0 * * * *'); // opp type wins
      expect(params.expiryMs).to.equal(1000); // default key fills the gap
    });

    it('falls back to default key when opportunity type is not in config', () => {
      const env = {
        [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({
          [ONSITE]: { default: { pre: { cronExpression: '*/30 * * * *' } } },
        }),
      };
      const params = getScheduleParams(scheduleContext(env), ONSITE, 'unknown-opp-type', 'pre');
      expect(params.cronExpression).to.equal('*/30 * * * *');
    });

    it('lowercases the opportunity type key before lookup', () => {
      const env = {
        [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({
          [ONSITE]: { [OPP_TYPE]: { pre: { cronExpression: '0 12 * * *' } } },
        }),
      };
      const params = getScheduleParams(scheduleContext(env), ONSITE, 'Recover-Content-Visibility', 'pre');
      expect(params.cronExpression).to.equal('0 12 * * *');
    });

    it('handles null opportunityType gracefully, uses default key', () => {
      const env = {
        [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({
          [ONSITE]: { default: { pre: { cronExpression: '*/30 * * * *' } } },
        }),
      };
      const params = getScheduleParams(scheduleContext(env), ONSITE, null, 'pre');
      expect(params.cronExpression).to.equal('*/30 * * * *');
    });

    it('fully overrides all fields when all are provided for an opportunity type', () => {
      const custom = {
        cronExpression: '0 6 * * *', expiryMs: 7200000, platforms: ['perplexity'], providerIds: ['openai_web_search'],
      };
      const env = {
        [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({
          [ONSITE]: { [OPP_TYPE]: { post: custom } },
        }),
      };
      expect(getScheduleParams(scheduleContext(env), ONSITE, OPP_TYPE, 'post')).to.deep.equal(custom);
    });
  });

  // ─── buildExperimentMetadata ─────────────────────────────────────────────────

  describe('buildExperimentMetadata', () => {
    it('merges base fields with scheduleConfig', () => {
      const env = {
        [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({
          [ONSITE]: {
            [OPP_TYPE]: {
              pre: { cronExpression: '0 * * * *', expiryMs: 3600000 },
              post: { cronExpression: '0 0 * * *', expiryMs: 86400000 },
            },
          },
        }),
      };
      const result = buildExperimentMetadata(scheduleContext(env), { urls: ['https://example.com'] }, ONSITE, OPP_TYPE);
      expect(result.urls).to.deep.equal(['https://example.com']);
      expect(result[METADATA_KEYS.SCHEDULE_CONFIG]).to.be.an('object');
      expect(result[METADATA_KEYS.SCHEDULE_CONFIG].pre.cronExpression).to.equal('0 * * * *');
      expect(result[METADATA_KEYS.SCHEDULE_CONFIG].post.cronExpression).to.equal('0 0 * * *');
    });

    it('scheduleConfig reflects opportunity-type overrides', () => {
      const env = {
        [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({
          [ONSITE]: { [OPP_TYPE]: { post: { cronExpression: '0 6 * * *' } } },
        }),
      };
      const result = buildExperimentMetadata(scheduleContext(env), {}, ONSITE, OPP_TYPE);
      expect(result[METADATA_KEYS.SCHEDULE_CONFIG].post.cronExpression).to.equal('0 6 * * *');
    });

    it('scheduleConfig reflects default key overrides when opportunity type absent', () => {
      const env = {
        [SCHEDULE_CONFIG_ENV_VAR]: JSON.stringify({
          [ONSITE]: { default: { post: { cronExpression: '0 6 * * *' } } },
        }),
      };
      const result = buildExperimentMetadata(scheduleContext(env), {}, ONSITE, 'unknown-opp-type');
      expect(result[METADATA_KEYS.SCHEDULE_CONFIG].post.cronExpression).to.equal('0 6 * * *');
    });

    it('does not mutate the base object', () => {
      const base = { urls: ['https://example.com'] };
      buildExperimentMetadata(scheduleContext({}), base, ONSITE, OPP_TYPE);
      expect(base).to.not.have.key(METADATA_KEYS.SCHEDULE_CONFIG);
    });
  });
});
