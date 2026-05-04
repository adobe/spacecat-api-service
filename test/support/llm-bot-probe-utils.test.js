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
import {
  LLM_BOT_AGENTS,
  HARD_BLOCK_STATUS_CODES,
  BOT_CHALLENGE_KEYWORDS,
  BOT_PROBE_TIMEOUT_MS,
  classifyBotAgentResponse,
} from '../../src/support/llm-bot-probe-utils.js';

describe('llm-bot-probe-utils', () => {
  let log;

  beforeEach(() => {
    log = { info: sinon.stub(), warn: sinon.stub() };
  });

  describe('constants', () => {
    it('exports the two user-facing LLM bot agents', () => {
      const names = LLM_BOT_AGENTS.map((a) => a.name);
      expect(names).to.deep.equal(['ChatGPT-User', 'Perplexity-User']);
    });

    it('each agent entry has name and userAgent', () => {
      LLM_BOT_AGENTS.forEach(({ name, userAgent }) => {
        expect(name).to.be.a('string').that.is.not.empty;
        expect(userAgent).to.be.a('string').that.is.not.empty;
      });
    });

    it('exports five hard-block status codes', () => {
      [401, 403, 406, 429, 503].forEach((code) => {
        expect(HARD_BLOCK_STATUS_CODES.has(code)).to.be.true;
      });
    });

    it('does not hard-block normal status codes', () => {
      [200, 301, 302, 404].forEach((code) => {
        expect(HARD_BLOCK_STATUS_CODES.has(code)).to.be.false;
      });
    });

    it('exports non-empty BOT_CHALLENGE_KEYWORDS', () => {
      expect(BOT_CHALLENGE_KEYWORDS).to.be.an('array').that.is.not.empty;
    });

    it('exports BOT_PROBE_TIMEOUT_MS as a positive number', () => {
      expect(BOT_PROBE_TIMEOUT_MS).to.be.a('number').that.is.above(0);
    });
  });

  describe('classifyBotAgentResponse', () => {
    function makeResponse(status, headers = {}, body = '') {
      return {
        status,
        headers: {
          get: (key) => headers[key.toLowerCase()] ?? null,
        },
        text: async () => body,
      };
    }

    it('classifies 403 as hard block', async () => {
      const result = await classifyBotAgentResponse(makeResponse(403), 'GPTBot', log);
      expect(result).to.deep.equal({ blocked: true, statusCode: 403 });
    });

    it('classifies 401 as hard block', async () => {
      const result = await classifyBotAgentResponse(makeResponse(401), 'GPTBot', log);
      expect(result).to.deep.equal({ blocked: true, statusCode: 401 });
    });

    it('classifies 429 as hard block', async () => {
      const result = await classifyBotAgentResponse(makeResponse(429), 'GPTBot', log);
      expect(result).to.deep.equal({ blocked: true, statusCode: 429 });
    });

    it('classifies 406 as hard block', async () => {
      const result = await classifyBotAgentResponse(makeResponse(406), 'GPTBot', log);
      expect(result).to.deep.equal({ blocked: true, statusCode: 406 });
    });

    it('classifies 503 as hard block', async () => {
      const result = await classifyBotAgentResponse(makeResponse(503), 'GPTBot', log);
      expect(result).to.deep.equal({ blocked: true, statusCode: 503 });
    });

    it('classifies cf-mitigated: challenge header as CF challenge block', async () => {
      const response = makeResponse(200, { 'cf-mitigated': 'challenge' }, '<html>...</html>');
      const result = await classifyBotAgentResponse(response, 'GPTBot', log);
      expect(result).to.deep.equal({ blocked: true, statusCode: 200 });
    });

    it('classifies 200 with challenge keyword in HTML as soft block', async () => {
      const response = makeResponse(
        200,
        { 'content-type': 'text/html; charset=utf-8' },
        '<html><body><div class="cf-chl-widget">challenge</div></body></html>',
      );
      const result = await classifyBotAgentResponse(response, 'GPTBot', log);
      expect(result).to.deep.equal({ blocked: true, statusCode: 200 });
    });

    it('classifies 200 with Imperva keyword as soft block', async () => {
      const response = makeResponse(
        200,
        { 'content-type': 'text/html' },
        '<html><script src="/_incapsula_resource?SWJIYLWA=123"></script></html>',
      );
      const result = await classifyBotAgentResponse(response, 'ClaudeBot', log);
      expect(result).to.deep.equal({ blocked: true, statusCode: 200 });
    });

    it('classifies 200 with large real HTML as clean pass', async () => {
      const response = makeResponse(
        200,
        { 'content-type': 'text/html; charset=utf-8' },
        '<html><body><h1>Welcome to our site</h1><p>Real content here.</p></body></html>',
      );
      const result = await classifyBotAgentResponse(response, 'PerplexityBot', log);
      expect(result).to.deep.equal({ blocked: false, statusCode: 200 });
    });

    it('classifies 200 with non-HTML content type as clean pass', async () => {
      const response = makeResponse(
        200,
        { 'content-type': 'application/json' },
        '{"data": "value"}',
      );
      const result = await classifyBotAgentResponse(response, 'GPTBot', log);
      expect(result).to.deep.equal({ blocked: false, statusCode: 200 });
    });

    it('classifies 200 with no content-type header as clean pass', async () => {
      const response = makeResponse(200, {}, '<html><body>Welcome</body></html>');
      const result = await classifyBotAgentResponse(response, 'GPTBot', log);
      expect(result).to.deep.equal({ blocked: false, statusCode: 200 });
    });

    it('classifies redirect (301) as not blocked', async () => {
      const result = await classifyBotAgentResponse(makeResponse(301), 'GPTBot', log);
      expect(result).to.deep.equal({ blocked: false, statusCode: 301 });
    });

    it('classifies 404 as not blocked', async () => {
      const result = await classifyBotAgentResponse(makeResponse(404), 'GPTBot', log);
      expect(result).to.deep.equal({ blocked: false, statusCode: 404 });
    });
  });
});
