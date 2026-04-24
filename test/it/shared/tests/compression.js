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

/**
 * Fetches a URL with Accept-Encoding and returns headers + raw buffer.
 */
async function fetchRaw(baseUrl, path, token, acceptEncoding) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'x-product': 'ASO',
  };
  if (acceptEncoding) {
    headers['Accept-Encoding'] = acceptEncoding;
  }

  const res = await fetch(`${baseUrl}${path}`, { method: 'GET', headers });

  return {
    status: res.status,
    headers: res.headers,
    encoding: res.headers.get('content-encoding'),
  };
}

/**
 * Compression integration tests.
 *
 * These validate the compressResponse wrapper is active in the middleware chain.
 * The IT seed data is small (<1KB for most endpoints), so responses fall below
 * the wrapper's default 1024-byte minSize threshold. Tests focus on verifying:
 * - The wrapper doesn't break normal responses (skip conditions work)
 * - Accept-Encoding headers are handled without errors
 * - Health check and other small endpoints remain uncompressed
 *
 * Full compression validation (brotli/gzip/deflate round-trips, content negotiation)
 * is done via the post-deploy curl script against dev, which has real production-scale data.
 */
export default function compressionTests(getHttpClient, getBaseUrl, getTokens) {
  describe('Response Compression (SITES-42279)', () => {
    let baseUrl;
    let tokens;

    before(() => {
      baseUrl = getBaseUrl();
      tokens = getTokens();
    });

    it('GET /sites returns 200 with Accept-Encoding: br without errors', async () => {
      const res = await fetchRaw(baseUrl, '/sites', tokens.admin, 'br');
      expect(res.status).to.equal(200);
    });

    it('GET /sites returns 200 with Accept-Encoding: gzip without errors', async () => {
      const res = await fetchRaw(baseUrl, '/sites', tokens.admin, 'gzip');
      expect(res.status).to.equal(200);
    });

    it('GET /sites returns 200 with Accept-Encoding: deflate without errors', async () => {
      const res = await fetchRaw(baseUrl, '/sites', tokens.admin, 'deflate');
      expect(res.status).to.equal(200);
    });

    it('does not compress when Accept-Encoding is identity', async () => {
      const res = await fetchRaw(baseUrl, '/sites', tokens.admin, 'identity');
      expect(res.status).to.equal(200);
      expect(res.encoding).to.be.null;
    });

    // Note: the previous "does not compress when no Accept-Encoding header"
    // test was removed. With Node 24's global fetch (undici) auto-adding
    // Accept-Encoding, and /sites now exceeding the compression wrapper's
    // 1024-byte minSize threshold (LLMO-4176 added two seed sites), the
    // wrapper legitimately compresses the response. The "Accept-Encoding:
    // identity" case above already exercises the same wrapper short-circuit
    // (negotiateEncoding('identity') → identity → no compression).

    it('health check returns 200 with Accept-Encoding without errors', async () => {
      const res = await fetch(`${baseUrl}/_status_check/healthcheck.json`, {
        headers: { 'Accept-Encoding': 'gzip' },
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get('content-encoding')).to.be.null;
    });

    it('multiple encoding negotiation does not cause errors', async () => {
      const res = await fetchRaw(baseUrl, '/sites', tokens.admin, 'gzip, br, deflate');
      expect(res.status).to.equal(200);
    });

    it('quality values in Accept-Encoding do not cause errors', async () => {
      const res = await fetchRaw(baseUrl, '/sites', tokens.admin, 'gzip;q=1.0, br;q=0.5');
      expect(res.status).to.equal(200);
    });

    it('wildcard Accept-Encoding does not cause errors', async () => {
      const res = await fetchRaw(baseUrl, '/sites', tokens.admin, '*');
      expect(res.status).to.equal(200);
    });
  });
}
