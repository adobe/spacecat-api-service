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
import { expect } from 'chai';
import { guardProvisioningLlmoFields } from '../../src/support/llmo-config-guards.js';

describe('guardProvisioningLlmoFields', () => {
  it('returns undefined when incoming llmo is undefined', () => {
    expect(guardProvisioningLlmoFields(undefined, { cdnlogsFilter: [{ key: 'url' }] }, false))
      .to.equal(undefined);
  });

  it('returns the object unchanged for a privileged caller', () => {
    const incoming = { cdnlogsFilter: [{ key: 'incoming' }] };
    expect(guardProvisioningLlmoFields(incoming, { cdnlogsFilter: [{ key: 'stored' }] }, true))
      .to.equal(incoming);
  });

  it('preserves the stored values when a non-admin tries to change provisioning fields', () => {
    const incoming = { brand: 'b', cdnlogsFilter: [{ key: 'incoming' }] };
    const existing = { cdnlogsFilter: [{ key: 'stored' }] };
    const result = guardProvisioningLlmoFields(incoming, existing, false);
    expect(result).to.not.equal(incoming); // copied, not mutated
    expect(result.brand).to.equal('b'); // untouched field kept
    expect(result.cdnlogsFilter).to.deep.equal([{ key: 'stored' }]);
    expect(incoming.cdnlogsFilter).to.deep.equal([{ key: 'incoming' }]); // input not mutated
  });

  it('drops a provisioning field a non-admin tries to add when none was stored', () => {
    const incoming = { brand: 'b', cdnlogsFilter: [{ key: 'incoming' }] };
    const result = guardProvisioningLlmoFields(incoming, { brand: 'b' }, false);
    expect(result).to.not.have.property('cdnlogsFilter');
    expect(result.brand).to.equal('b');
  });

  it('is a no-op for a non-admin when no provisioning fields are present', () => {
    const incoming = { brand: 'b', questions: { Human: [] } };
    const result = guardProvisioningLlmoFields(incoming, { brand: 'a' }, false);
    expect(result).to.equal(incoming); // no copy needed
  });

  it('handles missing existing llmo (drops all managed fields)', () => {
    const incoming = { cdnlogsFilter: [{ key: 'y' }], cdnBucketConfig: { orgId: 'x' } };
    const result = guardProvisioningLlmoFields(incoming, undefined, false);
    expect(result).to.not.have.property('cdnlogsFilter');
    expect(result).to.not.have.property('cdnBucketConfig');
  });
});
