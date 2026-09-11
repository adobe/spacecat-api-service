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

import {
  finalizeProjectPublish,
  handleFinalizePrompts,
  handleFinalizePromptsSubworkspace,
  FINALIZE_OUTCOME,
  MAX_FINALIZE_SLICES,
} from '../../../../src/support/serenity/handlers/prompts-finalize.js';
import { ErrorWithStatusCode } from '../../../../src/support/utils.js';
import { SerenityTransportError } from '../../../../src/support/serenity/rest-transport.js';
import { ERROR_CODES } from '../../../../src/support/serenity/errors.js';

use(chaiAsPromised);
use(sinonChai);

const WS = 'workspace-1';
const BRAND = 'brand-uuid-1';
const noopLog = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};

const row = (semrushProjectId, geoTargetId, languageCode) => ({
  getSemrushProjectId: () => semrushProjectId,
  getGeoTargetId: () => geoTargetId,
  getLanguageCode: () => languageCode,
});

describe('finalizeProjectPublish (LLMO-7533 / serenity-docs#472 §4)', () => {
  afterEach(() => sinon.restore());

  it('is a no-op for an already-live project', async () => {
    const transport = {
      getProjectStatus: sinon.stub().resolves({ publish_status: 'live' }),
      publishProject: sinon.stub().resolves(),
    };
    const result = await finalizeProjectPublish(transport, WS, 'proj-1', { log: noopLog });
    expect(result.outcome).to.equal(FINALIZE_OUTCOME.ALREADY_PUBLISHED);
    expect(transport.publishProject).to.not.have.been.called;
  });

  it('publishes a draft project and confirms it live', async () => {
    const transport = {
      getProjectStatus: sinon.stub().resolves({ publish_status: 'draft' }),
      publishProject: sinon.stub().resolves(),
    };
    const result = await finalizeProjectPublish(transport, WS, 'proj-1', {
      confirmAttempts: 1, log: noopLog,
    });
    expect(transport.publishProject).to.have.been.calledOnceWith(WS, 'proj-1');
    expect(result.outcome).to.equal(FINALIZE_OUTCOME.PENDING);
  });

  it('publishes a live_with_unpublished_updates project and reports published '
    + 'once the confirm read observes live', async () => {
    const transport = {
      getProjectStatus: sinon.stub()
        .onFirstCall().resolves({ publish_status: 'live_with_unpublished_updates' })
        .onSecondCall()
        .resolves({ publish_status: 'live' }),
      publishProject: sinon.stub().resolves(),
    };
    const result = await finalizeProjectPublish(transport, WS, 'proj-1', {
      confirmAttempts: 1, log: noopLog,
    });
    expect(transport.publishProject).to.have.been.calledOnce;
    expect(result.outcome).to.equal(FINALIZE_OUTCOME.PUBLISHED);
  });

  it('does NOT resend publish for a project already publishing — polls instead', async () => {
    const transport = {
      getProjectStatus: sinon.stub().resolves({ publish_status: 'publishing' }),
      publishProject: sinon.stub().resolves(),
    };
    const result = await finalizeProjectPublish(transport, WS, 'proj-1', {
      confirmAttempts: 1, log: noopLog,
    });
    expect(transport.publishProject).to.not.have.been.called;
    expect(result.outcome).to.equal(FINALIZE_OUTCOME.PENDING);
  });

  it('reports a terminal failure for initial_publish_failed without resending publish', async () => {
    const transport = {
      getProjectStatus: sinon.stub().resolves({ publish_status: 'initial_publish_failed' }),
      publishProject: sinon.stub().resolves(),
    };
    const result = await finalizeProjectPublish(transport, WS, 'proj-1', { log: noopLog });
    expect(transport.publishProject).to.not.have.been.called;
    expect(result.outcome).to.equal(FINALIZE_OUTCOME.FAILED);
    expect(result.error).to.equal('initial_publish_failed');
  });

  it('reports failed with a redacted message when the status read itself fails', async () => {
    const transport = {
      getProjectStatus: sinon.stub().rejects(Object.assign(new Error('boom'), { status: 502 })),
      publishProject: sinon.stub().resolves(),
    };
    const result = await finalizeProjectPublish(transport, WS, 'proj-1', { log: noopLog });
    expect(result.outcome).to.equal(FINALIZE_OUTCOME.FAILED);
    expect(transport.publishProject).to.not.have.been.called;
  });

  it('classifies a disguised-405 publish rejection as a permanent quota failure', async () => {
    const transport = {
      getProjectStatus: sinon.stub().resolves({ publish_status: 'draft' }),
      publishProject: sinon.stub().rejects(
        new SerenityTransportError(405, 'nope', '<html>method not allowed</html>'),
      ),
    };
    const result = await finalizeProjectPublish(transport, WS, 'proj-1', { log: noopLog });
    expect(result.outcome).to.equal(FINALIZE_OUTCOME.FAILED);
    expect(result.code).to.equal(ERROR_CODES.PUBLISH_QUOTA_EXHAUSTED);
    expect(result.permanent).to.equal(true);
  });

  it('reports failed when the publish call itself throws non-quota', async () => {
    const transport = {
      getProjectStatus: sinon.stub().resolves({ publish_status: 'draft' }),
      publishProject: sinon.stub().rejects(Object.assign(new Error('upstream 500'), { status: 500 })),
    };
    const result = await finalizeProjectPublish(transport, WS, 'proj-1', { log: noopLog });
    expect(result.outcome).to.equal(FINALIZE_OUTCOME.FAILED);
  });
});

describe('handleFinalizePrompts (flat mode)', () => {
  afterEach(() => sinon.restore());

  it('400s when slices is missing or empty', async () => {
    const dataAccess = { BrandSemrushProject: { allByBrandId: sinon.stub().resolves([]) } };
    await expect(handleFinalizePrompts({}, dataAccess, BRAND, WS, {}, noopLog))
      .to.be.rejectedWith(ErrorWithStatusCode, /non-empty slices array/);
    await expect(handleFinalizePrompts({}, dataAccess, BRAND, WS, { slices: [] }, noopLog))
      .to.be.rejectedWith(ErrorWithStatusCode, /non-empty slices array/);
  });

  it('resolves the project per slice through BrandSemrushProject and finalizes it', async () => {
    const dataAccess = {
      BrandSemrushProject: { allByBrandId: sinon.stub().resolves([row('proj-1', 2840, 'en')]) },
    };
    const transport = {
      getProjectStatus: sinon.stub().resolves({ publish_status: 'live' }),
      publishProject: sinon.stub().resolves(),
    };
    const result = await handleFinalizePrompts(transport, dataAccess, BRAND, WS, {
      slices: [{ geoTargetId: 2840, languageCode: 'en' }],
    }, noopLog);

    expect(result.slices).to.have.lengthOf(1);
    expect(result.slices[0]).to.include({
      geoTargetId: 2840, languageCode: 'en', outcome: FINALIZE_OUTCOME.ALREADY_PUBLISHED,
    });
  });

  it('never accepts a caller-supplied project or workspace id — only geoTargetId/languageCode '
    + 'are read from the slice', async () => {
    const dataAccess = {
      BrandSemrushProject: { allByBrandId: sinon.stub().resolves([row('real-proj', 2840, 'en')]) },
    };
    const transport = {
      getProjectStatus: sinon.stub().resolves({ publish_status: 'live' }),
      publishProject: sinon.stub().resolves(),
    };
    await handleFinalizePrompts(transport, dataAccess, BRAND, WS, {
      slices: [{
        geoTargetId: 2840, languageCode: 'en', projectId: 'attacker-supplied', workspaceId: 'attacker-ws',
      }],
    }, noopLog);

    expect(transport.getProjectStatus).to.have.been.calledOnceWith(WS, 'real-proj');
  });

  it('marketNotFound when a slice has no project, independent of other slices', async () => {
    const dataAccess = {
      BrandSemrushProject: { allByBrandId: sinon.stub().resolves([row('proj-1', 2840, 'en')]) },
    };
    const transport = {
      getProjectStatus: sinon.stub().resolves({ publish_status: 'live' }),
      publishProject: sinon.stub().resolves(),
    };
    const result = await handleFinalizePrompts(transport, dataAccess, BRAND, WS, {
      slices: [
        { geoTargetId: 2840, languageCode: 'en' },
        { geoTargetId: 9999, languageCode: 'fr' },
      ],
    }, noopLog);

    expect(result.slices[0].outcome).to.equal(FINALIZE_OUTCOME.ALREADY_PUBLISHED);
    expect(result.slices[1].outcome).to.equal(FINALIZE_OUTCOME.FAILED);
    expect(result.slices[1].code).to.equal(ERROR_CODES.MARKET_NOT_FOUND);
  });

  it('400s an individual slice missing geoTargetId/languageCode as a failed entry, not a throw', async () => {
    const dataAccess = {
      BrandSemrushProject: { allByBrandId: sinon.stub().resolves([row('proj-1', 2840, 'en')]) },
    };
    const transport = {
      getProjectStatus: sinon.stub().resolves({ publish_status: 'live' }),
      publishProject: sinon.stub().resolves(),
    };
    const result = await handleFinalizePrompts(transport, dataAccess, BRAND, WS, {
      slices: [{ languageCode: 'en' }],
    }, noopLog);

    expect(result.slices[0].outcome).to.equal(FINALIZE_OUTCOME.FAILED);
    expect(result.slices[0].error).to.match(/geoTargetId and languageCode are required/);
  });

  it('caps the echoed geoTargetId/languageCode on an invalid slice so an oversized/'
    + 'non-primitive value is never reflected verbatim', async () => {
    const dataAccess = { BrandSemrushProject: { allByBrandId: sinon.stub().resolves([]) } };
    const transport = {};
    const hugeString = 'x'.repeat(500);

    const result = await handleFinalizePrompts(transport, dataAccess, BRAND, WS, {
      slices: [{ geoTargetId: { nested: 'object' }, languageCode: hugeString }],
    }, noopLog);

    expect(result.slices[0].outcome).to.equal(FINALIZE_OUTCOME.FAILED);
    expect(result.slices[0].geoTargetId).to.equal(null);
    expect(result.slices[0].languageCode).to.have.lengthOf(200);
  });

  it(`400s when the slices array exceeds maxItems=${MAX_FINALIZE_SLICES}`, async () => {
    const dataAccess = { BrandSemrushProject: { allByBrandId: sinon.stub().resolves([]) } };
    const tooMany = Array.from(
      { length: MAX_FINALIZE_SLICES + 1 },
      (_, i) => ({ geoTargetId: 2840, languageCode: 'en', note: i }),
    );
    await expect(handleFinalizePrompts({}, dataAccess, BRAND, WS, { slices: tooMany }, noopLog))
      .to.be.rejectedWith(ErrorWithStatusCode, /slices array exceeds maxItems/);
  });

  it(
    'dedupes slices resolving to the SAME project — one finalize call, not one per slice',
    async () => {
      const dataAccess = {
        BrandSemrushProject: {
          allByBrandId: sinon.stub().resolves([
            row('shared-proj', 2840, 'en'),
            row('shared-proj', 2276, 'de'),
          ]),
        },
      };
      const transport = {
        getProjectStatus: sinon.stub().resolves({ publish_status: 'live' }),
        publishProject: sinon.stub().resolves(),
      };

      const result = await handleFinalizePrompts(transport, dataAccess, BRAND, WS, {
        slices: [
          { geoTargetId: 2840, languageCode: 'en' },
          { geoTargetId: 2276, languageCode: 'de' },
        ],
      }, noopLog);

      expect(transport.getProjectStatus).to.have.been.calledOnce;
      expect(result.slices).to.have.lengthOf(2);
      expect(result.slices[0].outcome).to.equal(FINALIZE_OUTCOME.ALREADY_PUBLISHED);
      expect(result.slices[1].outcome).to.equal(FINALIZE_OUTCOME.ALREADY_PUBLISHED);
    },
  );
});

describe('handleFinalizePromptsSubworkspace', () => {
  afterEach(() => sinon.restore());

  const proj = (id, geo, lang) => ({
    id, settings: { ai: { location: { id: geo }, language: { name: lang } } },
  });

  it('resolves the project per slice from one live listing and finalizes it', async () => {
    const transport = {
      listProjects: sinon.stub().resolves({ items: [proj('sub-proj-1', 2840, 'en')] }),
      getProjectStatus: sinon.stub().resolves({ publish_status: 'draft' }),
      publishProject: sinon.stub().resolves(),
    };
    const result = await handleFinalizePromptsSubworkspace(transport, WS, {
      slices: [{ geoTargetId: 2840, languageCode: 'en' }],
    }, noopLog);

    expect(transport.publishProject).to.have.been.calledOnceWith(WS, 'sub-proj-1');
    expect(result.slices[0].outcome).to.equal(FINALIZE_OUTCOME.PENDING);
  });

  it('marketNotFound when the slice has no matching project in the listing', async () => {
    const transport = {
      listProjects: sinon.stub().resolves({ items: [] }),
    };
    const result = await handleFinalizePromptsSubworkspace(transport, WS, {
      slices: [{ geoTargetId: 2840, languageCode: 'en' }],
    }, noopLog);

    expect(result.slices[0].outcome).to.equal(FINALIZE_OUTCOME.FAILED);
    expect(result.slices[0].code).to.equal(ERROR_CODES.MARKET_NOT_FOUND);
  });

  it('400s when slices is missing', async () => {
    const transport = { listProjects: sinon.stub().resolves({ items: [] }) };
    await expect(handleFinalizePromptsSubworkspace(transport, WS, {}, noopLog))
      .to.be.rejectedWith(ErrorWithStatusCode, /non-empty slices array/);
  });

  it('contains a project-listing failure — fails every requested slice instead of throwing '
    + 'an outer error', async () => {
    const transport = {
      listProjects: sinon.stub().rejects(Object.assign(new Error('upstream 502'), { status: 502 })),
    };

    const result = await handleFinalizePromptsSubworkspace(transport, WS, {
      slices: [
        { geoTargetId: 2840, languageCode: 'en' },
        { geoTargetId: 2276, languageCode: 'de' },
      ],
    }, noopLog);

    expect(result.slices).to.have.lengthOf(2);
    expect(result.slices[0]).to.include({
      geoTargetId: 2840, languageCode: 'en', outcome: FINALIZE_OUTCOME.FAILED,
    });
    expect(result.slices[1]).to.include({
      geoTargetId: 2276, languageCode: 'de', outcome: FINALIZE_OUTCOME.FAILED,
    });
  });

  it(
    'dedupes slices resolving to the SAME project — one finalize call, not one per slice',
    async () => {
      const transport = {
        listProjects: sinon.stub().resolves({
          items: [proj('shared-sub-proj', 2840, 'en')],
        }),
        getProjectStatus: sinon.stub().resolves({ publish_status: 'live' }),
      };

      // Both slices resolve to the same subworkspace project because the fixture
      // lists only one project — a duplicate slice, or two slices sharing a
      // market, both hit this path.
      const result = await handleFinalizePromptsSubworkspace(transport, WS, {
        slices: [
          { geoTargetId: 2840, languageCode: 'en' },
          { geoTargetId: 2840, languageCode: 'en' },
        ],
      }, noopLog);

      expect(transport.getProjectStatus).to.have.been.calledOnce;
      expect(result.slices).to.have.lengthOf(2);
      expect(result.slices[0].outcome).to.equal(FINALIZE_OUTCOME.ALREADY_PUBLISHED);
      expect(result.slices[1].outcome).to.equal(FINALIZE_OUTCOME.ALREADY_PUBLISHED);
    },
  );
});
