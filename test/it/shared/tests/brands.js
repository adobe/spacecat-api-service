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
import { ORG_1_ID } from '../seed-ids.js';

export default function brandsTests(getHttpClient, resetData) {
  describe('Brands v2 claims guidance', () => {
    before(() => resetData());

    it('creates, returns, preserves, and clears brand guidance fields', async () => {
      const http = getHttpClient();

      const createRes = await http.admin.post(
        `/v2/orgs/${ORG_1_ID}/brands`,
        {
          name: 'Claims Guidance Brand',
          brandContext: '  Context for claims extraction  ',
          mentionSentimentGuidance: '  Sentiment guidance text  ',
          region: ['US'],
        },
      );
      expect(createRes.status).to.equal(201);
      expect(createRes.body.brandContext).to.equal('Context for claims extraction');
      expect(createRes.body.mentionSentimentGuidance).to.equal('Sentiment guidance text');
      const { id: brandId } = createRes.body;

      const getRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands/${brandId}`);
      expect(getRes.status).to.equal(200);
      expect(getRes.body.brandContext).to.equal('Context for claims extraction');
      expect(getRes.body.mentionSentimentGuidance).to.equal('Sentiment guidance text');

      const listRes = await http.admin.get(`/v2/orgs/${ORG_1_ID}/brands`);
      expect(listRes.status).to.equal(200);
      const listed = listRes.body.brands.find((brand) => brand.id === brandId);
      expect(listed.brandContext).to.equal('Context for claims extraction');
      expect(listed.mentionSentimentGuidance).to.equal('Sentiment guidance text');

      const preserveRes = await http.admin.patch(
        `/v2/orgs/${ORG_1_ID}/brands/${brandId}`,
        { description: 'Updated without guidance fields' },
      );
      expect(preserveRes.status).to.equal(200);
      expect(preserveRes.body.brandContext).to.equal('Context for claims extraction');
      expect(preserveRes.body.mentionSentimentGuidance).to.equal('Sentiment guidance text');

      const clearRes = await http.admin.patch(
        `/v2/orgs/${ORG_1_ID}/brands/${brandId}`,
        {
          brandContext: null,
          mentionSentimentGuidance: '   ',
        },
      );
      expect(clearRes.status).to.equal(200);
      expect(clearRes.body.brandContext).to.equal(null);
      expect(clearRes.body.mentionSentimentGuidance).to.equal(null);
    });

    it('rejects invalid brand guidance payloads', async () => {
      const http = getHttpClient();

      const wrongType = await http.admin.post(
        `/v2/orgs/${ORG_1_ID}/brands`,
        { name: 'Bad Claims Guidance Brand', brandContext: { value: 'wrong' } },
      );
      expect(wrongType.status).to.equal(400);

      const tooLong = await http.admin.post(
        `/v2/orgs/${ORG_1_ID}/brands`,
        {
          name: 'Long Claims Guidance Brand',
          mentionSentimentGuidance: 'x'.repeat(4001),
        },
      );
      expect(tooLong.status).to.equal(400);
    });
  });
}
