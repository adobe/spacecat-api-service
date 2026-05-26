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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import ExcelJS from 'exceljs';

import {
  patchSheetRow,
  patchSheetRows,
  publishToHlx,
  validateSheetRowPatch,
  parseSheetRowPatch,
  sharepointPathFor,
  publishPathFor,
  isSafePathSegment,
  cellValueAsString,
  MAX_UPDATES_PER_REQUEST,
} from '../../../src/controllers/llmo/llmo-sheet-write.js';

use(sinonChai);
use(chaiAsPromised);

const buildWorkbookBuffer = async (sheets) => {
  const workbook = new ExcelJS.Workbook();
  Object.entries(sheets).forEach(([name, { headers, rows }]) => {
    const worksheet = workbook.addWorksheet(name);
    worksheet.addRow(headers);
    rows.forEach((row) => worksheet.addRow(row));
  });
  return workbook.xlsx.writeBuffer();
};

const buildStubClient = ({ initialBuffer, exists = true }) => {
  const uploaded = { buffer: null };
  const document = {
    exists: sinon.stub().resolves(exists),
    getDocumentContent: sinon.stub().resolves(Buffer.from(initialBuffer)),
    uploadRawDocument: sinon.stub().callsFake(async (buf) => {
      uploaded.buffer = buf;
    }),
  };
  return {
    sharepointClient: {
      getDocument: sinon.stub().returns(document),
    },
    document,
    uploaded,
  };
};

const log = {
  info: sinon.stub(),
  warn: sinon.stub(),
  error: sinon.stub(),
  debug: sinon.stub(),
};

describe('llmo-sheet-write', () => {
  afterEach(() => sinon.restore());

  describe('sharepointPathFor / publishPathFor', () => {
    it('builds SharePoint and publish paths with sheetType', () => {
      expect(sharepointPathFor('customer-x', 'strategic-recommendations', 'strategic-recommendations-template'))
        .to.equal('/sites/elmo-ui-data/customer-x/strategic-recommendations/strategic-recommendations-template.xlsx');
      expect(publishPathFor('customer-x', 'strategic-recommendations', 'strategic-recommendations-template'))
        .to.equal('customer-x/strategic-recommendations/strategic-recommendations-template.json');
    });

    it('omits sheetType when null', () => {
      expect(sharepointPathFor('customer-x', null, 'questions'))
        .to.equal('/sites/elmo-ui-data/customer-x/questions.xlsx');
      expect(publishPathFor('customer-x', null, 'questions'))
        .to.equal('customer-x/questions.json');
    });
  });

  describe('validateSheetRowPatch', () => {
    it('accepts a well-formed payload', () => {
      expect(validateSheetRowPatch({
        sheet: 'Semrush',
        match: { topic_id: '1' },
        values: { deleted: 'true' },
      })).to.equal(null);
    });

    it('rejects non-object data', () => {
      expect(validateSheetRowPatch(null)).to.match(/must be an object/);
      expect(validateSheetRowPatch('foo')).to.match(/must be an object/);
    });

    it('rejects missing sheet', () => {
      expect(validateSheetRowPatch({ match: { a: '1' }, values: { b: '2' } }))
        .to.match(/sheet must be a non-empty string/);
    });

    it('rejects empty match', () => {
      expect(validateSheetRowPatch({ sheet: 'S', match: {}, values: { b: '2' } }))
        .to.match(/match must be a non-empty object/);
      expect(validateSheetRowPatch({ sheet: 'S', match: null, values: { b: '2' } }))
        .to.match(/match must be a non-empty object/);
    });

    it('rejects empty values', () => {
      expect(validateSheetRowPatch({ sheet: 'S', match: { a: '1' }, values: {} }))
        .to.match(/values must be a non-empty object/);
    });

    it('rejects non-string entries in match', () => {
      expect(validateSheetRowPatch({
        sheet: 'S', match: { topic_id: 123 }, values: { deleted: 'true' },
      })).to.match(/match\.topic_id must be a string/);
    });

    it('rejects non-string entries in values', () => {
      expect(validateSheetRowPatch({
        sheet: 'S', match: { topic_id: '1' }, values: { deleted: true },
      })).to.match(/values\.deleted must be a string/);
    });
  });

  describe('parseSheetRowPatch', () => {
    const okEntry = { sheet: 'S', match: { a: '1' }, values: { b: '2' } };

    it('normalises a single-row body to a 1-element updates array', () => {
      const r = parseSheetRowPatch(okEntry);
      expect(r.error).to.equal(undefined);
      expect(r.isBatch).to.equal(false);
      expect(r.updates).to.deep.equal([okEntry]);
    });

    it('accepts a batch body with multiple entries', () => {
      const r = parseSheetRowPatch({ updates: [okEntry, okEntry] });
      expect(r.error).to.equal(undefined);
      expect(r.isBatch).to.equal(true);
      expect(r.updates).to.have.lengthOf(2);
    });

    it('rejects an empty updates array', () => {
      const r = parseSheetRowPatch({ updates: [] });
      expect(r.error).to.match(/updates must be a non-empty array/);
    });

    it('rejects an updates array over the cap', () => {
      const big = Array.from({ length: MAX_UPDATES_PER_REQUEST + 1 }, () => okEntry);
      const r = parseSheetRowPatch({ updates: big });
      expect(r.error).to.match(/at most 100/);
    });

    it('rejects updates set to a non-array value', () => {
      expect(parseSheetRowPatch({ updates: 'not-an-array' }).error)
        .to.match(/updates must be an array/);
    });

    it('reports the index of an invalid entry in a batch', () => {
      const r = parseSheetRowPatch({
        updates: [okEntry, { sheet: 'S', match: {}, values: { x: 'y' } }],
      });
      expect(r.error).to.match(/updates\[1\]\.match must be a non-empty object/);
    });

    it('reports the index of a non-object entry in a batch', () => {
      const r = parseSheetRowPatch({ updates: [okEntry, null] });
      expect(r.error).to.match(/updates\[1\] must be an object/);
    });

    it('rejects non-object request body', () => {
      expect(parseSheetRowPatch('foo').error).to.match(/must be an object/);
    });
  });

  describe('cellValueAsString', () => {
    it('returns empty string for null and undefined', () => {
      expect(cellValueAsString(null)).to.equal('');
      expect(cellValueAsString(undefined)).to.equal('');
    });

    it('passes through plain strings and stringifies numbers/booleans', () => {
      expect(cellValueAsString('hello')).to.equal('hello');
      expect(cellValueAsString(42)).to.equal('42');
      expect(cellValueAsString(true)).to.equal('true');
    });

    it('joins rich-text runs', () => {
      expect(cellValueAsString({
        richText: [{ text: 'first ' }, { text: 'prompt' }],
      })).to.equal('first prompt');
      // Handles missing/falsy run entries.
      expect(cellValueAsString({
        richText: [null, { text: 'a' }, {}, { text: 'b' }],
      })).to.equal('ab');
    });

    it('uses the formula result, or empty when the result is null/undefined', () => {
      expect(cellValueAsString({ formula: 'A1', result: 'computed' })).to.equal('computed');
      expect(cellValueAsString({ formula: 'A1', result: 42 })).to.equal('42');
      expect(cellValueAsString({ formula: 'A1', result: null })).to.equal('');
      expect(cellValueAsString({ formula: 'A1' })).to.equal('');
    });

    it('extracts the text field from hyperlink-like objects', () => {
      expect(cellValueAsString({ text: 'click me', hyperlink: 'https://example.com' }))
        .to.equal('click me');
    });

    it('falls back to String() for unknown object shapes', () => {
      expect(cellValueAsString({ unknown: 'shape' })).to.equal('[object Object]');
    });
  });

  describe('isSafePathSegment', () => {
    it('accepts alphanumerics, hyphen, and underscore', () => {
      expect(isSafePathSegment('strategic-recommendations-template')).to.equal(true);
      expect(isSafePathSegment('questions')).to.equal(true);
      expect(isSafePathSegment('snake_case_99')).to.equal(true);
      expect(isSafePathSegment('MixedCase')).to.equal(true);
    });

    it('rejects empty, traversal, slashes, dots, and non-strings', () => {
      expect(isSafePathSegment('')).to.equal(false);
      expect(isSafePathSegment('..')).to.equal(false);
      expect(isSafePathSegment('a/b')).to.equal(false);
      expect(isSafePathSegment('a\\b')).to.equal(false);
      expect(isSafePathSegment('a.json')).to.equal(false);
      expect(isSafePathSegment('with space')).to.equal(false);
      expect(isSafePathSegment(null)).to.equal(false);
      expect(isSafePathSegment(undefined)).to.equal(false);
      expect(isSafePathSegment(123)).to.equal(false);
    });
  });

  describe('publishToHlx', () => {
    it('skips publishing when no admin key is configured', async () => {
      const fetchStub = sinon.stub();
      await publishToHlx('p/q.json', log, { fetch: fetchStub, adminKey: '' });
      expect(fetchStub).to.not.have.been.called;
      expect(log.warn).to.have.been.called;
    });

    it('calls preview then live with the auth cookie', async () => {
      const fetchStub = sinon.stub().resolves({ ok: true, status: 200 });
      await publishToHlx('customer/strategic-recommendations/strategic-recommendations-template.json', log, {
        fetch: fetchStub,
        adminKey: 'secret',
      });
      expect(fetchStub).to.have.been.calledTwice;
      const previewCall = fetchStub.getCall(0);
      const liveCall = fetchStub.getCall(1);
      expect(previewCall.args[0]).to.include('/preview/adobe/project-elmo-ui-data/main/customer/strategic-recommendations/');
      expect(liveCall.args[0]).to.include('/live/adobe/project-elmo-ui-data/main/customer/strategic-recommendations/');
      expect(previewCall.args[1].headers.Cookie).to.equal('auth_token=secret');
    });

    it('warns and continues when a publish call returns non-ok', async () => {
      const fetchStub = sinon.stub();
      fetchStub.onCall(0).resolves({ ok: false, status: 503 });
      fetchStub.onCall(1).resolves({ ok: true, status: 200 });
      await publishToHlx('p/q.json', log, { fetch: fetchStub, adminKey: 'secret' });
      expect(fetchStub).to.have.been.calledTwice;
      expect(log.warn).to.have.been.called;
    });

    it('warns and continues when a publish call throws', async () => {
      const fetchStub = sinon.stub();
      fetchStub.onCall(0).rejects(new Error('network down'));
      fetchStub.onCall(1).resolves({ ok: true, status: 200 });
      await publishToHlx('p/q.json', log, { fetch: fetchStub, adminKey: 'secret' });
      expect(fetchStub).to.have.been.calledTwice;
    });
  });

  describe('patchSheetRow', () => {
    const sheets = () => ({
      Semrush: {
        headers: ['topic_id', 'prompt', 'deleted'],
        rows: [
          ['111', 'first prompt', ''],
          ['222', 'second prompt', ''],
          ['222', 'duplicate match candidate', ''],
        ],
      },
      'Citation Attempt': {
        headers: ['source_url', 'prompt', 'deleted'],
        rows: [
          ['https://x.com', 'cite prompt', ''],
        ],
      },
    });

    const baseArgs = {
      sharepointPath: '/sites/elmo-ui-data/customer/strategic-recommendations/strategic-recommendations-template.xlsx',
      publishPath: 'customer/strategic-recommendations/strategic-recommendations-template.json',
    };
    const baseEnv = { env: { ADMIN_HLX_API_KEY: 'k' }, log };

    it('updates the matching row, uploads the new workbook, and republishes', async () => {
      const initialBuffer = await buildWorkbookBuffer(sheets());
      const { sharepointClient, document, uploaded } = buildStubClient({ initialBuffer });
      const fetchStub = sinon.stub().resolves({ ok: true, status: 200 });

      const result = await patchSheetRow(
        {
          ...baseArgs,
          sheet: 'Semrush',
          match: { topic_id: '111', prompt: 'first prompt' },
          values: { deleted: 'true' },
        },
        baseEnv,
        { sharepointClient, fetch: fetchStub, adminKey: 'k' },
      );

      expect(result).to.deep.include({
        rowNumber: 2,
        updated: { deleted: 'true' },
      });
      expect(document.uploadRawDocument).to.have.been.calledOnce;
      expect(fetchStub).to.have.been.calledTwice; // preview + live

      const verifyWorkbook = new ExcelJS.Workbook();
      await verifyWorkbook.xlsx.load(uploaded.buffer);
      const semrush = verifyWorkbook.getWorksheet('Semrush');
      expect(semrush.getRow(2).getCell(3).value).to.equal('true'); // deleted column for first row
      expect(semrush.getRow(3).getCell(3).value).to.satisfy((v) => v === null || v === '' || v === undefined);
    });

    it('matches rows whose cells are stored as rich text or formula objects', async () => {
      // Build a workbook by hand so we can plant non-plain-string cell values.
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Semrush');
      worksheet.addRow(['topic_id', 'prompt', 'deleted']);
      const richTextRow = worksheet.addRow(['111', null, '']);
      richTextRow.getCell(2).value = {
        richText: [{ text: 'first ' }, { text: 'prompt' }],
      };
      const formulaRow = worksheet.addRow(['222', null, '']);
      formulaRow.getCell(2).value = { formula: 'A1', result: 'second prompt' };
      const initialBuffer = await workbook.xlsx.writeBuffer();

      const { sharepointClient, document } = buildStubClient({ initialBuffer });
      const result = await patchSheetRow(
        {
          ...baseArgs,
          sheet: 'Semrush',
          match: { topic_id: '222', prompt: 'second prompt' },
          values: { deleted: 'true' },
        },
        baseEnv,
        { sharepointClient, fetch: sinon.stub().resolves({ ok: true, status: 200 }), adminKey: 'k' },
      );
      expect(result.rowNumber).to.equal(3);
      expect(document.uploadRawDocument).to.have.been.calledOnce;
    });

    it('returns 404 when the workbook does not exist on SharePoint', async () => {
      const { sharepointClient } = buildStubClient({
        initialBuffer: await buildWorkbookBuffer(sheets()),
        exists: false,
      });
      try {
        await patchSheetRow(
          {
            ...baseArgs,
            sheet: 'Semrush',
            match: { topic_id: '111' },
            values: { deleted: 'true' },
          },
          baseEnv,
          { sharepointClient, fetch: sinon.stub() },
        );
        expect.fail('Expected patchSheetRow to throw');
      } catch (e) {
        expect(e.statusCode).to.equal(404);
        expect(e.message).to.match(/Workbook not found/);
      }
    });

    it('returns 404 when the worksheet name is not found', async () => {
      const initialBuffer = await buildWorkbookBuffer(sheets());
      const { sharepointClient } = buildStubClient({ initialBuffer });
      try {
        await patchSheetRow(
          {
            ...baseArgs,
            sheet: 'Unknown',
            match: { topic_id: '111' },
            values: { deleted: 'true' },
          },
          baseEnv,
          { sharepointClient, fetch: sinon.stub() },
        );
        expect.fail('Expected throw');
      } catch (e) {
        expect(e.statusCode).to.equal(404);
        expect(e.message).to.match(/Worksheet "Unknown" not found/);
      }
    });

    it('returns 400 when match/values reference unknown columns', async () => {
      const initialBuffer = await buildWorkbookBuffer(sheets());
      const { sharepointClient } = buildStubClient({ initialBuffer });
      try {
        await patchSheetRow(
          {
            ...baseArgs,
            sheet: 'Semrush',
            match: { topic_id: '111' },
            values: { nonexistent_column: 'true' },
          },
          baseEnv,
          { sharepointClient, fetch: sinon.stub() },
        );
        expect.fail('Expected throw');
      } catch (e) {
        expect(e.statusCode).to.equal(400);
        expect(e.message).to.match(/Unknown column/);
      }
    });

    it('returns 404 when no row matches', async () => {
      const initialBuffer = await buildWorkbookBuffer(sheets());
      const { sharepointClient } = buildStubClient({ initialBuffer });
      try {
        await patchSheetRow(
          {
            ...baseArgs,
            sheet: 'Semrush',
            match: { topic_id: 'does-not-exist' },
            values: { deleted: 'true' },
          },
          baseEnv,
          { sharepointClient, fetch: sinon.stub() },
        );
        expect.fail('Expected throw');
      } catch (e) {
        expect(e.statusCode).to.equal(404);
      }
    });

    it('returns 409 when match criteria are ambiguous', async () => {
      const initialBuffer = await buildWorkbookBuffer(sheets());
      const { sharepointClient } = buildStubClient({ initialBuffer });
      try {
        await patchSheetRow(
          {
            ...baseArgs,
            sheet: 'Semrush',
            match: { topic_id: '222' }, // matches 2 rows in fixture
            values: { deleted: 'true' },
          },
          baseEnv,
          { sharepointClient, fetch: sinon.stub() },
        );
        expect.fail('Expected throw');
      } catch (e) {
        expect(e.statusCode).to.equal(409);
        expect(e.message).to.match(/ambiguous/);
      }
    });

    it('skips publish when ADMIN_HLX_API_KEY is missing but still uploads', async () => {
      const initialBuffer = await buildWorkbookBuffer(sheets());
      const { sharepointClient, document } = buildStubClient({ initialBuffer });
      const fetchStub = sinon.stub();
      await patchSheetRow(
        {
          ...baseArgs,
          sheet: 'Semrush',
          match: { topic_id: '111', prompt: 'first prompt' },
          values: { deleted: 'true' },
        },
        { env: {}, log },
        { sharepointClient, fetch: fetchStub, adminKey: '' },
      );
      expect(document.uploadRawDocument).to.have.been.calledOnce;
      expect(fetchStub).to.not.have.been.called;
    });

    it('falls back to creating its own SharePoint client when none is injected', async () => {
      const initialBuffer = await buildWorkbookBuffer(sheets());
      const { sharepointClient, document } = buildStubClient({ initialBuffer });
      // Import dynamically with a stubbed createSharePointClient.
      const esmock = (await import('esmock')).default;
      const mod = await esmock(
        '../../../src/controllers/llmo/llmo-sheet-write.js',
        {
          '../../../src/controllers/llmo/llmo-onboarding.js': {
            createSharePointClient: sinon.stub().resolves(sharepointClient),
          },
        },
      );
      const result = await mod.patchSheetRow(
        {
          ...baseArgs,
          sheet: 'Semrush',
          match: { topic_id: '111' },
          values: { deleted: 'true' },
        },
        baseEnv,
        { fetch: sinon.stub().resolves({ ok: true, status: 200 }), adminKey: 'k' },
      );
      expect(result.rowNumber).to.equal(2);
      expect(document.uploadRawDocument).to.have.been.calledOnce;
    });
  });

  describe('patchSheetRows (batch)', () => {
    const sheets = () => ({
      Semrush: {
        headers: ['topic_id', 'prompt', 'deleted'],
        rows: [
          ['111', 'first prompt', ''],
          ['222', 'second prompt', ''],
          ['333', 'third prompt', ''],
        ],
      },
      'Citation Attempt': {
        headers: ['source_url', 'prompt', 'deleted'],
        rows: [
          ['https://x.com', 'cite prompt', ''],
        ],
      },
    });
    const baseArgs = {
      sharepointPath: '/sites/elmo-ui-data/customer/strategic-recommendations/strategic-recommendations-template.xlsx',
      publishPath: 'customer/strategic-recommendations/strategic-recommendations-template.json',
    };
    const baseEnv = { env: { ADMIN_HLX_API_KEY: 'k' }, log };

    it('applies multiple updates across worksheets in a single round-trip', async () => {
      const initialBuffer = await buildWorkbookBuffer(sheets());
      const { sharepointClient, document, uploaded } = buildStubClient({ initialBuffer });
      const fetchStub = sinon.stub().resolves({ ok: true, status: 200 });

      const { results } = await patchSheetRows(
        {
          ...baseArgs,
          updates: [
            { sheet: 'Semrush', match: { topic_id: '111', prompt: 'first prompt' }, values: { deleted: 'true' } },
            { sheet: 'Semrush', match: { topic_id: '333', prompt: 'third prompt' }, values: { deleted: 'true' } },
            { sheet: 'Citation Attempt', match: { source_url: 'https://x.com' }, values: { deleted: 'true' } },
          ],
        },
        baseEnv,
        { sharepointClient, fetch: fetchStub, adminKey: 'k' },
      );

      expect(results).to.have.lengthOf(3);
      expect(results[0]).to.deep.equal({ sheet: 'Semrush', rowNumber: 2, updated: { deleted: 'true' } });
      expect(results[1]).to.deep.equal({ sheet: 'Semrush', rowNumber: 4, updated: { deleted: 'true' } });
      expect(results[2]).to.deep.equal({ sheet: 'Citation Attempt', rowNumber: 2, updated: { deleted: 'true' } });
      // One download, one upload, one preview+live publish.
      expect(document.getDocumentContent).to.have.been.calledOnce;
      expect(document.uploadRawDocument).to.have.been.calledOnce;
      expect(fetchStub).to.have.been.calledTwice;

      // Verify all three target cells were written and the non-matching middle row was untouched.
      const verifyWorkbook = new ExcelJS.Workbook();
      await verifyWorkbook.xlsx.load(uploaded.buffer);
      const semrush = verifyWorkbook.getWorksheet('Semrush');
      // row 111 (rowNumber 2 — header is row 1)
      expect(semrush.getRow(2).getCell(3).value).to.equal('true');
      // row 222 untouched
      expect(semrush.getRow(3).getCell(3).value)
        .to.satisfy((v) => v === null || v === '' || v === undefined);
      // row 333
      expect(semrush.getRow(4).getCell(3).value).to.equal('true');
      const citation = verifyWorkbook.getWorksheet('Citation Attempt');
      expect(citation.getRow(2).getCell(3).value).to.equal('true');
    });

    it('is all-or-nothing: a single failing entry aborts the upload', async () => {
      const initialBuffer = await buildWorkbookBuffer(sheets());
      const { sharepointClient, document } = buildStubClient({ initialBuffer });

      try {
        await patchSheetRows(
          {
            ...baseArgs,
            updates: [
              { sheet: 'Semrush', match: { topic_id: '111' }, values: { deleted: 'true' } },
              { sheet: 'Semrush', match: { topic_id: 'does-not-exist' }, values: { deleted: 'true' } },
              { sheet: 'Semrush', match: { topic_id: '333' }, values: { deleted: 'true' } },
            ],
          },
          baseEnv,
          { sharepointClient, fetch: sinon.stub(), adminKey: 'k' },
        );
        expect.fail('Expected throw');
      } catch (e) {
        expect(e.statusCode).to.equal(404);
        expect(e.message).to.match(/updates\[1\]/);
      }
      // Workbook download happened, but upload + publish did not.
      expect(document.getDocumentContent).to.have.been.calledOnce;
      expect(document.uploadRawDocument).to.not.have.been.called;
    });

    it('surfaces the offending index for unknown columns and ambiguous matches', async () => {
      const initialBuffer = await buildWorkbookBuffer(sheets());
      const { sharepointClient } = buildStubClient({ initialBuffer });

      try {
        await patchSheetRows(
          {
            ...baseArgs,
            updates: [
              { sheet: 'Semrush', match: { topic_id: '111' }, values: { unknown: 'col' } },
            ],
          },
          baseEnv,
          { sharepointClient, fetch: sinon.stub() },
        );
        expect.fail('Expected throw');
      } catch (e) {
        // Single-update batches drop the prefix for back-compat with the original wording.
        expect(e.statusCode).to.equal(400);
        expect(e.message).to.match(/Unknown column/);
        expect(e.message).to.not.match(/updates\[0\]/);
      }
    });

    it('worksheet-not-found reports the entry index', async () => {
      const initialBuffer = await buildWorkbookBuffer(sheets());
      const { sharepointClient } = buildStubClient({ initialBuffer });
      try {
        await patchSheetRows(
          {
            ...baseArgs,
            updates: [
              { sheet: 'Semrush', match: { topic_id: '111' }, values: { deleted: 'true' } },
              { sheet: 'Nonexistent', match: { x: '1' }, values: { y: '2' } },
            ],
          },
          baseEnv,
          { sharepointClient, fetch: sinon.stub() },
        );
        expect.fail('Expected throw');
      } catch (e) {
        expect(e.statusCode).to.equal(404);
        expect(e.message).to.match(/updates\[1\]/);
        expect(e.message).to.match(/Nonexistent/);
      }
    });
  });
});
