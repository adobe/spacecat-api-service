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
  getRotationConfig,
  shouldRotate,
  computePhase,
  computeWindow,
  relabelCannedToCurrent,
  toCannedSegments,
  combineSingleRow,
  combineGroupedRows,
  cannedBlockRange,
  relabelAndFilterSeries,
  ROTATION_CONFIG,
} from '../../../src/controllers/llmo/traffic-rotation.js';

// anchor Monday of the canned block (2026-01-05 is a Monday).
const CONFIG = { cannedAnchorMonday: '2026-01-05', agentic: true, referral: true };
const D = (s) => new Date(`${s}T00:00:00Z`);

describe('traffic-rotation engine', () => {
  describe('site gating', () => {
    it('recognises configured sites and datasets', () => {
      const [siteId] = Object.keys(ROTATION_CONFIG);
      expect(getRotationConfig(siteId)).to.not.equal(null);
      expect(getRotationConfig('not-a-demo-site')).to.equal(null);
      expect(shouldRotate(siteId, 'referral')).to.equal(true);
    });

    it('honours the per-dataset flag (referral-only site does not rotate agentic)', () => {
      const referralOnly = Object.keys(ROTATION_CONFIG)
        .find((id) => ROTATION_CONFIG[id].agentic === false);
      expect(shouldRotate(referralOnly, 'agentic')).to.equal(false);
      expect(shouldRotate(referralOnly, 'referral')).to.equal(true);
    });
  });

  describe('computePhase', () => {
    it('cycles 0→1→2→3→0 on successive Mondays', () => {
      expect(computePhase(D('2026-01-05'), CONFIG, 'agentic')).to.equal(0);
      expect(computePhase(D('2026-01-12'), CONFIG, 'agentic')).to.equal(1);
      expect(computePhase(D('2026-01-19'), CONFIG, 'agentic')).to.equal(2);
      expect(computePhase(D('2026-01-26'), CONFIG, 'agentic')).to.equal(3);
      expect(computePhase(D('2026-02-02'), CONFIG, 'agentic')).to.equal(0);
    });

    it('is constant within an ISO week (mid-week and Sunday match Monday)', () => {
      expect(computePhase(D('2026-01-15'), CONFIG, 'agentic')).to.equal(1); // Thursday
      expect(computePhase(D('2026-01-18'), CONFIG, 'agentic')).to.equal(1); // Sunday
    });
  });

  describe('computeWindow', () => {
    it('returns 4 Monday-started weeks, newest first, ending on the last completed week', () => {
      const { weeks } = computeWindow(D('2026-02-02'));
      expect(weeks).to.have.length(4);
      // now=Feb 2 (Mon). Current week (Feb 2–8) is excluded; newest = last completed.
      expect(weeks[0].startDate).to.equal('2026-01-26'); // newest = last completed week
      expect(weeks[3].startDate).to.equal('2026-01-05'); // oldest = P0 = thisMonday−28
      weeks.forEach((w) => expect(D(w.startDate).getUTCDay()).to.equal(1)); // Monday
    });
  });

  describe('relabelCannedToCurrent', () => {
    it('preserves day-of-week and maps a frozen week to its rotated window slot', () => {
      // phase 0 (now = anchor + 4wk ⇒ P0 = thisMonday−28 = anchor): identity.
      expect(relabelCannedToCurrent('2026-01-28', CONFIG, 'agentic', D('2026-02-02')))
        .to.equal('2026-01-28');
      // phase 1 (now = anchor + 5wk, P0 = 2026-01-12): frozen week 0 (Wed 2026-01-07)
      // rotates to the newest slot j3 → 2026-02-04, Wednesday preserved.
      const out = relabelCannedToCurrent('2026-01-07', CONFIG, 'agentic', D('2026-02-09'));
      expect(out).to.equal('2026-02-04');
      expect(D(out).getUTCDay()).to.equal(D('2026-01-07').getUTCDay());
    });

    it('returns null for a date outside the 4-week canned block', () => {
      expect(relabelCannedToCurrent('2025-12-01', CONFIG, 'agentic', D('2026-02-02'))).to.equal(null);
      expect(relabelCannedToCurrent('2026-03-01', CONFIG, 'agentic', D('2026-02-02'))).to.equal(null);
    });
  });

  describe('toCannedSegments', () => {
    it('maps the full window to a single contiguous canned block', () => {
      // now=2026-01-12 (phase 1) ⇒ P0=2025-12-15, window = [Dec 15, Jan 11].
      const now = D('2026-01-12');
      const segs = toCannedSegments('2025-12-15', '2026-01-11', CONFIG, 'agentic', now);
      expect(segs).to.deep.equal([{ start: '2026-01-05', end: '2026-02-01' }]);
    });

    it('splits a wrap-spanning sub-range into 2 non-contiguous segments', () => {
      // now=2026-01-12 (phase 1): window slots map to frozen weeks [1,2,3,0].
      // The last two slots (j2,j3 = Dec 29–Jan 11) → frozen {3,0} (non-contiguous).
      const now = D('2026-01-12');
      const segs = toCannedSegments('2025-12-29', '2026-01-11', CONFIG, 'agentic', now);
      expect(segs).to.deep.equal([
        { start: '2026-01-05', end: '2026-01-11' },
        { start: '2026-01-26', end: '2026-02-01' },
      ]);
    });

    it('maps a single week to one segment', () => {
      // newest completed slot (j3 = Jan 5–11) at now=2026-01-12.
      const now = D('2026-01-12');
      const segs = toCannedSegments('2026-01-05', '2026-01-11', CONFIG, 'agentic', now);
      expect(segs).to.have.length(1);
    });

    it('clamps and returns [] for a range entirely before the window', () => {
      const now = D('2026-01-12');
      expect(toCannedSegments('2025-01-01', '2025-01-07', CONFIG, 'agentic', now)).to.deep.equal([]);
    });
  });

  describe('combineSingleRow', () => {
    it('sums additive metrics and total-weights rates (exact for total-denominated)', () => {
      const segs = [
        [{ total_hits: 100, success_rate: 0.9 }],
        [{ total_hits: 300, success_rate: 0.5 }],
      ];
      const out = combineSingleRow(segs, {
        additiveKeys: ['total_hits'], rateKeys: ['success_rate'], weightKey: 'total_hits',
      });
      expect(out.total_hits).to.equal(400);
      expect(out.success_rate).to.equal(0.6); // (0.9*100 + 0.5*300) / 400
    });

    it('returns a fresh copy of a single segment (never a live RPC reference)', () => {
      const row = { total_hits: 7, success_rate: 0.5 };
      const out = combineSingleRow([[row]], {
        additiveKeys: ['total_hits'], rateKeys: ['success_rate'], weightKey: 'total_hits',
      });
      expect(out).to.deep.equal(row);
      expect(out).to.not.equal(row); // copy, not the same reference
    });

    it('yields null rate when total weight is 0', () => {
      const out = combineSingleRow([[{ total_hits: 0, success_rate: null }], [{ total_hits: 0 }]], {
        additiveKeys: ['total_hits'], rateKeys: ['success_rate'], weightKey: 'total_hits',
      });
      expect(out.success_rate).to.equal(null);
    });
  });

  describe('combineGroupedRows', () => {
    it('groups across segments, sums additive, sorts by weight desc', () => {
      const segs = [
        [{ region: 'US', total_hits: 10 }, { region: 'EU', total_hits: 5 }],
        [{ region: 'US', total_hits: 20 }],
      ];
      const out = combineGroupedRows(segs, {
        groupKeys: ['region'],
        additiveKeys: ['total_hits'],
        weightKey: 'total_hits',
        config: CONFIG,
        dataset: 'agentic',
        now: D('2026-01-12'),
      });
      expect(out).to.deep.equal([
        { region: 'US', total_hits: 30 },
        { region: 'EU', total_hits: 5 },
      ]);
    });

    it('relabels a nested trend on the single-segment path', () => {
      const seg = [{
        host: 'a',
        url_path: '/',
        total_hits: 5,
        hits_trend: [{ week_start: '2026-01-28', value: 2 }],
      }];
      const [row] = combineGroupedRows([seg], {
        groupKeys: ['host', 'url_path'],
        additiveKeys: ['total_hits'],
        weightKey: 'total_hits',
        trend: { key: 'hits_trend', dateField: 'week_start' },
        config: CONFIG,
        dataset: 'agentic',
        now: D('2026-02-02'), // phase 0, P0 = anchor ⇒ identity relabel
      });
      expect(row.hits_trend[0].week_start).to.equal('2026-01-28');
    });

    it('unions array fields and derives distinct counts from the union (not a sum)', () => {
      const segs = [
        [{
          agent_type: 'x', total_hits: 1, unique_agents: 1, unique_agent_names: ['a'],
        }],
        [{
          agent_type: 'x', total_hits: 1, unique_agents: 1, unique_agent_names: ['b', 'a'],
        }],
      ];
      const [row] = combineGroupedRows(segs, {
        groupKeys: ['agent_type'],
        additiveKeys: ['total_hits'],
        weightKey: 'total_hits',
        unionKeys: ['unique_agent_names'],
        countFromUnion: { unique_agents: 'unique_agent_names' },
        config: CONFIG,
        dataset: 'agentic',
        now: D('2026-01-12'),
      });
      expect(row.unique_agent_names.sort()).to.deep.equal(['a', 'b']);
      // 'a' is in both segments; count must be union cardinality (2), not 1+1.
      expect(row.unique_agents).to.equal(2);
    });

    it('does not collide distinct multi-key group tuples with a shared space-join', () => {
      const segs = [
        [{ host: 'a', url_path: 'b c', total_hits: 5 }],
        [{ host: 'a b', url_path: 'c', total_hits: 7 }],
      ];
      const out = combineGroupedRows(segs, {
        groupKeys: ['host', 'url_path'],
        additiveKeys: ['total_hits'],
        weightKey: 'total_hits',
        config: CONFIG,
        dataset: 'agentic',
        now: D('2026-01-12'),
      });
      expect(out).to.have.length(2); // must NOT merge into one bogus group
    });

    it('multi-segment: weighted rates, carried scalars, and relabeled+sorted trend', () => {
      const now = D('2026-02-02'); // phase 0, P0 = 2026-01-12
      const segs = [
        [{
          host: 'a',
          url_path: '/x',
          total_hits: 100,
          success_rate: 0.9,
          top_agent: 'GPTBot',
          hits_trend: [{ week_start: '2026-01-05', value: 1 }],
        }],
        [{
          host: 'a',
          url_path: '/x',
          total_hits: 300,
          success_rate: 0.5,
          top_agent: 'Bingbot',
          hits_trend: [{ week_start: '2026-01-12', value: 2 }],
        }],
      ];
      const [row] = combineGroupedRows(segs, {
        groupKeys: ['host', 'url_path'],
        additiveKeys: ['total_hits'],
        rateKeys: ['success_rate'],
        weightKey: 'total_hits',
        carryKeys: ['top_agent'],
        trend: { key: 'hits_trend', dateField: 'week_start' },
        config: CONFIG,
        dataset: 'agentic',
        now,
      });
      expect(row.total_hits).to.equal(400);
      expect(row.success_rate).to.equal(0.6); // (0.9*100 + 0.5*300)/400
      expect(row.top_agent).to.equal('Bingbot'); // carried from the heaviest segment
      expect(row.hits_trend.map((p) => p.week_start)).to.deep.equal(['2026-01-05', '2026-01-12']);
    });

    it('caps merged rows to `limit`, keeping the top-weighted', () => {
      const segs = [
        [{ region: 'US', total_hits: 30 }, { region: 'EU', total_hits: 20 }],
        [{ region: 'APAC', total_hits: 25 }],
      ];
      const out = combineGroupedRows(segs, {
        groupKeys: ['region'],
        additiveKeys: ['total_hits'],
        weightKey: 'total_hits',
        limit: 2,
        config: CONFIG,
        dataset: 'agentic',
        now: D('2026-01-12'),
      });
      expect(out.map((r) => r.region)).to.deep.equal(['US', 'APAC']);
    });
  });

  describe('cannedBlockRange', () => {
    it('spans the full 4-week canned block', () => {
      expect(cannedBlockRange(CONFIG, 'agentic')).to.deep.equal({
        p_start_date: '2026-01-05', p_end_date: '2026-02-01',
      });
    });
  });

  describe('relabelAndFilterSeries', () => {
    it('relabels canned dates to current and filters to the requested window', () => {
      const now = D('2026-02-02'); // phase 0, P0 = anchor ⇒ identity relabel; window [Jan 5, Feb 1]
      const rows = [
        { period_start: '2026-01-05', total_hits: 1 }, // frozen week 0 → Jan 5
        { period_start: '2026-01-26', total_hits: 4 }, // frozen week 3 → Jan 26
        { period_start: '2025-12-01', total_hits: 9 }, // outside block → dropped
      ];
      const out = relabelAndFilterSeries(rows, 'period_start', {
        config: CONFIG, dataset: 'agentic', now, startStr: '2026-01-05', endStr: '2026-02-01',
      });
      expect(out.map((r) => r.period_start)).to.deep.equal(['2026-01-05', '2026-01-26']);
      // ascending order preserved
      expect(out[0].total_hits).to.equal(1);
    });
  });
});
