# Minimal Query Parameter for Organization Sites Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional `minimal` query parameter to `/organizations/{organizationId}/sites` that returns only `id` and `baseURL` for each site.

**Architecture:** Add `toMinimalJSON()` method to `SiteDto`, extract query parameter in controller, conditionally apply DTO transformation.

**Tech Stack:** Node.js, Mocha/Chai testing, OpenAPI 3.1

---

## File Structure

This implementation touches the following files:

- **Create:**
  - `test/dto/site.test.js` - DTO unit tests (new file)
  
- **Modify:**
  - `src/dto/site.js` - Add `toMinimalJSON()` method
  - `src/controllers/organizations.js:181-276` - Update `getSitesForOrganization()`
  - `docs/openapi/sites-api.yaml:192-221` - Add query parameter documentation
  - `docs/openapi/schemas.yaml` - Add `SiteMinimal` and `SiteMinimalList` schemas
  - `test/controllers/organizations.test.js` - Add unit tests for minimal parameter
  - `test/it/shared/tests/organizations.js` - Add integration tests for minimal parameter

---

## Task 1: Add toMinimalJSON() Method to SiteDto

**Files:**
- Create: `test/dto/site.test.js`
- Modify: `src/dto/site.js:19-87`

- [ ] **Step 1: Write failing test for toMinimalJSON()**

Create `test/dto/site.test.js`:

```javascript
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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { SiteDto } from '../../src/dto/site.js';

use(chaiAsPromised);

describe('Site DTO', () => {
  describe('toMinimalJSON', () => {
    it('returns only id and baseURL', () => {
      const mockSite = {
        getId: () => 'a1b2c3d4-e5f6-7g8h-9i0j-k11l12m13n14',
        getBaseURL: () => 'https://example.com',
        getName: () => 'Example Site',
        getOrganizationId: () => 'org-123',
        getDeliveryType: () => 'aem_edge',
        getGitHubURL: () => 'https://github.com/example/repo',
        getIsLive: () => true,
        getIsSandbox: () => false,
        getCreatedAt: () => '2024-01-20T10:00:00Z',
        getUpdatedAt: () => '2024-01-20T10:00:00Z',
        getConfig: () => ({}),
      };

      const result = SiteDto.toMinimalJSON(mockSite);

      expect(result).to.deep.equal({
        id: 'a1b2c3d4-e5f6-7g8h-9i0j-k11l12m13n14',
        baseURL: 'https://example.com',
      });
      expect(result).to.not.have.property('name');
      expect(result).to.not.have.property('organizationId');
      expect(result).to.not.have.property('deliveryType');
    });

    it('handles sites with different baseURLs correctly', () => {
      const mockSite = {
        getId: () => 'site-uuid-123',
        getBaseURL: () => 'https://another-example.org',
      };

      const result = SiteDto.toMinimalJSON(mockSite);

      expect(result).to.deep.equal({
        id: 'site-uuid-123',
        baseURL: 'https://another-example.org',
      });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/dto/site.test.js`

Expected: FAIL with "SiteDto.toMinimalJSON is not a function"

- [ ] **Step 3: Implement toMinimalJSON() in SiteDto**

Edit `src/dto/site.js`, add the method after `toListJSON`:

```javascript
  /**
   * Minimal representation returning only id and baseURL.
   * Used when clients need only basic site identification.
   * @param {Readonly<Site>} site - Site object.
   * @returns {object}
   */
  toMinimalJSON: (site) => ({
    id: site.getId(),
    baseURL: site.getBaseURL(),
  }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/dto/site.test.js`

Expected: PASS (2 tests passing)

- [ ] **Step 5: Commit**

```bash
git add test/dto/site.test.js src/dto/site.js
git commit -m "feat: add SiteDto.toMinimalJSON() method

Add minimal DTO transformation that returns only id and baseURL,
reducing payload size for clients that don't need full site objects.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Add Query Parameter Helper Function

**Files:**
- Modify: `src/controllers/organizations.js:38-56`

- [ ] **Step 1: Add getQueryParams helper function**

Add this function at the top of the file, after the imports and before the `OrganizationsController` function:

```javascript
/**
 * Parses raw query string from API Gateway-style invocation.
 * @param {object} context
 * @returns {Record<string, string>}
 */
function getQueryParams(context) {
  const rawQueryString = context.invocation?.event?.rawQueryString;
  if (!rawQueryString) return {};
  const params = {};
  rawQueryString.split('&').forEach((param) => {
    const [key, value] = param.split('=');
    if (key) {
      params[decodeURIComponent(key)] = value !== undefined
        ? decodeURIComponent(value)
        : '';
    }
  });
  return params;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/controllers/organizations.js
git commit -m "feat: add query parameter parsing helper to organizations controller

Add getQueryParams() helper to parse API Gateway query strings,
following pattern used in feature-flags controller.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Update getSitesForOrganization() to Support Minimal Parameter

**Files:**
- Modify: `src/controllers/organizations.js:181-276`

- [ ] **Step 1: Write failing test for minimal=true**

Edit `test/controllers/organizations.test.js`, add new test after existing `getSitesForOrganization` tests (find the describe block and add at the end):

```javascript
    it('returns minimal site representation when minimal=true', async () => {
      const mockOrganization = organizations[0];
      const mockSites = [sites[0]];

      Organization.findById.resolves(mockOrganization);
      Site.allByOrganizationId.resolves(mockSites);

      const context = {
        params: { organizationId: orgId },
        pathInfo: {
          headers: { 'x-product': 'llmo_optimizer' },
        },
        invocation: {
          event: {
            rawQueryString: 'minimal=true',
          },
        },
        attributes: { authInfo: adminAuthInfo },
        dataAccess: { Organization, Site },
        log: console,
      };

      const response = await organizationsController.getSitesForOrganization(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body).to.be.an('array').with.lengthOf(1);
      expect(body[0]).to.deep.equal({
        id: sites[0].getId(),
        baseURL: sites[0].getBaseURL(),
      });
      expect(body[0]).to.not.have.property('name');
      expect(body[0]).to.not.have.property('organizationId');
    });

    it('returns full site representation when minimal=false', async () => {
      const mockOrganization = organizations[0];
      const mockSites = [sites[0]];

      Organization.findById.resolves(mockOrganization);
      Site.allByOrganizationId.resolves(mockSites);

      const context = {
        params: { organizationId: orgId },
        pathInfo: {
          headers: { 'x-product': 'llmo_optimizer' },
        },
        invocation: {
          event: {
            rawQueryString: 'minimal=false',
          },
        },
        attributes: { authInfo: adminAuthInfo },
        dataAccess: { Organization, Site },
        log: console,
      };

      const response = await organizationsController.getSitesForOrganization(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body).to.be.an('array').with.lengthOf(1);
      expect(body[0]).to.have.property('name');
      expect(body[0]).to.have.property('organizationId');
      expect(body[0]).to.have.property('deliveryType');
    });

    it('returns full site representation when minimal parameter is omitted', async () => {
      const mockOrganization = organizations[0];
      const mockSites = [sites[0]];

      Organization.findById.resolves(mockOrganization);
      Site.allByOrganizationId.resolves(mockSites);

      const context = {
        params: { organizationId: orgId },
        pathInfo: {
          headers: { 'x-product': 'llmo_optimizer' },
        },
        invocation: {
          event: {
            rawQueryString: '',
          },
        },
        attributes: { authInfo: adminAuthInfo },
        dataAccess: { Organization, Site },
        log: console,
      };

      const response = await organizationsController.getSitesForOrganization(context);
      const body = await response.json();

      expect(response.status).to.equal(200);
      expect(body).to.be.an('array').with.lengthOf(1);
      expect(body[0]).to.have.property('name');
      expect(body[0]).to.have.property('organizationId');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/controllers/organizations.test.js`

Expected: FAIL - the minimal parameter is not being respected

- [ ] **Step 3: Update getSitesForOrganization() to extract and use minimal parameter**

Edit `src/controllers/organizations.js`, update the `getSitesForOrganization` method (around line 181):

Find the line that returns the result (currently line 275):
```javascript
return ok([...filteredSites, ...delegatedSites].map((site) => SiteDto.toJSON(site)));
```

Replace it with:
```javascript
// Extract minimal query parameter
const queryParams = getQueryParams(context);
const minimal = queryParams.minimal === 'true';

// Select appropriate DTO method based on minimal parameter
const dtoMethod = minimal ? SiteDto.toMinimalJSON : SiteDto.toJSON;
return ok([...filteredSites, ...delegatedSites].map(dtoMethod));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/controllers/organizations.test.js`

Expected: PASS (all tests including new minimal parameter tests)

- [ ] **Step 5: Commit**

```bash
git add src/controllers/organizations.js test/controllers/organizations.test.js
git commit -m "feat: support minimal query parameter in getSitesForOrganization

Extract minimal query parameter and conditionally apply SiteDto.toMinimalJSON()
when minimal=true, maintaining backward compatibility when parameter is omitted.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 4: Add OpenAPI Schemas

**Files:**
- Modify: `docs/openapi/schemas.yaml`

- [ ] **Step 1: Add SiteMinimal schema**

Edit `docs/openapi/schemas.yaml`, find the `Site:` schema definition (around line 514). After the complete `Site` schema definition and before `SiteList:`, add:

```yaml
SiteMinimal:
  type: object
  properties:
    id:
      description: The site ID in uuid format
      $ref: '#/Id'
    baseURL:
      description: The base URL of the site
      $ref: '#/URL'
  required:
    - id
    - baseURL
  example:
    id: 'a1b2c3d4-e5f6-7g8h-9i0j-k11l12m13n14'
    baseURL: 'https://example.com'
```

- [ ] **Step 2: Add SiteMinimalList schema**

After the `SiteList:` definition (around line 653), add:

```yaml
SiteMinimalList:
  type: array
  items:
    $ref: '#/SiteMinimal'
```

- [ ] **Step 3: Validate OpenAPI schemas**

Run: `npm run docs:lint`

Expected: SUCCESS (no validation errors)

- [ ] **Step 4: Commit**

```bash
git add docs/openapi/schemas.yaml
git commit -m "docs: add SiteMinimal and SiteMinimalList schemas

Define OpenAPI schemas for minimal site representation containing
only id and baseURL fields.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 5: Update OpenAPI Endpoint Documentation

**Files:**
- Modify: `docs/openapi/sites-api.yaml:192-221`

- [ ] **Step 1: Add minimal parameter to sites-for-organization**

Edit `docs/openapi/sites-api.yaml`, find the `sites-for-organization:` definition (line 192). Update it to:

```yaml
sites-for-organization:
  parameters:
    - $ref: './parameters.yaml#/organizationId'
    - name: minimal
      in: query
      required: false
      description: When true, returns only id and baseURL for each site. When false or omitted, returns full site objects.
      schema:
        type: boolean
        default: false
  get:
    tags:
      - organization
      - site
    summary: Retrieve all sites for an organization
    description: |
      This endpoint is useful for retrieving all sites for an organization.
      Use the minimal query parameter to reduce payload size when only basic site information is needed.
    operationId: getSitesForOrganization
    responses:
      '200':
        description: A list of sites
        content:
          application/json:
            schema:
              oneOf:
                - $ref: './schemas.yaml#/SiteList'
                - $ref: './schemas.yaml#/SiteMinimalList'
            examples:
              full:
                summary: Full site objects (minimal=false or omitted)
                value:
                  - id: 'a1b2c3d4-e5f6-7g8h-9i0j-k11l12m13n14'
                    baseURL: 'https://example.com'
                    name: 'Example Site'
                    organizationId: '9033554c-de8a-44ac-a356-09b51af8cc28'
                    deliveryType: 'aem_edge'
                    isLive: true
                    isSandbox: false
                    createdAt: '2024-01-20T10:00:00Z'
                    updatedAt: '2024-01-20T10:00:00Z'
                    config: {}
              minimal:
                summary: Minimal site objects (minimal=true)
                value:
                  - id: 'a1b2c3d4-e5f6-7g8h-9i0j-k11l12m13n14'
                    baseURL: 'https://example.com'
                  - id: 'b2c3d4e5-f6g7-h8i9-j0k1-l12m13n14o15'
                    baseURL: 'https://another-example.com'
      '400':
        $ref: './responses.yaml#/400-no-organization-id'
      '401':
        $ref: './responses.yaml#/401'
      '404':
        $ref: './responses.yaml#/404-organization-not-found-with-id'
      '500':
        $ref: './responses.yaml#/500'
    security:
      - api_key: [ ]
      - ims_key: [ ]
      - scoped_api_key: [ ]
```

- [ ] **Step 2: Validate and build OpenAPI documentation**

Run: `npm run docs:lint && npm run docs:build`

Expected: SUCCESS (validation passes, documentation builds without errors)

- [ ] **Step 3: Commit**

```bash
git add docs/openapi/sites-api.yaml
git commit -m "docs: document minimal query parameter in OpenAPI spec

Add minimal parameter documentation to /organizations/{organizationId}/sites
endpoint with examples showing both full and minimal response formats.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 6: Add Integration Tests

**Files:**
- Modify: `test/it/shared/tests/organizations.js`

- [ ] **Step 1: Write integration test for minimal parameter**

Edit `test/it/shared/tests/organizations.js`, add new tests after the existing `GET /organizations/:organizationId/sites` tests. Find the describe block for that endpoint and add these tests before the closing brace:

```javascript
      describe('with minimal query parameter', () => {
        it('admin: returns only id and baseURL when minimal=true', async () => {
          const http = getHttpClient();
          const res = await http.admin.get(`/organizations/${ORG_1_ID}/sites?minimal=true`);
          expect(res.status).to.equal(200);
          expect(res.body).to.be.an('array');
          
          // Should have at least SITE_1 for ORG_1
          expect(res.body.length).to.be.greaterThan(0);
          
          // Verify minimal format
          res.body.forEach((site) => {
            expect(site).to.have.property('id');
            expect(site).to.have.property('baseURL');
            expect(Object.keys(site)).to.have.lengthOf(2);
            expect(site).to.not.have.property('name');
            expect(site).to.not.have.property('organizationId');
            expect(site).to.not.have.property('deliveryType');
          });
          
          // Verify SITE_1 is included
          const site1 = res.body.find((s) => s.id === SITE_1_ID);
          expect(site1).to.exist;
          expect(site1.baseURL).to.be.a('string');
        });

        it('admin: returns full objects when minimal=false', async () => {
          const http = getHttpClient();
          const res = await http.admin.get(`/organizations/${ORG_1_ID}/sites?minimal=false`);
          expect(res.status).to.equal(200);
          expect(res.body).to.be.an('array');
          expect(res.body.length).to.be.greaterThan(0);
          
          // Verify full format
          res.body.forEach((site) => {
            expect(site).to.have.property('id');
            expect(site).to.have.property('baseURL');
            expect(site).to.have.property('name');
            expect(site).to.have.property('organizationId');
            expect(site).to.have.property('deliveryType');
            expect(Object.keys(site).length).to.be.greaterThan(2);
          });
        });

        it('admin: returns full objects when minimal is omitted', async () => {
          const http = getHttpClient();
          const res = await http.admin.get(`/organizations/${ORG_1_ID}/sites`);
          expect(res.status).to.equal(200);
          expect(res.body).to.be.an('array');
          expect(res.body.length).to.be.greaterThan(0);
          
          // Verify full format (backward compatibility)
          res.body.forEach((site) => {
            expect(site).to.have.property('id');
            expect(site).to.have.property('baseURL');
            expect(site).to.have.property('name');
            expect(site).to.have.property('organizationId');
            expect(site).to.have.property('deliveryType');
          });
        });

        it('user: respects minimal parameter with access control', async () => {
          const http = getHttpClient();
          const res = await http.user.get(`/organizations/${ORG_1_ID}/sites?minimal=true`);
          expect(res.status).to.equal(200);
          expect(res.body).to.be.an('array');
          
          // Verify minimal format
          res.body.forEach((site) => {
            expect(site).to.have.property('id');
            expect(site).to.have.property('baseURL');
            expect(Object.keys(site)).to.have.lengthOf(2);
          });
        });

        it('user: returns 403 for denied org regardless of minimal parameter', async () => {
          const http = getHttpClient();
          const res = await http.user.get(`/organizations/${ORG_2_ID}/sites?minimal=true`);
          expect(res.status).to.equal(403);
        });
      });
```

- [ ] **Step 2: Run integration tests**

Run: `npm run test-e2e`

Expected: PASS (all integration tests including new minimal parameter tests)

Note: If running locally, may need PostgreSQL setup. See test/it/README.md for details.

- [ ] **Step 3: Commit**

```bash
git add test/it/shared/tests/organizations.js
git commit -m "test: add integration tests for minimal query parameter

Verify minimal parameter returns only id and baseURL, respects
access control, and maintains backward compatibility.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 7: Verify Complete Implementation

**Files:**
- All modified files

- [ ] **Step 1: Run full test suite**

Run: `npm test`

Expected: PASS (all unit tests pass)

- [ ] **Step 2: Run integration tests**

Run: `npm run test-e2e`

Expected: PASS (all integration tests pass)

- [ ] **Step 3: Validate OpenAPI documentation**

Run: `npm run docs`

Expected: SUCCESS (linting and building complete without errors)

- [ ] **Step 4: Manual verification (optional)**

Start dev server and test manually:

```bash
npm start
```

In another terminal:
```bash
# Test full format (default)
curl -H "x-api-key: your-key" -H "x-product: llmo_optimizer" \
  http://localhost:3000/api/ci/organizations/{orgId}/sites

# Test minimal format
curl -H "x-api-key: your-key" -H "x-product: llmo_optimizer" \
  http://localhost:3000/api/ci/organizations/{orgId}/sites?minimal=true
```

Expected: Full format returns all fields, minimal format returns only id and baseURL

- [ ] **Step 5: Final commit (if any cleanup needed)**

If any final adjustments were made during verification:

```bash
git add .
git commit -m "chore: final cleanup for minimal parameter implementation

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Self-Review Checklist

**Spec Coverage:**
- ✅ Task 1: DTO method (`toMinimalJSON()`)
- ✅ Task 2-3: Controller query parameter extraction and conditional logic
- ✅ Task 4-5: OpenAPI schemas and endpoint documentation
- ✅ Task 6: Integration tests
- ✅ Task 7: Verification

**No Placeholders:**
- ✅ All code blocks are complete
- ✅ All test examples are concrete
- ✅ All file paths are exact
- ✅ All commands have expected outputs

**Type Consistency:**
- ✅ `toMinimalJSON` used consistently throughout
- ✅ `minimal` parameter name consistent
- ✅ Return shape `{ id, baseURL }` consistent across tasks

**Dependencies:**
- Task 2-3 depends on Task 1 (DTO method)
- Task 4-5 can run independently (documentation)
- Task 6 depends on Tasks 1-3 (implementation must exist)
- Task 7 depends on all previous tasks (final verification)

---

## Execution Notes

- Each task is independent and can be committed separately
- All tests follow TDD: write test → verify failure → implement → verify success → commit
- Backward compatibility is maintained (parameter defaults to false)
- Integration tests require PostgreSQL setup (see test/it/README.md)
- OpenAPI validation runs on each docs commit to catch schema errors early
