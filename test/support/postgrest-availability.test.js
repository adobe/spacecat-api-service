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

import {
  requirePostgrest,
  requirePostgrestForV2Config,
  requirePostgrestForFacsMappings,
} from '../../src/support/postgrest-availability.js';

describe('postgrest-availability', () => {
  function ctxWith(client) {
    return { dataAccess: { services: { postgrestClient: client } } };
  }

  describe('requirePostgrest', () => {
    it('returns null when postgrestClient.from is callable', () => {
      const guard = requirePostgrest(ctxWith({ from: () => {} }), {
        errorMessage: 'irrelevant',
      });
      expect(guard).to.equal(null);
    });

    it('returns a 503 Response with the supplied error message when postgrestClient is absent', async () => {
      const guard = requirePostgrest({}, { errorMessage: 'feature requires Postgres' });
      // createResponse from spacecat-shared-http-utils returns its own
      // Response subclass (from @adobe/fetch), not the global Response.
      // Assert via duck-typing on status + body.
      expect(guard).to.have.property('status', 503);
      const body = await guard.json();
      expect(body).to.deep.equal({ message: 'feature requires Postgres' });
    });

    it('returns 503 when context has no dataAccess at all', () => {
      const guard = requirePostgrest({}, { errorMessage: 'nope' });
      expect(guard.status).to.equal(503);
    });

    it('returns 503 when postgrestClient lacks the .from method', () => {
      const guard = requirePostgrest(ctxWith({}), { errorMessage: 'nope' });
      expect(guard.status).to.equal(503);
    });

    it('returns 503 when context is undefined', () => {
      const guard = requirePostgrest(undefined, { errorMessage: 'nope' });
      expect(guard.status).to.equal(503);
    });
  });

  describe('requirePostgrestForV2Config (alias)', () => {
    it('surfaces the V2 customer-config error message', async () => {
      const guard = requirePostgrestForV2Config({});
      const body = await guard.json();
      expect(body.message).to.equal(
        'V2 customer config requires Postgres (DATA_SERVICE_PROVIDER=postgres)',
      );
    });

    it('returns null when postgrest is available', () => {
      const guard = requirePostgrestForV2Config(ctxWith({ from: () => {} }));
      expect(guard).to.equal(null);
    });
  });

  describe('requirePostgrestForFacsMappings (alias)', () => {
    it('surfaces the FACS state-layer error message', async () => {
      const guard = requirePostgrestForFacsMappings({});
      const body = await guard.json();
      expect(body.message).to.equal(
        'FACS state-layer endpoints require Postgres (DATA_SERVICE_PROVIDER=postgres)',
      );
    });

    it('returns null when postgrest is available', () => {
      const guard = requirePostgrestForFacsMappings(ctxWith({ from: () => {} }));
      expect(guard).to.equal(null);
    });
  });
});
