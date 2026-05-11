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
import { handleLlmoRationale } from '../../../src/controllers/llmo/llmo-rationale.js';

const SITE_ID = 'aabbccdd-1234-1234-1234-aabbccdd1234';

function makeS3Body(content) {
  return { transformToString: sinon.stub().resolves(content) };
}

function makeContext(overrides = {}) {
  return {
    log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
    params: { siteId: SITE_ID },
    data: {
      topic: 'ai', category: null, region: null, origin: null, popularity: null,
    },
    env: { ENV: 'dev' },
    s3: {
      s3Client: { send: sinon.stub() },
      GetObjectCommand: sinon.stub().callsFake((p) => p),
    },
    ...overrides,
  };
}

describe('llmo-rationale', () => {
  describe('handleLlmoRationale', () => {
    it('returns 400 when topic param is missing', async () => {
      const ctx = makeContext({ data: {} });
      const response = await handleLlmoRationale(ctx);
      expect(response.status).to.equal(400);
    });

    it('returns 400 when s3 is not configured', async () => {
      const ctx = makeContext({ s3: null });
      const response = await handleLlmoRationale(ctx);
      expect(response.status).to.equal(400);
    });

    it('returns 400 when s3.s3Client is missing', async () => {
      const ctx = makeContext({ s3: {} });
      const response = await handleLlmoRationale(ctx);
      expect(response.status).to.equal(400);
    });

    it('returns filtered topics on success', async () => {
      const topics = [
        {
          topic: 'AI tools', category: 'tech', region: 'us', origin: 'blog', popularity: 'high',
        },
        {
          topic: 'cooking', category: 'food', region: 'eu', origin: 'web', popularity: 'low',
        },
      ];
      const ctx = makeContext();
      ctx.s3.s3Client.send.resolves({
        Body: makeS3Body(JSON.stringify({ topics })),
      });

      const response = await handleLlmoRationale(ctx);
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.have.length(1);
      expect(body[0].topic).to.equal('AI tools');
    });

    it('applies optional filters (category, region, origin, popularity)', async () => {
      const topics = [
        {
          topic: 'ai', category: 'tech', region: 'us', origin: 'blog', popularity: 'high',
        },
        {
          topic: 'ai', category: 'food', region: 'eu', origin: 'web', popularity: 'low',
        },
      ];
      const ctx = makeContext({
        data: {
          topic: 'ai',
          category: 'tech',
          region: 'us',
          origin: 'blog',
          popularity: 'high',
        },
      });
      ctx.s3.s3Client.send.resolves({
        Body: makeS3Body(JSON.stringify({ topics })),
      });

      const response = await handleLlmoRationale(ctx);
      const body = await response.json();
      expect(body).to.have.length(1);
    });

    it('handles missing topics array (defaults to empty)', async () => {
      const ctx = makeContext();
      ctx.s3.s3Client.send.resolves({
        Body: makeS3Body(JSON.stringify({})),
      });
      const response = await handleLlmoRationale(ctx);
      expect(response.status).to.equal(200);
      const body = await response.json();
      expect(body).to.deep.equal([]);
    });

    it('returns 404 on NoSuchKey', async () => {
      const ctx = makeContext();
      const err = new Error('no key');
      err.name = 'NoSuchKey';
      ctx.s3.s3Client.send.rejects(err);
      const response = await handleLlmoRationale(ctx);
      expect(response.status).to.equal(404);
    });

    it('returns 400 on NoSuchBucket', async () => {
      const ctx = makeContext();
      const err = new Error('no bucket');
      err.name = 'NoSuchBucket';
      ctx.s3.s3Client.send.rejects(err);
      const response = await handleLlmoRationale(ctx);
      expect(response.status).to.equal(400);
    });

    it('returns 400 on SyntaxError in JSON', async () => {
      const ctx = makeContext();
      ctx.s3.s3Client.send.resolves({
        Body: makeS3Body('NOT_JSON{{'),
      });
      const response = await handleLlmoRationale(ctx);
      expect(response.status).to.equal(400);
    });

    it('returns 400 on generic S3 error', async () => {
      const ctx = makeContext();
      ctx.s3.s3Client.send.rejects(new Error('network failure'));
      const response = await handleLlmoRationale(ctx);
      expect(response.status).to.equal(400);
    });

    it('partial-match filters topic case-insensitively', async () => {
      const topics = [
        { topic: 'Machine Learning Trends' },
        { topic: 'cooking recipes' },
      ];
      const ctx = makeContext({ data: { topic: 'machine learning' } });
      ctx.s3.s3Client.send.resolves({
        Body: makeS3Body(JSON.stringify({ topics })),
      });
      const response = await handleLlmoRationale(ctx);
      const body = await response.json();
      expect(body).to.have.length(1);
      expect(body[0].topic).to.equal('Machine Learning Trends');
    });

    it('returns all topics when optional filters are absent', async () => {
      const topics = [{ topic: 'ai', category: 'tech' }, { topic: 'ai', category: 'food' }];
      const ctx = makeContext({ data: { topic: 'ai' } });
      ctx.s3.s3Client.send.resolves({
        Body: makeS3Body(JSON.stringify({ topics })),
      });
      const response = await handleLlmoRationale(ctx);
      const body = await response.json();
      expect(body).to.have.length(2);
    });

    it('excludes topic failing only the region filter', async () => {
      const topics = [
        {
          topic: 'ai', category: 'tech', region: 'us', origin: 'blog', popularity: 'high',
        },
        {
          topic: 'ai', category: 'tech', region: 'eu', origin: 'blog', popularity: 'high',
        },
      ];
      const ctx = makeContext({
        data: {
          topic: 'ai', category: 'tech', region: 'us', origin: null, popularity: null,
        },
      });
      ctx.s3.s3Client.send.resolves({ Body: makeS3Body(JSON.stringify({ topics })) });
      const response = await handleLlmoRationale(ctx);
      const body = await response.json();
      expect(body).to.have.length(1);
      expect(body[0].region).to.equal('us');
    });

    it('excludes topic failing only the origin filter', async () => {
      const topics = [
        { topic: 'ai', region: 'us', origin: 'blog' },
        { topic: 'ai', region: 'us', origin: 'web' },
      ];
      const ctx = makeContext({
        data: {
          topic: 'ai', category: null, region: 'us', origin: 'blog', popularity: null,
        },
      });
      ctx.s3.s3Client.send.resolves({ Body: makeS3Body(JSON.stringify({ topics })) });
      const response = await handleLlmoRationale(ctx);
      const body = await response.json();
      expect(body).to.have.length(1);
      expect(body[0].origin).to.equal('blog');
    });

    it('excludes topic failing only the popularity filter', async () => {
      const topics = [
        { topic: 'ai', popularity: 'high' },
        { topic: 'ai', popularity: 'low' },
      ];
      const ctx = makeContext({
        data: {
          topic: 'ai', category: null, region: null, origin: null, popularity: 'high',
        },
      });
      ctx.s3.s3Client.send.resolves({ Body: makeS3Body(JSON.stringify({ topics })) });
      const response = await handleLlmoRationale(ctx);
      const body = await response.json();
      expect(body).to.have.length(1);
      expect(body[0].popularity).to.equal('high');
    });
  });
});
