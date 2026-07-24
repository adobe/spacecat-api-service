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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import { queryBpCitationsByUrl } from '../../../../src/support/serenity/handlers/brand-presence.js';
import { ErrorWithStatusCode } from '../../../../src/support/utils.js';

use(chaiAsPromised);
use(sinonChai);

const BRAND_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const WORKSPACE_ID = 'workspace-1';
const ELEMENT_ID = 'elem-123';
const PROJECT_ID = 'proj-abc';

const BASE_QUERY = {
  urlFragment: 'https://example.com/page',
  domain: 'example.com',
  startDate: '2026-01-01',
  endDate: '2026-01-31',
};

function makeEnv(overrides = {}) {
  return { SEMRUSH_BP_ELEMENT_ID: ELEMENT_ID, ...overrides };
}

function makeProject(semrushProjectId = PROJECT_ID) {
  return {
    getSemrushProjectId: () => semrushProjectId,
  };
}

function makeDataAccess(projects) {
  return {
    BrandSemrushProject: {
      allByBrandId: sinon.stub().resolves(projects),
    },
  };
}

function makeTransport(rawResponse = { data: { rows: [] } }) {
  return {
    queryBrandPresenceResults: sinon.stub().resolves(rawResponse),
  };
}

describe('handlers/brand-presence.js — queryBpCitationsByUrl', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('SEMRUSH_BP_ELEMENT_ID guard', () => {
    it('throws ErrorWithStatusCode(503) when env var is missing', async () => {
      const dataAccess = makeDataAccess([makeProject()]);
      const transport = makeTransport();
      await expect(
        queryBpCitationsByUrl(transport, dataAccess, BRAND_ID, WORKSPACE_ID, {}, BASE_QUERY),
      ).to.be.rejectedWith(ErrorWithStatusCode);
    });

    it('thrown error has status 503', async () => {
      const dataAccess = makeDataAccess([makeProject()]);
      const transport = makeTransport();
      try {
        await queryBpCitationsByUrl(transport, dataAccess, BRAND_ID, WORKSPACE_ID, {}, BASE_QUERY);
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).to.be.instanceOf(ErrorWithStatusCode);
        expect(e.status).to.equal(503);
      }
    });

    it('throws when SEMRUSH_BP_ELEMENT_ID is whitespace only', async () => {
      const dataAccess = makeDataAccess([makeProject()]);
      const transport = makeTransport();
      const env = makeEnv({ SEMRUSH_BP_ELEMENT_ID: '   ' });
      await expect(
        queryBpCitationsByUrl(transport, dataAccess, BRAND_ID, WORKSPACE_ID, env, BASE_QUERY),
      ).to.be.rejectedWith(ErrorWithStatusCode);
    });
  });

  describe('when BrandSemrushProject is unavailable', () => {
    it('returns null when dataAccess is null', async () => {
      const transport = makeTransport();
      const result = await queryBpCitationsByUrl(
        transport,
        null,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result).to.be.null;
    });

    it('returns null when dataAccess.BrandSemrushProject is undefined', async () => {
      const transport = makeTransport();
      const result = await queryBpCitationsByUrl(
        transport,
        {},
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result).to.be.null;
    });

    it('returns null when dataAccess.BrandSemrushProject is null', async () => {
      const transport = makeTransport();
      const result = await queryBpCitationsByUrl(
        transport,
        { BrandSemrushProject: null },
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result).to.be.null;
    });
  });

  describe('when no project rows exist for the brand', () => {
    it('returns zero-value object for an empty array', async () => {
      const dataAccess = makeDataAccess([]);
      const transport = makeTransport();
      const result = await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result).to.deep.equal({
        citations: 0, citationsByDay: [], promptsCited: 0, prompts: [],
      });
    });

    it('does not call the transport when rows list is empty', async () => {
      const dataAccess = makeDataAccess([]);
      const transport = makeTransport();
      await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(transport.queryBrandPresenceResults).to.not.have.been.called;
    });
  });

  describe('single project slice with citation rows', () => {
    it('returns correct citation count equal to number of rows', async () => {
      const rows = [
        { CBF_date: '2026-01-01', prompt: 'What is X?' },
        { CBF_date: '2026-01-01', prompt: 'Tell me about Y.' },
        { CBF_date: '2026-01-02', prompt: 'What is X?' },
      ];
      const transport = makeTransport({ data: { rows } });
      const dataAccess = makeDataAccess([makeProject()]);
      const result = await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result.citations).to.equal(3);
    });

    it('builds citationsByDay sorted by date', async () => {
      const rows = [
        { CBF_date: '2026-01-02', prompt: 'A' },
        { CBF_date: '2026-01-01', prompt: 'B' },
        { CBF_date: '2026-01-01', prompt: 'C' },
      ];
      const transport = makeTransport({ data: { rows } });
      const dataAccess = makeDataAccess([makeProject()]);
      const result = await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result.citationsByDay).to.deep.equal([
        { date: '2026-01-01', count: 2 },
        { date: '2026-01-02', count: 1 },
      ]);
    });

    it('deduplicates prompts', async () => {
      const rows = [
        { CBF_date: '2026-01-01', prompt: 'What is X?' },
        { CBF_date: '2026-01-02', prompt: 'What is X?' },
        { CBF_date: '2026-01-02', prompt: 'Unique prompt' },
      ];
      const transport = makeTransport({ data: { rows } });
      const dataAccess = makeDataAccess([makeProject()]);
      const result = await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result.promptsCited).to.equal(2);
      expect(result.prompts).to.have.deep.members([
        { prompt: 'What is X?' },
        { prompt: 'Unique prompt' },
      ]);
    });

    it('accepts alternative Prompt capitalisation', async () => {
      const rows = [{ CBF_date: '2026-01-01', Prompt: 'Capital P prompt' }];
      const transport = makeTransport({ data: { rows } });
      const dataAccess = makeDataAccess([makeProject()]);
      const result = await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result.prompts).to.deep.equal([{ prompt: 'Capital P prompt' }]);
    });

    it('accepts alternative date field name', async () => {
      const rows = [{ date: '2026-01-05', prompt: 'test' }];
      const transport = makeTransport({ data: { rows } });
      const dataAccess = makeDataAccess([makeProject()]);
      const result = await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result.citationsByDay).to.deep.equal([{ date: '2026-01-05', count: 1 }]);
    });
  });

  describe('multiple project slices', () => {
    it('sums citations across slices', async () => {
      const transport = { queryBrandPresenceResults: sinon.stub() };
      transport.queryBrandPresenceResults
        .onFirstCall().resolves({ data: { rows: [{ CBF_date: '2026-01-01', prompt: 'A' }] } })
        .onSecondCall().resolves({
          data: {
            rows: [
              { CBF_date: '2026-01-01', prompt: 'B' },
              { CBF_date: '2026-01-02', prompt: 'B' },
            ],
          },
        });
      const dataAccess = makeDataAccess([makeProject('proj-1'), makeProject('proj-2')]);
      const result = await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result.citations).to.equal(3);
    });

    it('merges citationsByDay by date with summed counts', async () => {
      const transport = { queryBrandPresenceResults: sinon.stub() };
      transport.queryBrandPresenceResults
        .onFirstCall().resolves({ data: { rows: [{ CBF_date: '2026-01-01', prompt: 'A' }] } })
        .onSecondCall().resolves({ data: { rows: [{ CBF_date: '2026-01-01', prompt: 'B' }] } });
      const dataAccess = makeDataAccess([makeProject('proj-1'), makeProject('proj-2')]);
      const result = await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result.citationsByDay).to.deep.equal([{ date: '2026-01-01', count: 2 }]);
    });

    it('produces a union of unique prompts across slices', async () => {
      const transport = { queryBrandPresenceResults: sinon.stub() };
      transport.queryBrandPresenceResults
        .onFirstCall().resolves({
          data: {
            rows: [
              { CBF_date: '2026-01-01', prompt: 'Shared' },
              { CBF_date: '2026-01-01', prompt: 'Only in slice 1' },
            ],
          },
        })
        .onSecondCall().resolves({
          data: {
            rows: [
              { CBF_date: '2026-01-02', prompt: 'Shared' },
              { CBF_date: '2026-01-02', prompt: 'Only in slice 2' },
            ],
          },
        });
      const dataAccess = makeDataAccess([makeProject('proj-1'), makeProject('proj-2')]);
      const result = await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result.promptsCited).to.equal(3);
      expect(result.prompts).to.have.deep.members([
        { prompt: 'Shared' },
        { prompt: 'Only in slice 1' },
        { prompt: 'Only in slice 2' },
      ]);
    });
  });

  describe('graceful handling of missing fields', () => {
    it('does not add null to promptSet when row has no prompt', async () => {
      const rows = [{ CBF_date: '2026-01-01' }];
      const transport = makeTransport({ data: { rows } });
      const dataAccess = makeDataAccess([makeProject()]);
      const result = await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result.citations).to.equal(1);
      expect(result.prompts).to.deep.equal([]);
      expect(result.promptsCited).to.equal(0);
    });

    it('does not add null to dayMap when row has no date', async () => {
      const rows = [{ prompt: 'No date here' }];
      const transport = makeTransport({ data: { rows } });
      const dataAccess = makeDataAccess([makeProject()]);
      const result = await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result.citations).to.equal(1);
      expect(result.citationsByDay).to.deep.equal([]);
    });
  });

  describe('unexpected upstream response shapes', () => {
    it('returns zeros when raw response is null', async () => {
      const transport = makeTransport(null);
      const dataAccess = makeDataAccess([makeProject()]);
      const result = await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result).to.deep.equal({
        citations: 0, citationsByDay: [], promptsCited: 0, prompts: [],
      });
    });

    it('returns zeros when raw response is an empty object', async () => {
      const transport = makeTransport({});
      const dataAccess = makeDataAccess([makeProject()]);
      const result = await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result).to.deep.equal({
        citations: 0, citationsByDay: [], promptsCited: 0, prompts: [],
      });
    });

    it('returns zeros when data.rows is absent', async () => {
      const transport = makeTransport({ data: {} });
      const dataAccess = makeDataAccess([makeProject()]);
      const result = await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result).to.deep.equal({
        citations: 0, citationsByDay: [], promptsCited: 0, prompts: [],
      });
    });

    it('returns zeros when data.rows is not an array', async () => {
      const transport = makeTransport({ data: { rows: 'oops' } });
      const dataAccess = makeDataAccess([makeProject()]);
      const result = await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      expect(result).to.deep.equal({
        citations: 0, citationsByDay: [], promptsCited: 0, prompts: [],
      });
    });
  });

  describe('when transport throws', () => {
    it('propagates the error to the caller', async () => {
      const transport = {
        queryBrandPresenceResults: sinon.stub().rejects(new Error('network failure')),
      };
      const dataAccess = makeDataAccess([makeProject()]);
      await expect(
        queryBpCitationsByUrl(transport, dataAccess, BRAND_ID, WORKSPACE_ID, makeEnv(), BASE_QUERY),
      ).to.be.rejectedWith('network failure');
    });
  });

  describe('buildRenderData — render_data passed to transport', () => {
    it('sets project_id from row.getSemrushProjectId()', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess([makeProject('my-project-id')]);
      await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      const [, , renderData] = transport.queryBrandPresenceResults.firstCall.args;
      expect(renderData.project_id).to.equal('my-project-id');
      expect(renderData.filters.simple.project_id).to.equal('my-project-id');
    });

    it('sets source contains filter to urlFragment', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess([makeProject()]);
      const query = { ...BASE_QUERY, urlFragment: 'https://example.com/specific-page' };
      await queryBpCitationsByUrl(transport, dataAccess, BRAND_ID, WORKSPACE_ID, makeEnv(), query);
      const [, , renderData] = transport.queryBrandPresenceResults.firstCall.args;
      const sourceFilter = renderData.filters.advanced.filters.find(
        (f) => f.col === 'source' && f.op === 'contains',
      );
      expect(sourceFilter).to.exist;
      expect(sourceFilter.val).to.equal('https://example.com/specific-page');
    });

    it('passes dates to the CBF_date filters', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess([makeProject()]);
      const query = { ...BASE_QUERY, startDate: '2026-02-01', endDate: '2026-02-28' };
      await queryBpCitationsByUrl(transport, dataAccess, BRAND_ID, WORKSPACE_ID, makeEnv(), query);
      const [, , renderData] = transport.queryBrandPresenceResults.firstCall.args;
      const { filters: advFilters } = renderData.filters.advanced;
      const startFilter = advFilters.find((f) => f.col === 'CBF_date__start');
      const endFilter = advFilters.find((f) => f.col === 'CBF_date__end');
      expect(startFilter.val).to.equal('2026-02-01');
      expect(endFilter.val).to.equal('2026-02-28');
    });

    it('passes workspaceId and elementId to queryBrandPresenceResults', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess([makeProject()]);
      const env = makeEnv({ SEMRUSH_BP_ELEMENT_ID: 'my-elem-id' });
      await queryBpCitationsByUrl(transport, dataAccess, BRAND_ID, 'my-workspace', env, BASE_QUERY);
      const [wsId, elemId] = transport.queryBrandPresenceResults.firstCall.args;
      expect(wsId).to.equal('my-workspace');
      expect(elemId).to.equal('my-elem-id');
    });

    it('uses comparison_data_formatting join', async () => {
      const transport = makeTransport();
      const dataAccess = makeDataAccess([makeProject()]);
      await queryBpCitationsByUrl(
        transport,
        dataAccess,
        BRAND_ID,
        WORKSPACE_ID,
        makeEnv(),
        BASE_QUERY,
      );
      const [, , renderData] = transport.queryBrandPresenceResults.firstCall.args;
      expect(renderData.comparison_data_formatting).to.equal('join');
    });
  });
});
