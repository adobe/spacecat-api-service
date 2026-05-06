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
import sinon from 'sinon';
import chaiAsPromised from 'chai-as-promised';
import {
  saveStrategyWithLockException,
  LockExceptionError,
} from '../../../src/support/strategy/save-with-lock-exception.js';

use(chaiAsPromised);

describe('saveStrategyWithLockException', () => {
  const baseStrategy = {
    id: 's1',
    siteId: 'site1',
    status: 'completed',
    experimentId: null,
    name: 'A',
    updatedAt: '2026-05-01T00:00:00Z',
  };

  it('writes only allowed fields and bumps updatedAt', async () => {
    const persist = sinon.stub().resolves();
    const audit = sinon.stub().resolves();
    const result = await saveStrategyWithLockException(
      baseStrategy,
      { experimentId: 'e1' },
      {
        allowedFields: ['experimentId'], persist, audit, actor: 'tester',
      },
    );
    expect(result.experimentId).to.equal('e1');
    expect(result.name).to.equal('A');
    expect(result.updatedAt).to.not.equal(baseStrategy.updatedAt);
    expect(persist.calledOnce).to.equal(true);
    expect(audit.calledOnce).to.equal(true);
    expect(audit.firstCall.args[0]).to.deep.include({
      action: 'lock-exception-write',
      strategyId: 's1',
      actor: 'tester',
    });
    expect(audit.firstCall.args[0].fields).to.deep.equal(['experimentId']);
  });

  it('rejects writes outside the allowlist', async () => {
    const persist = sinon.stub().resolves();
    await expect(
      saveStrategyWithLockException(
        baseStrategy,
        { name: 'hacked' },
        {
          allowedFields: ['experimentId'], persist, audit: sinon.stub(), actor: 't',
        },
      ),
    ).to.be.rejectedWith(LockExceptionError);
    expect(persist.called).to.equal(false);
  });
});
