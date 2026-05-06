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
import sinon from 'sinon';
import { enableExperimentTrackingHandler } from '../../../src/controllers/strategy/experiment-tracking.js';

const makeReq = (params, body, actor = 'tester') => ({ params, body, auth: { actor } });
const makeRes = () => {
  const r = { status: sinon.stub(), json: sinon.stub() };
  r.status.returns(r);
  r.json.returns(r);
  return r;
};

const validBody = {
  experimentId: '11111111-1111-4111-8111-111111111111',
  provider: 'geo-experiment',
};

describe('POST /sites/:siteId/strategies/:strategyId/experiment-tracking', () => {
  let deps;
  beforeEach(() => {
    deps = {
      getStrategy: sinon.stub(),
      persist: sinon.stub().resolves(),
      audit: sinon.stub().resolves(),
      linkGeoExperiment: sinon.stub().resolves({ ok: true }),
    };
  });

  it('400 on bad body', async () => {
    const res = makeRes();
    await enableExperimentTrackingHandler(deps)(
      makeReq(
        { siteId: 's1', strategyId: 'st1' },
        { experimentId: 'bad', provider: 'geo-experiment' },
      ),
      res,
    );
    expect(res.status.calledWith(400)).to.equal(true);
  });

  it('404 when strategy missing', async () => {
    deps.getStrategy.resolves(null);
    const res = makeRes();
    await enableExperimentTrackingHandler(deps)(
      makeReq({ siteId: 's1', strategyId: 'st1' }, validBody),
      res,
    );
    expect(res.status.calledWith(404)).to.equal(true);
  });

  it('423 when strategy state != completed', async () => {
    deps.getStrategy.resolves({ id: 'st1', status: 'draft', experimentId: null });
    const res = makeRes();
    await enableExperimentTrackingHandler(deps)(
      makeReq({ siteId: 's1', strategyId: 'st1' }, validBody),
      res,
    );
    expect(res.status.calledWith(423)).to.equal(true);
  });

  it('409 when experimentId already set', async () => {
    deps.getStrategy.resolves({ id: 'st1', status: 'completed', experimentId: 'old' });
    const res = makeRes();
    await enableExperimentTrackingHandler(deps)(
      makeReq({ siteId: 's1', strategyId: 'st1' }, validBody),
      res,
    );
    expect(res.status.calledWith(409)).to.equal(true);
  });

  it('502 when GeoExperiment link fails', async () => {
    deps.getStrategy.resolves({ id: 'st1', status: 'completed', experimentId: null });
    deps.linkGeoExperiment.resolves({ ok: false, reason: 'down' });
    const res = makeRes();
    await enableExperimentTrackingHandler(deps)(
      makeReq({ siteId: 's1', strategyId: 'st1' }, validBody),
      res,
    );
    expect(res.status.calledWith(502)).to.equal(true);
  });

  it('200 happy path persists only experimentId and audits', async () => {
    const strategy = {
      id: 'st1', status: 'completed', experimentId: null, name: 'A', updatedAt: 'old',
    };
    deps.getStrategy.resolves(strategy);
    const res = makeRes();
    await enableExperimentTrackingHandler(deps)(
      makeReq({ siteId: 's1', strategyId: 'st1' }, validBody),
      res,
    );
    expect(res.status.calledWith(200)).to.equal(true);
    const persisted = deps.persist.firstCall.args[0];
    expect(persisted.experimentId).to.equal(validBody.experimentId);
    expect(persisted.name).to.equal('A');
    expect(persisted.updatedAt).to.not.equal('old');
    expect(deps.audit.calledOnce).to.equal(true);
  });
});
