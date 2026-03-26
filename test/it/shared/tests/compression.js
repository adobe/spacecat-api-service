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
import { gunzipSync, brotliDecompressSync, inflateSync } from 'zlib';

function decompress(encoding, buffer) {
  switch (encoding) {
    case 'gzip': return gunzipSync(buffer);
    case 'br': return brotliDecompressSync(buffer);
    case 'deflate': return inflateSync(buffer);
    default: return buffer;
  }
}

/**
 * Fetches a URL with Accept-Encoding and returns the raw response
 * without auto-decompression, along with decompressed body.
 */
async function fetchCompressed(baseUrl, path, token, acceptEncoding) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept-Encoding': acceptEncoding,
      'x-product': 'ASO',
    },
  });

  const encoding = res.headers.get('content-encoding');
  const rawBuffer = Buffer.from(await res.arrayBuffer());

  let body;
  if (encoding) {
    const decompressed = decompress(encoding, rawBuffer);
    body = JSON.parse(decompressed.toString('utf-8'));
  } else {
    body = rawBuffer.length > 0 ? JSON.parse(rawBuffer.toString('utf-8')) : null;
  }

  return {
    status: res.status,
    headers: res.headers,
    encoding,
    rawSize: rawBuffer.length,
    body,
  };
}

export default function compressionTests(getHttpClient, getBaseUrl, getTokens) {
  describe('Response Compression (SITES-42279)', () => {
    let baseUrl;
    let tokens;

    before(() => {
      baseUrl = getBaseUrl();
      tokens = getTokens();
    });

    it('compresses GET /sites with brotli when Accept-Encoding: br', async () => {
      const res = await fetchCompressed(baseUrl, '/sites', tokens.admin, 'br');
      expect(res.status).to.equal(200);
      expect(res.encoding).to.equal('br');
      expect(res.body).to.be.an('array');
      expect(res.rawSize).to.be.greaterThan(0);
    });

    it('compresses GET /sites with gzip when Accept-Encoding: gzip', async () => {
      const res = await fetchCompressed(baseUrl, '/sites', tokens.admin, 'gzip');
      expect(res.status).to.equal(200);
      expect(res.encoding).to.equal('gzip');
      expect(res.body).to.be.an('array');
    });

    it('compresses GET /sites with deflate when Accept-Encoding: deflate', async () => {
      const res = await fetchCompressed(baseUrl, '/sites', tokens.admin, 'deflate');
      expect(res.status).to.equal(200);
      expect(res.encoding).to.equal('deflate');
      expect(res.body).to.be.an('array');
    });

    it('prefers brotli when client accepts both br and gzip', async () => {
      const res = await fetchCompressed(baseUrl, '/sites', tokens.admin, 'gzip, br');
      expect(res.status).to.equal(200);
      expect(res.encoding).to.equal('br');
    });

    it('respects quality values in Accept-Encoding', async () => {
      const res = await fetchCompressed(baseUrl, '/sites', tokens.admin, 'gzip;q=1.0, br;q=0.5');
      expect(res.status).to.equal(200);
      expect(res.encoding).to.equal('gzip');
    });

    it('does not compress when Accept-Encoding is identity', async () => {
      const res = await fetchCompressed(baseUrl, '/sites', tokens.admin, 'identity');
      expect(res.status).to.equal(200);
      expect(res.encoding).to.be.null;
      expect(res.body).to.be.an('array');
    });

    it('does not compress when no Accept-Encoding header', async () => {
      const http = getHttpClient();
      const res = await http.admin.get('/sites');
      expect(res.status).to.equal(200);
      expect(res.headers.get('content-encoding')).to.be.null;
      expect(res.body).to.be.an('array');
    });

    it('returns valid Vary header on compressed response', async () => {
      const res = await fetchCompressed(baseUrl, '/sites', tokens.admin, 'gzip');
      expect(res.headers.get('vary')).to.include('Accept-Encoding');
    });

    it('health check is not compressed (below minSize)', async () => {
      const res = await fetch(`${baseUrl}/_status_check/healthcheck.json`, {
        headers: { 'Accept-Encoding': 'gzip' },
      });
      expect(res.status).to.equal(200);
      // Health check response is tiny - below 1KB minSize threshold
      expect(res.headers.get('content-encoding')).to.be.null;
    });
  });
}
