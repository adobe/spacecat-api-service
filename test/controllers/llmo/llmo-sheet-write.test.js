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
  publishToHlx,
  validateSheetRowPatch,
  sharepointPathFor,
  publishPathFor,
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
});
