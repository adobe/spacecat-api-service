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
  joinResponsesToSources,
  diffDayExecutions,
} from '../../../../src/support/elements/definitions/response-feed.js';

const DATE = '2026-08-24';

const answer = (overrides = {}) => ({
  projectId: 'proj-1',
  prompt: 'best running shoes',
  model: 'chatgpt-paid',
  modelNameCbfValue: 'ChatGPT Paid',
  response: 'The best running shoes are ...',
  position: 1,
  tags: 'type__branded',
  ...overrides,
});

const cite = (overrides = {}) => ({
  projectId: 'proj-1',
  prompt: 'best running shoes',
  model: 'chatgpt-paid',
  date: DATE,
  url: 'https://a.example/1',
  source: 'a.example',
  position: 1,
  domainType: 'Earned',
  executionId: 'e1',
  tags: '',
  ...overrides,
});

describe('response-feed join', () => {
  describe('joinResponsesToSources', () => {
    it('pairs an answer with its own sources on (project, prompt, model, date)', () => {
      const { records } = joinResponsesToSources(
        [answer()],
        [cite(), cite({ url: 'https://b.example/2', source: 'b.example', position: 2 })],
        { date: DATE },
      );
      expect(records).to.have.lengthOf(1);
      expect(records[0].response).to.equal('The best running shoes are ...');
      expect(records[0].date).to.equal(DATE);
      expect(records[0].sources.map((s) => s.url))
        .to.deep.equal(['https://a.example/1', 'https://b.example/2']);
      expect(records[0].sourceRowCount).to.equal(2);
    });

    it('orders sources by the aggregate position column', () => {
      const { records } = joinResponsesToSources(
        [answer()],
        [
          cite({ url: 'https://third', position: 30 }),
          cite({ url: 'https://first', position: 1 }),
          cite({ url: 'https://second', position: 7 }),
        ],
        { date: DATE },
      );
      expect(records[0].sources.map((s) => s.url))
        .to.deep.equal(['https://first', 'https://second', 'https://third']);
    });

    it('does NOT pair sources from a different model', () => {
      const { records } = joinResponsesToSources(
        [answer({ model: 'chatgpt-paid' })],
        [cite({ model: 'claude-sonnet-4' })],
        { date: DATE },
      );
      expect(records[0].sources).to.deep.equal([]);
      expect(records[0].sourceRowCount).to.equal(0);
    });

    it('does NOT pair sources from a different day', () => {
      const { records } = joinResponsesToSources(
        [answer()],
        [cite({ date: '2026-08-23' })],
        { date: DATE },
      );
      expect(records[0].sources).to.deep.equal([]);
    });

    it('does NOT pair sources from a different project', () => {
      const { records } = joinResponsesToSources(
        [answer({ projectId: 'proj-1' })],
        [cite({ projectId: 'proj-2' })],
        { date: DATE },
      );
      expect(records[0].sources).to.deep.equal([]);
    });

    it('does NOT pair sources from a different prompt', () => {
      const { records } = joinResponsesToSources(
        [answer({ prompt: 'a' })],
        [cite({ prompt: 'b' })],
        { date: DATE },
      );
      expect(records[0].sources).to.deep.equal([]);
    });

    it('keeps an answer with no sources rather than dropping it — absence is meaningful', () => {
      const { records } = joinResponsesToSources([answer()], [], { date: DATE });
      expect(records).to.have.lengthOf(1);
      expect(records[0].sources).to.deep.equal([]);
      expect(records[0].sourceRowCount).to.equal(0);
    });

    it('reports source rows that matched no answer instead of discarding them', () => {
      const { records, unmatchedSourceKeys } = joinResponsesToSources(
        [answer()],
        [cite(), cite({ prompt: 'an orphaned prompt' })],
        { date: DATE },
      );
      expect(records).to.have.lengthOf(1);
      expect(unmatchedSourceKeys).to.have.lengthOf(1);
      expect(unmatchedSourceKeys[0]).to.contain('an orphaned prompt');
    });

    it('routes each answer to its own sources when models differ on one prompt', () => {
      const { records, unmatchedSourceKeys } = joinResponsesToSources(
        [answer({ model: 'chatgpt-paid' }), answer({ model: 'claude-sonnet-4' })],
        [
          cite({ model: 'chatgpt-paid', url: 'https://gpt-src' }),
          cite({ model: 'claude-sonnet-4', url: 'https://claude-src' }),
        ],
        { date: DATE },
      );
      expect(records[0].sources.map((s) => s.url)).to.deep.equal(['https://gpt-src']);
      expect(records[1].sources.map((s) => s.url)).to.deep.equal(['https://claude-src']);
      expect(unmatchedSourceKeys).to.deep.equal([]);
    });

    it('does not let a prompt containing a delimiter collide with another tuple', () => {
      // The composite key uses U+001F precisely so free-text prompts cannot forge a boundary.
      const { records } = joinResponsesToSources(
        [answer({ prompt: 'a|proj-1|x' })],
        [cite({ prompt: 'a', projectId: 'proj-1|x' })],
        { date: DATE },
      );
      expect(records[0].sources).to.deep.equal([]);
    });

    it('projects only the citation fields a consumer needs', () => {
      const { records } = joinResponsesToSources([answer()], [cite()], { date: DATE });
      expect(records[0].sources[0]).to.deep.equal({
        url: 'https://a.example/1', source: 'a.example', position: 1, domainType: 'Earned',
      });
    });

    it('matches nothing when no date is supplied, since answers carry none', () => {
      const { records } = joinResponsesToSources([answer()], [cite()]);
      expect(records[0].sources).to.deep.equal([]);
      expect(records[0].date).to.equal('');
    });

    it('tolerates absent or non-array inputs', () => {
      expect(joinResponsesToSources(undefined, undefined).records).to.deep.equal([]);
      expect(joinResponsesToSources(null, null).unmatchedSourceKeys).to.deep.equal([]);
      expect(joinResponsesToSources([answer()], 'nope', { date: DATE }).records)
        .to.have.lengthOf(1);
    });

    it('treats missing key components as empty rather than throwing', () => {
      // No projectId and no model on either side: both must normalise to '' and still pair.
      const { records } = joinResponsesToSources(
        [{ prompt: 'p', response: 'r' }],
        [{
          prompt: 'p', date: DATE, url: 'https://u', position: 1,
        }],
        { date: DATE },
      );
      expect(records[0].sources.map((s) => s.url)).to.deep.equal(['https://u']);
    });

    it('normalises a null prompt to the empty key component', () => {
      // Both transforms drop prompt-less rows, so this is only reachable by calling the
      // join directly — but the key builder must not throw or stringify null if they do.
      const { records } = joinResponsesToSources(
        [answer({ prompt: null })],
        [cite({ prompt: null })],
        { date: DATE },
      );
      expect(records[0].sources.map((s) => s.url)).to.deep.equal(['https://a.example/1']);
    });

    it('groups a source row that carries no date under the empty-date key', () => {
      // Exercises the `row.date` fallback in the key builder: source rows are keyed from
      // their own date, so one lacking it must still group rather than throw. Such a row
      // cannot match a dated answer, so it surfaces as unmatched.
      const { records, unmatchedSourceKeys } = joinResponsesToSources(
        [answer()],
        [{
          projectId: 'proj-1', prompt: 'best running shoes', model: 'chatgpt-paid', position: 1,
        }],
        { date: DATE },
      );
      expect(records[0].sources).to.deep.equal([]);
      expect(unmatchedSourceKeys).to.have.lengthOf(1);
    });
  });

  describe('diffDayExecutions', () => {
    // Regression: element 141adc88 has no date column and returns one row PER EXECUTION, so a
    // page holds the entire ~50-day rolling window. Measured live: a 400-row page held only 10
    // distinct (prompt, model) pairs, one repeated 54 times. A distinct-Set difference therefore
    // returns [] for any prompt that also ran earlier in the window — verified against two live
    // adjacent-day captures, where a set difference gave 0 rows and a multiset difference gave
    // 4 and 5. [] is indistinguishable from "nothing ran", the data-loss outcome we forbid.
    it('does not let a U+001F inside a prompt forge a key boundary', () => {
      // U+001F is the vector a separator-joined key is most exposed to, since it is the
      // character such a key would use. These two tuples are DIFFERENT executions but would
      // join to one identical string under any separator scheme:
      //   ('p', 'a<US>b', 'm')  vs  ('p', 'a', 'b<US>m')
      // They must remain distinct, so neither can consume the other's row in the difference.
      const sneaky = answer({ projectId: 'p', prompt: 'a\u001Fb', model: 'm' });
      const other = answer({ projectId: 'p', prompt: 'a', model: 'b\u001Fm' });

      // If the keys collided, `other` would consume `sneaky`'s prior row and this would be 0.
      expect(diffDayExecutions([sneaky], [other])).to.have.lengthOf(1);
      expect(diffDayExecutions([other], [sneaky])).to.have.lengthOf(1);
    });

    it('keeps a pipe inside a prompt from forging a key boundary', () => {
      const a = answer({ projectId: 'p', prompt: 'a|b', model: 'm' });
      const b = answer({ projectId: 'p', prompt: 'a', model: 'b|m' });
      expect(diffDayExecutions([a], [b])).to.have.lengthOf(1);
    });

    it('counts repeats: a daily prompt already in the D-1 page still reports its day-D row', () => {
      // Same (project, prompt, model) 3x on D-1 and 4x on D: exactly one execution on day D.
      const prev = [answer(), answer(), answer()];
      const curr = [answer(), answer(), answer(), answer()];

      const result = diffDayExecutions(curr, prev);

      expect(result).to.have.lengthOf(1);
    });

    it('does not collapse repeated rows to a single identity', () => {
      // 1 -> 3 is two new executions, not one, and not zero.
      expect(diffDayExecutions([answer(), answer(), answer()], [answer()])).to.have.lengthOf(2);
    });

    it('reports every row when the prior page is empty', () => {
      expect(diffDayExecutions([answer(), answer()], [])).to.have.lengthOf(2);
    });

    it('reports nothing when the counts are unchanged', () => {
      const prev = [answer(), answer()];
      expect(diffDayExecutions([answer(), answer()], prev)).to.deep.equal([]);
    });

    it('never returns negative rows when the window drops more than it gains', () => {
      // Rows aging off the OLDER end of the rolling window: 4 -> 2 is an expiry, not activity.
      expect(diffDayExecutions([answer(), answer()], [answer(), answer(), answer(), answer()]))
        .to.deep.equal([]);
    });

    it('returns only the rows that are new on day D', () => {
      const carried = answer({ prompt: 'carried over' });
      const fresh = answer({ prompt: 'new today' });
      expect(diffDayExecutions([carried, fresh], [carried]))
        .to.deep.equal([fresh]);
    });

    it('returns everything when the previous day had no rows', () => {
      const rows = [answer(), answer({ model: 'grok-3' })];
      expect(diffDayExecutions(rows, [])).to.deep.equal(rows);
    });

    it('returns nothing when the day added no executions', () => {
      const rows = [answer()];
      expect(diffDayExecutions(rows, rows)).to.deep.equal([]);
    });

    it('distinguishes rows by model, so one model per prompt is counted separately', () => {
      const gpt = answer({ model: 'chatgpt-paid' });
      const claude = answer({ model: 'claude-sonnet-4' });
      expect(diffDayExecutions([gpt, claude], [gpt])).to.deep.equal([claude]);
    });

    it('distinguishes rows by project', () => {
      const p1 = answer({ projectId: 'proj-1' });
      const p2 = answer({ projectId: 'proj-2' });
      expect(diffDayExecutions([p1, p2], [p1])).to.deep.equal([p2]);
    });

    it('ignores rows that rolled OFF the older end of the window', () => {
      // The window rolls rather than accumulating, so a row present at end=D-1 and absent at
      // end=D is an expiry, not day-D activity — a symmetric difference would misreport it.
      const expired = answer({ prompt: 'aged out' });
      const fresh = answer({ prompt: 'new today' });
      const result = diffDayExecutions([fresh], [expired]);
      expect(result).to.deep.equal([fresh]);
      expect(result).to.not.deep.include(expired);
    });

    it('measures the one-execution-per-tuple invariant: 10 models add exactly 10 rows', () => {
      const models = [
        'chatgpt-paid', 'claude-sonnet-4', 'grok-3', 'gemini-2.5-flash', 'perplexity',
        'search-gpt', 'gpt-5', 'google-ai-mode', 'google-ai-overview', 'microsoft-copilot',
      ];
      const previous = [];
      const current = models.map((model) => answer({ model }));
      expect(diffDayExecutions(current, previous)).to.have.lengthOf(10);
    });

    it('tolerates absent or non-array inputs', () => {
      expect(diffDayExecutions(undefined, undefined)).to.deep.equal([]);
      expect(diffDayExecutions(null, null)).to.deep.equal([]);
      expect(diffDayExecutions([answer()], undefined)).to.have.lengthOf(1);
    });

    it('treats missing identity components as empty rather than throwing', () => {
      expect(diffDayExecutions([{ prompt: 'p' }], [{ prompt: 'p' }])).to.deep.equal([]);
      expect(diffDayExecutions([{}], [])).to.have.lengthOf(1);
    });
  });
});
