# Apply Response Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `compressResponse` wrapper from `@adobe/spacecat-shared-http-utils@1.25.0` into spacecat-api-service's middleware chain so all API responses are automatically compressed when clients send `Accept-Encoding`.

**Architecture:** One-line wrapper addition to the existing `wrap().with()` chain in `src/index.js`. The wrapper sits as the outermost response-touching middleware - after all controllers produce a Response, but before helix-universal's adapter serializes it for Lambda. Existing manually-compressed endpoints (paid/traffic, llmo) are unaffected due to the wrapper's skip condition.

**Tech Stack:** `@adobe/spacecat-shared-http-utils@1.25.0`, `@adobe/helix-shared-wrap`, Mocha + Chai + Sinon for tests.

**Spec:** `mysticat-architecture/platform/design-response-compression-api-service.md`

**Jira:** SITES-42279

---

## File Structure

```
spacecat-api-service/
  package.json                              # MODIFY - bump http-utils dep
  src/index.js                              # MODIFY - import + .with(compressResponse)
  test/it/shared/tests/compression.js       # NEW - compression IT test factory
  test/it/postgres/compression.test.js      # NEW - postgres wiring for compression tests
```

---

### Task 1: Bump dependency

**Files:**
- Modify: `package.json:84`

- [ ] **Step 1: Update the dependency version**

In `package.json`, change:
```json
"@adobe/spacecat-shared-http-utils": "1.24.1",
```
To:
```json
"@adobe/spacecat-shared-http-utils": "1.25.0",
```

- [ ] **Step 2: Install**

Run: `npm install`

- [ ] **Step 3: Verify the new version is installed**

Run: `node -e "import('@adobe/spacecat-shared-http-utils').then(m => console.log('compressResponse' in m ? 'OK' : 'MISSING'))"`
Expected: `OK`

- [ ] **Step 4: Run existing tests to verify no regression**

Run: `npm test 2>&1 | tail -5`
Expected: All tests pass, no failures

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: bump @adobe/spacecat-shared-http-utils to 1.25.0"
```

---

### Task 2: Wire compressResponse into the wrapper chain

**Files:**
- Modify: `src/index.js:17-29` (import)
- Modify: `src/index.js:310-322` (wrapper chain)

- [ ] **Step 1: Add compressResponse to the import**

In `src/index.js`, find the import block (lines 17-29):
```js
import {
  badRequest,
  internalServerError,
  noContent,
  notFound,
  authWrapper,
  enrichPathInfo,
  LegacyApiKeyHandler,
  ScopedApiKeyHandler,
  AdobeImsHandler,
  JwtHandler,
  s2sAuthWrapper,
} from '@adobe/spacecat-shared-http-utils';
```

Add `compressResponse` to the import:
```js
import {
  badRequest,
  compressResponse,
  internalServerError,
  noContent,
  notFound,
  authWrapper,
  enrichPathInfo,
  LegacyApiKeyHandler,
  ScopedApiKeyHandler,
  AdobeImsHandler,
  JwtHandler,
  s2sAuthWrapper,
} from '@adobe/spacecat-shared-http-utils';
```

- [ ] **Step 2: Add .with(compressResponse) to the wrapper chain**

Find the wrapper chain (lines 310-322):
```js
export const main = wrappedMain
  .with(localCORSWrapper)
  .with(logWrapper)
  .with(dataAccess)
  .with(bodyData)
  .with(multipartFormData)
  .with(enrichPathInfo)
  .with(sqs)
  .with(s3ClientWrapper)
  .with(imsClientWrapper)
  .with(elevatedSlackClientWrapper, { slackTarget: WORKSPACE_EXTERNAL })
  .with(vaultSecrets)
  .with(helixStatus);
```

Add `.with(compressResponse)` before `.with(helixStatus)`:
```js
export const main = wrappedMain
  .with(localCORSWrapper)
  .with(logWrapper)
  .with(dataAccess)
  .with(bodyData)
  .with(multipartFormData)
  .with(enrichPathInfo)
  .with(sqs)
  .with(s3ClientWrapper)
  .with(imsClientWrapper)
  .with(elevatedSlackClientWrapper, { slackTarget: WORKSPACE_EXTERNAL })
  .with(vaultSecrets)
  .with(compressResponse)
  .with(helixStatus);
```

- [ ] **Step 3: Run existing tests**

Run: `npm test 2>&1 | tail -5`
Expected: All tests pass. The wrapper is transparent - it only compresses when `Accept-Encoding` is present, and unit tests don't send that header.

- [ ] **Step 4: Run lint**

Run: `npm run lint 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/index.js
git commit -m "feat: wire compressResponse wrapper into middleware chain

Adds automatic response compression (br/gzip/deflate) negotiated via
Accept-Encoding. Existing manually-compressed endpoints (paid/traffic,
llmo) are unaffected - wrapper skips responses with Content-Encoding set.

Ref: SITES-42279"
```

---

### Task 3: Add compression integration tests

**Files:**
- Modify: `test/it/postgres/harness.js:42` (expose baseUrl and tokens on ctx)
- Create: `test/it/shared/tests/compression.js`
- Create: `test/it/postgres/compression.test.js`

The IT test HTTP client uses Node's `fetch()` which does NOT auto-decompress. When `Accept-Encoding` is sent and the server returns compressed bytes, `res.text()` returns the raw compressed bytes and `JSON.parse()` fails. The compression tests need raw `fetch` calls with manual decompression. To support this, the harness must expose `baseUrl` and `tokens` on `ctx` (currently only `httpClient` is exposed).

- [ ] **Step 0: Expose baseUrl and tokens on ctx in the harness**

In `test/it/postgres/harness.js`, after line 42 (`ctx.httpClient = ...`), add:
```js
    ctx.baseUrl = baseUrl;
    ctx.tokens = tokens;
```

So the `beforeAll` becomes:
```js
  async beforeAll() {
    const { publicKeyB64 } = await initAuth();
    const tokens = await createAllTokens();

    await startPostgres();

    const env = buildEnv(publicKeyB64);
    const baseUrl = await startServer(env);

    ctx.httpClient = createHttpClient(baseUrl, tokens);
    ctx.baseUrl = baseUrl;
    ctx.tokens = tokens;
  },
```

- [ ] **Step 1: Create the shared compression test factory**

Create `test/it/shared/tests/compression.js`:

```js
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
```

- [ ] **Step 2: Create the postgres wiring file**

Create `test/it/postgres/compression.test.js`:

```js
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

import compressionTests from '../shared/tests/compression.js';

const { ctx } = global;

compressionTests(
  () => ctx.httpClient,
  () => ctx.baseUrl,
  () => ctx.tokens,
);
```

- [ ] **Step 4: Run the compression IT tests**

Run: `npx mocha --require test/it/postgres/harness.js --timeout 30000 test/it/postgres/compression.test.js 2>&1 | tail -30`
Expected: All 9 tests pass. If any fail, investigate:
- If `fetchCompressed` gets garbage: Node fetch may auto-decompress - check if `res.headers.get('content-encoding')` is null even though compression should be active
- If health check test fails: the response may be >1KB - adjust expectation
- If `getBaseUrl`/`getTokens` are wrong: check the actual ctx shape in harness.js

- [ ] **Step 5: Commit**

```bash
git add test/it/shared/tests/compression.js test/it/postgres/compression.test.js
git commit -m "test: add compression integration tests

Validates response compression across all three encodings (br, gzip,
deflate), content negotiation, skip conditions, and Vary header.

Ref: SITES-42279"
```

---

### Task 4: Pre-merge validation script (dev environment)

**Files:**
- Create: `scripts/validate-compression.sh` (temporary - delete after validation)

This script runs against the live dev API after CI deploys the PR branch.

- [ ] **Step 1: Create the validation script**

Create `scripts/validate-compression.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/validate-compression.sh <base-url> <api-key>
# Example: ./scripts/validate-compression.sh https://spacecat.experiencecloud.live/api/ci $SPACECAT_CI_ADMIN_KEY

BASE_URL="${1:?Usage: $0 <base-url> <api-key>}"
API_KEY="${2:?Usage: $0 <base-url> <api-key>}"

PASSED=0
FAILED=0

pass() { echo "  PASS: $1"; ((PASSED++)); }
fail() { echo "  FAIL: $1 - $2"; ((FAILED++)); }

echo "=== Response Compression Validation ==="
echo "Target: $BASE_URL"
echo ""

# Test 1: Brotli compression on GET /sites
echo "--- Test 1: Brotli compression ---"
RESP=$(curl -s -o /tmp/comp-test.bin -w '%{http_code}|%{header_json}' \
  -H "x-api-key: $API_KEY" -H "Accept-Encoding: br" "$BASE_URL/sites")
HTTP_CODE=$(echo "$RESP" | cut -d'|' -f1)
ENCODING=$(echo "$RESP" | cut -d'|' -f2 | node -e "
  const h = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(h['content-encoding']?.[0] || 'none');
")
if [ "$HTTP_CODE" = "200" ] && [ "$ENCODING" = "br" ]; then
  COMPRESSED=$(wc -c < /tmp/comp-test.bin)
  DECOMPRESSED=$(node -e "
    const {brotliDecompressSync}=require('zlib');
    const fs=require('fs');
    const d=brotliDecompressSync(fs.readFileSync('/tmp/comp-test.bin'));
    console.log(d.length);
    JSON.parse(d);
  " 2>&1)
  if [ $? -eq 0 ]; then
    pass "brotli (compressed=$COMPRESSED, decompressed=$DECOMPRESSED)"
  else
    fail "brotli" "decompression or JSON parse failed"
  fi
else
  fail "brotli" "status=$HTTP_CODE encoding=$ENCODING"
fi

# Test 2: Gzip compression on GET /sites
echo "--- Test 2: Gzip compression ---"
RESP=$(curl -s -o /tmp/comp-test.bin -w '%{http_code}|%{header_json}' \
  -H "x-api-key: $API_KEY" -H "Accept-Encoding: gzip" "$BASE_URL/sites")
HTTP_CODE=$(echo "$RESP" | cut -d'|' -f1)
ENCODING=$(echo "$RESP" | cut -d'|' -f2 | node -e "
  const h = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(h['content-encoding']?.[0] || 'none');
")
if [ "$HTTP_CODE" = "200" ] && [ "$ENCODING" = "gzip" ]; then
  node -e "
    const {gunzipSync}=require('zlib');
    const d=gunzipSync(require('fs').readFileSync('/tmp/comp-test.bin'));
    JSON.parse(d);
  " 2>/dev/null && pass "gzip" || fail "gzip" "decompression failed"
else
  fail "gzip" "status=$HTTP_CODE encoding=$ENCODING"
fi

# Test 3: No compression without Accept-Encoding
echo "--- Test 3: No Accept-Encoding ---"
RESP=$(curl -s -o /dev/null -w '%{http_code}|%{header_json}' \
  -H "x-api-key: $API_KEY" "$BASE_URL/sites")
HTTP_CODE=$(echo "$RESP" | cut -d'|' -f1)
ENCODING=$(echo "$RESP" | cut -d'|' -f2 | node -e "
  const h = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(h['content-encoding']?.[0] || 'none');
")
if [ "$HTTP_CODE" = "200" ] && [ "$ENCODING" = "none" ]; then
  pass "no accept-encoding -> no compression"
else
  fail "no accept-encoding" "status=$HTTP_CODE encoding=$ENCODING"
fi

# Test 4: Identity encoding
echo "--- Test 4: Identity encoding ---"
RESP=$(curl -s -o /dev/null -w '%{http_code}|%{header_json}' \
  -H "x-api-key: $API_KEY" -H "Accept-Encoding: identity" "$BASE_URL/sites")
HTTP_CODE=$(echo "$RESP" | cut -d'|' -f1)
ENCODING=$(echo "$RESP" | cut -d'|' -f2 | node -e "
  const h = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(h['content-encoding']?.[0] || 'none');
")
if [ "$HTTP_CODE" = "200" ] && [ "$ENCODING" = "none" ]; then
  pass "identity -> no compression"
else
  fail "identity" "status=$HTTP_CODE encoding=$ENCODING"
fi

# Test 5: Health check unaffected
echo "--- Test 5: Health check ---"
HC_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Accept-Encoding: gzip" "$BASE_URL/_status_check/healthcheck.json")
if [ "$HC_CODE" = "200" ]; then
  pass "health check returns 200"
else
  fail "health check" "status=$HC_CODE"
fi

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
[ "$FAILED" -eq 0 ] || exit 1
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/validate-compression.sh`

- [ ] **Step 3: Commit (will be removed after validation)**

```bash
git add scripts/validate-compression.sh
git commit -m "chore: add compression validation script for dev testing

Temporary script for pre-merge validation on dev environment.
Will be removed after successful rollout.

Ref: SITES-42279"
```

---

### Task 5: Post-merge monitoring queries

This task documents the Coralogix and CloudWatch queries to run after merging to main. No code changes - just a checklist to execute manually.

- [ ] **Step 1: Document monitoring queries in the PR description**

Add to the PR body:

```
## Post-merge monitoring (30 min)

### Coralogix
Filter: `$l.applicationname == 'spacecat-services' && $l.subsystemname == 'api-service'`

1. Compression active: `'[compression]' | count`
2. Compression errors: `'[compression] failed' | count`
3. Error rate: `$l.severity == 'error' | count by 5m`

### CloudWatch (spacecat-services--api-service)
1. Duration: p50, p95, p99 (compare to pre-deploy baseline)
2. Errors: invocation errors count
3. Throttles: throttle count (compression increases duration)
```

- [ ] **Step 2: No commit needed - this is PR documentation only**

---

### Task 6: Final verification and PR

- [ ] **Step 1: Run full unit test suite**

Run: `npm test 2>&1 | tail -10`
Expected: All tests pass

- [ ] **Step 2: Run lint**

Run: `npm run lint 2>&1 | tail -5`
Expected: No errors

- [ ] **Step 3: Run IT tests (if Docker is available)**

Run: `npx mocha --require test/it/postgres/harness.js --timeout 30000 test/it/postgres/compression.test.js 2>&1 | tail -20`
Expected: All 9 compression tests pass

- [ ] **Step 4: Push and create PR**

```bash
git push -u origin feat/apply-response-compression
```

Create PR with title: `feat: add response compression to API service`

PR body should include:
- Summary of changes
- Link to SITES-42279
- Link to the wrapper PR (spacecat-shared#1471)
- Post-merge monitoring queries from Task 5
- Rollback procedure: `git revert <merge-sha>` on main

- [ ] **Step 5: After CI deploys to dev, run validation script**

Run: `./scripts/validate-compression.sh https://spacecat.experiencecloud.live/api/ci $SPACECAT_CI_ADMIN_KEY`
Expected: 5/5 pass

- [ ] **Step 6: After validation passes, remove the validation script**

```bash
rm scripts/validate-compression.sh
git add scripts/validate-compression.sh
git commit -m "chore: remove compression validation script after successful dev validation"
git push
```
