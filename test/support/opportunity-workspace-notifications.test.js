/*
 * Copyright 2025 Adobe. All rights reserved.
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
import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('opportunity-workspace-notifications', () => {
  let detectStatusChanges;
  let sendStatusChangeNotifications;
  let notifyStrategyChanges;
  let sendEmailStub;
  let mockLog;
  let mockContext;

  let getEmailServiceTokenStub;

  before(async () => {
    sendEmailStub = sinon.stub();
    getEmailServiceTokenStub = sinon.stub().resolves('cached-token');

    const notifications = await esmock(
      '../../src/support/opportunity-workspace-notifications.js',
      {
        '../../src/support/email-service.js': {
          sendEmail: sendEmailStub,
          getEmailServiceToken: getEmailServiceTokenStub,
        },
        '@adobe/spacecat-shared-utils': {
          isValidEmail: (email) => typeof email === 'string' && email.includes('@') && email.includes('.'),
        },
      },
    );

    detectStatusChanges = notifications.detectStatusChanges;
    sendStatusChangeNotifications = notifications.sendStatusChangeNotifications;
    notifyStrategyChanges = notifications.notifyStrategyChanges;
  });

  beforeEach(() => {
    sendEmailStub.reset();
    sendEmailStub.resolves({ success: true, statusCode: 200, templateUsed: 'test' });
    getEmailServiceTokenStub.reset();
    getEmailServiceTokenStub.resolves('cached-token');

    mockLog = {
      info: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub(),
    };

    mockContext = {
      log: mockLog,
      dataAccess: {
        TrialUser: {
          findByEmailId: sinon.stub().callsFake((email) => {
            const names = {
              'user@test.com': { first: 'Jane', last: 'User' },
              'owner@test.com': { first: 'Owner', last: 'Smith' },
              'user1@test.com': { first: 'User', last: 'One' },
              'user2@test.com': { first: 'User', last: 'Two' },
            };
            const n = names[email];
            if (n) {
              return Promise.resolve({ getFirstName: () => n.first, getLastName: () => n.last });
            }
            return Promise.resolve(null);
          }),
        },
      },
    };
  });

  describe('detectStatusChanges', () => {
    it('should return empty array when prevData is null and nextData has no strategies', () => {
      const changes = detectStatusChanges(null, { strategies: [] }, mockLog);
      expect(changes).to.be.an('array').that.is.empty;
    });

    it('should detect strategy changes when prevData is null (first save)', () => {
      const nextData = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', status: 'new', assignee: 'user@test.com' }],
          createdBy: 'owner@test.com',
        }],
      };
      const changes = detectStatusChanges(null, nextData, mockLog);
      expect(changes).to.have.lengthOf(2); // 1 strategy + 1 opportunity
      expect(changes[0].type).to.equal('strategy');
      expect(changes[0].statusBefore).to.equal('');
      expect(changes[0].statusAfter).to.equal('new');
      expect(changes[1].type).to.equal('opportunity');
      expect(changes[1].statusBefore).to.equal('');
      expect(changes[1].statusAfter).to.equal('new');
    });

    it('should detect opportunity changes when prevData is null (first save)', () => {
      const nextData = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'in_progress',
          opportunities: [
            { opportunityId: 'o1', status: 'completed', assignee: 'user@test.com' },
            { opportunityId: 'o2', status: 'new', assignee: 'other@test.com' },
          ],
          createdBy: 'owner@test.com',
        }],
      };
      const changes = detectStatusChanges(null, nextData, mockLog);
      expect(changes).to.have.lengthOf(3); // 1 strategy + 2 opportunities
      expect(changes[0].type).to.equal('strategy');
      expect(changes[1].type).to.equal('opportunity');
      expect(changes[1].opportunityId).to.equal('o1');
      expect(changes[1].statusAfter).to.equal('completed');
      expect(changes[2].type).to.equal('opportunity');
      expect(changes[2].opportunityId).to.equal('o2');
      expect(changes[2].statusAfter).to.equal('new');
    });

    it('should handle new strategy with undefined opportunities (first save)', () => {
      const nextData = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          createdBy: 'owner@test.com',
        }],
      };
      const changes = detectStatusChanges(null, nextData, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].type).to.equal('strategy');
      expect(changes[0].statusBefore).to.equal('');
      expect(changes[0].statusAfter).to.equal('new');
      expect(changes[0].opportunityNames).to.deep.equal([]);
    });

    it('should handle new strategy with null opportunities (first save)', () => {
      const nextData = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: null,
          createdBy: 'owner@test.com',
        }],
      };
      const changes = detectStatusChanges(null, nextData, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].type).to.equal('strategy');
      expect(changes[0].opportunityNames).to.deep.equal([]);
    });

    it('should use opportunityId when opportunity has no name (new strategy)', () => {
      const nextData = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', status: 'new', assignee: 'user@test.com' }],
          createdBy: 'owner@test.com',
        }],
      };
      const changes = detectStatusChanges(null, nextData, mockLog);
      expect(changes).to.have.lengthOf(2);
      expect(changes[1].opportunityName).to.equal('o1');
    });

    it('should resolve library opportunity name from nextData.opportunities when strategyOpportunity has no name', () => {
      const nextData = {
        opportunities: [
          {
            id: 'lib-opp-1', name: 'EV Charging Expansion', description: '', category: 'energy',
          },
          {
            id: 'lib-opp-2', name: 'Depot Grid Modernization', description: '', category: 'energy',
          },
        ],
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [
            { opportunityId: 'lib-opp-1', status: 'new', assignee: 'user@test.com' },
            { opportunityId: 'lib-opp-2', status: 'new', assignee: 'other@test.com' },
          ],
          createdBy: 'owner@test.com',
        }],
      };
      const changes = detectStatusChanges(null, nextData, mockLog);
      expect(changes).to.have.lengthOf(3); // 1 strategy + 2 opportunities
      expect(changes[0].opportunityNames).to.deep.equal(['EV Charging Expansion', 'Depot Grid Modernization']);
      expect(changes[1].opportunityName).to.equal('EV Charging Expansion');
      expect(changes[2].opportunityName).to.equal('Depot Grid Modernization');
    });

    it('should use empty assignee when new strategy opportunity has no assignee', () => {
      const nextData = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', name: 'Opp 1', status: 'new' }],
          createdBy: 'owner@test.com',
        }],
      };
      const changes = detectStatusChanges(null, nextData, mockLog);
      expect(changes).to.have.lengthOf(2);
      expect(changes[1].assignee).to.equal('');
    });

    it('should use empty createdBy when new strategy has no owner', () => {
      const nextData = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', status: 'new', assignee: 'user@test.com' }],
        }],
      };
      const changes = detectStatusChanges(null, nextData, mockLog);
      expect(changes).to.have.lengthOf(2);
      expect(changes[0].createdBy).to.equal('');
      expect(changes[1].createdBy).to.equal('');
    });

    it('should return empty array when nextData is null', () => {
      const changes = detectStatusChanges({ strategies: [] }, null, mockLog);
      expect(changes).to.be.an('array').that.is.empty;
    });

    it('should handle data without strategies property', () => {
      const changes = detectStatusChanges({}, {}, mockLog);
      expect(changes).to.be.an('array').that.is.empty;
    });

    it('should return empty array when no statuses changed', () => {
      const data = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', status: 'new', assignee: 'a@b.com' }],
          createdBy: 'owner@b.com',
        }],
      };
      const changes = detectStatusChanges(data, data, mockLog);
      expect(changes).to.be.an('array').that.is.empty;
    });

    it('should detect strategy status change', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', status: 'new', assignee: 'user@test.com' }],
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'in_progress',
          opportunities: [{ opportunityId: 'o1', status: 'new', assignee: 'user@test.com' }],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].type).to.equal('strategy');
      expect(changes[0].strategyId).to.equal('s1');
      expect(changes[0].statusBefore).to.equal('new');
      expect(changes[0].statusAfter).to.equal('in_progress');
      expect(changes[0].recipients).to.include('user@test.com');
      expect(changes[0].recipients).to.include('owner@test.com');
    });

    it('should detect opportunity status change', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'o1', name: 'Opp 1', status: 'new', assignee: 'user@test.com',
          }],
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'o1', name: 'Opp 1', status: 'completed', assignee: 'user@test.com',
          }],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].type).to.equal('opportunity');
      expect(changes[0].opportunityId).to.equal('o1');
      expect(changes[0].statusBefore).to.equal('new');
      expect(changes[0].statusAfter).to.equal('completed');
    });

    it('should detect both strategy and opportunity status changes', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', status: 'new', assignee: 'user@test.com' }],
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'in_progress',
          opportunities: [{ opportunityId: 'o1', status: 'in_progress', assignee: 'user@test.com' }],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(2);
      expect(changes[0].type).to.equal('strategy');
      expect(changes[1].type).to.equal('opportunity');
    });

    it('should deduplicate recipients', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', status: 'new', assignee: 'same@test.com' }],
          createdBy: 'same@test.com',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', status: 'done', assignee: 'same@test.com' }],
          createdBy: 'same@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes[0].recipients).to.have.lengthOf(1);
      expect(changes[0].recipients[0]).to.equal('same@test.com');
    });

    it('should filter out invalid emails and log warnings', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', status: 'new', assignee: 'not-an-email' }],
          createdBy: '',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', status: 'done', assignee: 'not-an-email' }],
          createdBy: '',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes[0].recipients).to.have.lengthOf(0);
      expect(mockLog.warn).to.have.been.calledWith(sinon.match(/Skipping invalid email/));
    });

    it('should log warn for non-string email recipient', () => {
      const nextData = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', status: 'new', assignee: 123 }],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(null, nextData, mockLog);
      expect(changes[0].recipients).to.not.include(123);
      expect(mockLog.warn).to.have.been.calledWith(sinon.match(/Skipping non-string email recipient: number/));
    });

    it('should detect changes for new strategies that do not exist in prevData', () => {
      const prev = {
        strategies: [],
      };
      const next = {
        strategies: [{
          id: 's-new',
          name: 'New Strategy',
          status: 'new',
          opportunities: [],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].type).to.equal('strategy');
      expect(changes[0].statusBefore).to.equal('');
      expect(changes[0].statusAfter).to.equal('new');
    });

    it('should emit assignment change when new opportunity added to existing strategy with assignee', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [],
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'o-new', name: 'New Opp', status: 'new', assignee: 'user@test.com',
          }],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].type).to.equal('assignment');
      expect(changes[0].strategyId).to.equal('s1');
      expect(changes[0].opportunityId).to.equal('o-new');
      expect(changes[0].opportunityName).to.equal('New Opp');
      expect(changes[0].assigneeBefore).to.equal('');
      expect(changes[0].assigneeAfter).to.equal('user@test.com');
      expect(changes[0].statusAfter).to.equal('new');
      expect(changes[0].recipients).to.include('user@test.com');
      expect(changes[0].recipients).to.include('owner@test.com');
    });

    it('should not emit assignment change when new opportunity added without assignee', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [],
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o-new', status: 'new' }],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.be.empty;
    });

    it('should emit assignment change when assignee changes from empty to user', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', name: 'Opp 1', status: 'new' }],
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'o1', name: 'Opp 1', status: 'new', assignee: 'user@test.com',
          }],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].type).to.equal('assignment');
      expect(changes[0].assigneeBefore).to.equal('');
      expect(changes[0].assigneeAfter).to.equal('user@test.com');
      expect(changes[0].statusAfter).to.equal('new');
    });

    it('should emit assignment change when assignee changes from one user to another', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'o1', name: 'Opp 1', status: 'new', assignee: 'user1@test.com',
          }],
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'o1', name: 'Opp 1', status: 'new', assignee: 'user2@test.com',
          }],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].type).to.equal('assignment');
      expect(changes[0].assigneeBefore).to.equal('user1@test.com');
      expect(changes[0].assigneeAfter).to.equal('user2@test.com');
      expect(changes[0].statusAfter).to.equal('new');
    });

    it('should not emit assignment change when assignee is removed', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'o1', name: 'Opp 1', status: 'new', assignee: 'user@test.com',
          }],
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', name: 'Opp 1', status: 'new' }],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.be.empty;
    });

    it('should resolve library opportunity name and use empty createdBy when new opp added to existing strategy', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [],
        }],
      };
      const next = {
        opportunities: [{
          id: 'lib-1', name: 'Library Opp Name', description: '', category: 'energy',
        }],
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'lib-1', status: 'new', assignee: 'user@test.com',
          }],
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].type).to.equal('assignment');
      expect(changes[0].opportunityName).to.equal('Library Opp Name');
      expect(changes[0].createdBy).to.equal('');
    });

    it('should resolve library opportunity name and use empty createdBy when assignee changes on existing opp', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'lib-1', status: 'new', assignee: 'user1@test.com',
          }],
        }],
      };
      const next = {
        opportunities: [{
          id: 'lib-1', name: 'Library Opp Name', description: '', category: 'energy',
        }],
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'lib-1', status: 'new', assignee: 'user2@test.com',
          }],
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].type).to.equal('assignment');
      expect(changes[0].opportunityName).to.equal('Library Opp Name');
      expect(changes[0].createdBy).to.equal('');
    });

    it('should fallback to opportunityId when new opp has no name and no library match', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [],
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        opportunities: [],
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'unknown-opp', status: 'new', assignee: 'user@test.com',
          }],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].type).to.equal('assignment');
      expect(changes[0].opportunityName).to.equal('unknown-opp');
    });

    it('should fallback to opportunityId when assignee changes on existing opp with no name and no library match', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'unknown-opp', status: 'new', assignee: 'user1@test.com',
          }],
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        opportunities: [],
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'unknown-opp', status: 'new', assignee: 'user2@test.com',
          }],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].type).to.equal('assignment');
      expect(changes[0].opportunityName).to.equal('unknown-opp');
    });

    it('should emit both status and assignment changes when both change', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'o1', name: 'Opp 1', status: 'new', assignee: 'user1@test.com',
          }],
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'o1', name: 'Opp 1', status: 'completed', assignee: 'user2@test.com',
          }],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(2);
      const statusChange = changes.find((c) => c.type === 'opportunity');
      const assignmentChange = changes.find((c) => c.type === 'assignment');
      expect(statusChange).to.exist;
      expect(assignmentChange).to.exist;
      expect(statusChange.statusBefore).to.equal('new');
      expect(statusChange.statusAfter).to.equal('completed');
      expect(assignmentChange.assigneeBefore).to.equal('user1@test.com');
      expect(assignmentChange.assigneeAfter).to.equal('user2@test.com');
      expect(assignmentChange.statusAfter).to.equal('completed');
    });

    it('should collect all assignees for strategy status change', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [
            { opportunityId: 'o1', status: 'new', assignee: 'a@test.com' },
            { opportunityId: 'o2', status: 'new', assignee: 'b@test.com' },
          ],
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'completed',
          opportunities: [
            { opportunityId: 'o1', status: 'new', assignee: 'a@test.com' },
            { opportunityId: 'o2', status: 'new', assignee: 'b@test.com' },
          ],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes[0].recipients).to.include('a@test.com');
      expect(changes[0].recipients).to.include('b@test.com');
      expect(changes[0].recipients).to.include('owner@test.com');
    });

    it('should use empty assignee when opportunity has no assignee', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', status: 'new' }],
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', status: 'done' }],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].assignee).to.equal('');
    });

    it('should handle strategy change when opportunities is undefined', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'done',
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].type).to.equal('strategy');
      expect(changes[0].recipients).to.include('owner@test.com');
      expect(changes[0].opportunityNames).to.deep.equal([]);
    });

    it('should use empty createdBy when strategy has no owner', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', status: 'new', assignee: 'user@test.com' }],
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'done',
          opportunities: [{ opportunityId: 'o1', status: 'new', assignee: 'user@test.com' }],
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].type).to.equal('strategy');
      expect(changes[0].createdBy).to.equal('');
      expect(changes[0].recipients).to.include('user@test.com');
    });

    it('should include opportunityNames for strategy status change', () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [
            {
              opportunityId: 'o1',
              name: 'EV Charging Expansion',
              status: 'new',
              assignee: 'a@test.com',
            },
            {
              opportunityId: 'o2',
              name: 'Depot Grid Modernization',
              status: 'new',
              assignee: 'b@test.com',
            },
          ],
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'in_progress',
          opportunities: [
            {
              opportunityId: 'o1',
              name: 'EV Charging Expansion',
              status: 'new',
              assignee: 'a@test.com',
            },
            {
              opportunityId: 'o2',
              name: 'Depot Grid Modernization',
              status: 'new',
              assignee: 'b@test.com',
            },
          ],
          createdBy: 'owner@test.com',
        }],
      };

      const changes = detectStatusChanges(prev, next, mockLog);
      expect(changes).to.have.lengthOf(1);
      expect(changes[0].type).to.equal('strategy');
      expect(changes[0].opportunityNames).to.deep.equal(['EV Charging Expansion', 'Depot Grid Modernization']);
    });
  });

  describe('sendStatusChangeNotifications', () => {
    it('should skip when recipients list is empty', async () => {
      const changes = [{
        type: 'opportunity',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        statusBefore: 'new',
        statusAfter: 'done',
        recipients: [],
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: '',
      });

      expect(summary.skipped).to.equal(1);
      expect(sendEmailStub).to.not.have.been.called;
    });

    it('should handle unparseable siteBaseUrl gracefully', async () => {
      const changes = [{
        type: 'opportunity',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        statusBefore: 'new',
        statusAfter: 'completed',
        recipients: ['user@test.com'],
        createdBy: 'owner@test.com',
        assignee: 'user@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: 'http://',
      });

      expect(summary.sent).to.equal(1);
      const [, emailOptions] = sendEmailStub.firstCall.args;
      expect(emailOptions.templateData.strategy_url).to.equal('');
    });

    it('should send opportunity status change email', async () => {
      const changes = [{
        type: 'opportunity',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        statusBefore: 'new',
        statusAfter: 'completed',
        recipients: ['user@test.com'],
        createdBy: 'owner@test.com',
        assignee: 'user@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: 'https://www.example.com',
      });

      expect(summary.sent).to.equal(1);
      expect(sendEmailStub).to.have.been.calledOnce;

      const [, emailOptions] = sendEmailStub.firstCall.args;
      expect(emailOptions.templateName).to.equal('llmo_opportunity_status_update');
      expect(emailOptions.recipients).to.deep.equal(['user@test.com']);
      expect(emailOptions.templateData.recipient_name).to.equal('Jane User');
      expect(emailOptions.templateData.recipient_email).to.equal('user@test.com');
      expect(emailOptions.templateData.assignee_name).to.equal('Jane User');
      expect(emailOptions.templateData.assignee_email).to.equal('user@test.com');
      expect(emailOptions.templateData.strategy_owner_name).to.equal('Owner Smith');
      expect(emailOptions.templateData.strategy_owner_email).to.equal('owner@test.com');
      expect(emailOptions.templateData.opportunity_name).to.equal('Opp 1');
      expect(emailOptions.templateData.opportunity_status).to.equal('completed');
      expect(emailOptions.templateData.strategy_name).to.equal('Strategy 1');
      expect(emailOptions.templateData.strategy_url).to.equal('https://llmo.now/www.example.com/insights/opportunity-workspace');
    });

    it('should send assignment change email with llmo_opportunity_status_update template', async () => {
      const changes = [{
        type: 'assignment',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        assigneeBefore: '',
        assigneeAfter: 'user@test.com',
        statusAfter: 'new',
        recipients: ['user@test.com'],
        createdBy: 'owner@test.com',
        assignee: 'user@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: 'https://www.example.com',
      });

      expect(summary.sent).to.equal(1);
      expect(sendEmailStub).to.have.been.calledOnce;
      const [, emailOptions] = sendEmailStub.firstCall.args;
      expect(emailOptions.templateName).to.equal('llmo_opportunity_status_update');
      expect(emailOptions.recipients).to.deep.equal(['user@test.com']);
    });

    it('should include correct template data for assignment change', async () => {
      const changes = [{
        type: 'assignment',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        assigneeBefore: 'user1@test.com',
        assigneeAfter: 'user2@test.com',
        statusAfter: 'in_progress',
        recipients: ['user2@test.com'],
        createdBy: 'owner@test.com',
        assignee: 'user2@test.com',
      }];

      await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: 'https://www.example.com',
      });

      const [, emailOptions] = sendEmailStub.firstCall.args;
      expect(emailOptions.templateData.recipient_name).to.equal('User Two');
      expect(emailOptions.templateData.recipient_email).to.equal('user2@test.com');
      expect(emailOptions.templateData.assignee_name).to.equal('User Two');
      expect(emailOptions.templateData.assignee_email).to.equal('user2@test.com');
      expect(emailOptions.templateData.strategy_owner_name).to.equal('Owner Smith');
      expect(emailOptions.templateData.strategy_owner_email).to.equal('owner@test.com');
      expect(emailOptions.templateData.opportunity_name).to.equal('Opp 1');
      expect(emailOptions.templateData.opportunity_status).to.equal('in_progress');
      expect(emailOptions.templateData.strategy_name).to.equal('Strategy 1');
      expect(emailOptions.templateData.strategy_url).to.equal('https://llmo.now/www.example.com/insights/opportunity-workspace');
    });

    it('should use "-" for strategy_owner fields when createdBy is missing (assignment)', async () => {
      const changes = [{
        type: 'assignment',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        assigneeBefore: '',
        assigneeAfter: 'user@test.com',
        statusAfter: 'new',
        recipients: ['user@test.com'],
        createdBy: '',
        assignee: 'user@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: '',
      });

      expect(summary.sent).to.equal(1);
      expect(mockLog.warn).to.have.been.calledWith(sinon.match(/Strategy owner.*unknown/));
      const [, emailOptions] = sendEmailStub.firstCall.args;
      expect(emailOptions.templateData.strategy_owner_name).to.equal('-');
      expect(emailOptions.templateData.strategy_owner_email).to.equal('-');
    });

    it('should send strategy status change email', async () => {
      const changes = [{
        type: 'strategy',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        statusBefore: 'new',
        statusAfter: 'in_progress',
        recipients: ['user@test.com'],
        createdBy: 'owner@test.com',
        opportunityNames: ['EV Charging Expansion', 'Depot Grid Modernization'],
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: 'https://www.example.com',
      });

      expect(summary.sent).to.equal(1);
      const [, emailOptions] = sendEmailStub.firstCall.args;
      expect(emailOptions.templateName).to.equal('llmo_strategy_update');
      expect(emailOptions.templateData.strategy_status).to.equal('in_progress');
      expect(emailOptions.templateData.strategy_owner_name).to.equal('Owner Smith');
      expect(emailOptions.templateData.opportunity_list).to.deep.equal(['EV Charging Expansion', 'Depot Grid Modernization']);
      expect(emailOptions.templateData).to.not.have.property('assignee_name');
      expect(emailOptions.templateData).to.not.have.property('assignee_email');
      expect(emailOptions.templateData).to.not.have.property('opportunity_name');
      expect(emailOptions.templateData).to.not.have.property('opportunity_status');
    });

    it('should send separate emails per recipient', async () => {
      const changes = [{
        type: 'opportunity',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        statusBefore: 'new',
        statusAfter: 'done',
        recipients: ['user1@test.com', 'user2@test.com'],
        createdBy: 'owner@test.com',
        assignee: 'user1@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: '',
      });

      expect(summary.sent).to.equal(2);
      expect(sendEmailStub).to.have.been.calledTwice;
    });

    it('should count failed emails', async () => {
      sendEmailStub.resolves({ success: false, statusCode: 500, error: 'Server error' });

      const changes = [{
        type: 'opportunity',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        statusBefore: 'new',
        statusAfter: 'done',
        recipients: ['user@test.com'],
        createdBy: 'owner@test.com',
        assignee: 'user@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: '',
      });

      expect(summary.failed).to.equal(1);
      expect(summary.sent).to.equal(0);
    });

    it('should handle sendEmail throwing an error', async () => {
      sendEmailStub.rejects(new Error('Unexpected error'));

      const changes = [{
        type: 'opportunity',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        statusBefore: 'new',
        statusAfter: 'done',
        recipients: ['user@test.com'],
        createdBy: 'owner@test.com',
        assignee: 'user@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: '',
      });

      expect(summary.failed).to.equal(1);
    });

    it('should use "-" for strategy_owner_* when createdBy is missing', async () => {
      const changes = [{
        type: 'opportunity',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        statusBefore: 'new',
        statusAfter: 'done',
        recipients: ['user@test.com'],
        createdBy: '',
        assignee: 'user@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: '',
      });

      expect(summary.sent).to.equal(1);
      expect(mockLog.warn).to.have.been.calledWith(sinon.match(/Strategy owner.*unknown/));
      const [, emailOptions] = sendEmailStub.firstCall.args;
      expect(emailOptions.templateData.strategy_owner_name).to.equal('-');
      expect(emailOptions.templateData.strategy_owner_email).to.equal('-');
    });

    it('should log strategy fallback in skip warning for strategy change with no recipients', async () => {
      const changes = [{
        type: 'strategy',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        statusBefore: 'new',
        statusAfter: 'done',
        recipients: [],
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: '',
      });

      expect(summary.skipped).to.equal(1);
      expect(mockLog.warn).to.have.been.calledWith(sinon.match('s1/strategy'));
    });

    it('should handle opportunity change with missing assignee and opportunityName', async () => {
      const changes = [{
        type: 'opportunity',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        statusBefore: 'new',
        statusAfter: 'done',
        recipients: ['user@test.com'],
        createdBy: 'owner@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: 'https://www.example.com',
      });

      expect(summary.sent).to.equal(1);
      const [, emailOptions] = sendEmailStub.firstCall.args;
      expect(emailOptions.templateData.assignee_name).to.equal('');
      expect(emailOptions.templateData.assignee_email).to.equal('');
      expect(emailOptions.templateData.opportunity_name).to.equal('');
    });

    it('should handle strategy change with missing opportunityNames', async () => {
      const changes = [{
        type: 'strategy',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        statusBefore: 'new',
        statusAfter: 'done',
        recipients: ['user@test.com'],
        createdBy: 'owner@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: 'https://www.example.com',
      });

      expect(summary.sent).to.equal(1);
      const [, emailOptions] = sendEmailStub.firstCall.args;
      expect(emailOptions.templateData.opportunity_list).to.deep.equal([]);
    });

    it('should fall back to email when dataAccess has no TrialUser', async () => {
      delete mockContext.dataAccess.TrialUser;

      const changes = [{
        type: 'opportunity',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        statusBefore: 'new',
        statusAfter: 'done',
        recipients: ['user@test.com'],
        createdBy: 'owner@test.com',
        assignee: 'user@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: 'https://www.example.com',
      });

      expect(summary.sent).to.equal(1);
      const [, emailOptions] = sendEmailStub.firstCall.args;
      expect(emailOptions.templateData.recipient_name).to.equal('user@test.com');
      expect(emailOptions.templateData.strategy_owner_name).to.equal('owner@test.com');
    });

    it('should fall back to email when user names are empty', async () => {
      mockContext.dataAccess.TrialUser.findByEmailId.resolves({
        getFirstName: () => null,
        getLastName: () => null,
      });

      const changes = [{
        type: 'opportunity',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        statusBefore: 'new',
        statusAfter: 'done',
        recipients: ['user@test.com'],
        createdBy: 'owner@test.com',
        assignee: 'user@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: 'https://www.example.com',
      });

      expect(summary.sent).to.equal(1);
      const [, emailOptions] = sendEmailStub.firstCall.args;
      expect(emailOptions.templateData.recipient_name).to.equal('user@test.com');
    });

    it('should fall back to email when TrialUser has placeholder "-" as first/last name', async () => {
      mockContext.dataAccess.TrialUser.findByEmailId.resolves({
        getFirstName: () => '-',
        getLastName: () => '-',
      });

      const changes = [{
        type: 'opportunity',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        statusBefore: 'new',
        statusAfter: 'done',
        recipients: ['user@test.com'],
        createdBy: 'owner@test.com',
        assignee: 'user@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: 'https://www.example.com',
      });

      expect(summary.sent).to.equal(1);
      const [, emailOptions] = sendEmailStub.firstCall.args;
      expect(emailOptions.templateData.recipient_name).to.equal('user@test.com');
      expect(emailOptions.templateData.assignee_name).to.equal('user@test.com');
    });

    it('should fall back to email when TrialUser lookup throws', async () => {
      mockContext.dataAccess.TrialUser.findByEmailId.rejects(new Error('DB error'));

      const changes = [{
        type: 'opportunity',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        statusBefore: 'new',
        statusAfter: 'done',
        recipients: ['user@test.com'],
        createdBy: 'owner@test.com',
        assignee: 'user@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: 'https://www.example.com',
      });

      expect(summary.sent).to.equal(1);
      const [, emailOptions] = sendEmailStub.firstCall.args;
      expect(emailOptions.templateData.recipient_name).to.equal('user@test.com');
    });

    it('should resolve strategy_url when siteBaseUrl has no http prefix', async () => {
      const changes = [{
        type: 'opportunity',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        statusBefore: 'new',
        statusAfter: 'done',
        recipients: ['user@test.com'],
        createdBy: 'owner@test.com',
        assignee: 'user@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: 'www.example.com',
      });

      expect(summary.sent).to.equal(1);
      const [, emailOptions] = sendEmailStub.firstCall.args;
      expect(emailOptions.templateData.strategy_url).to.equal('https://llmo.now/www.example.com/insights/opportunity-workspace');
    });

    it('should fall back to email when TrialUser.findByEmailId returns null', async () => {
      mockContext.dataAccess.TrialUser.findByEmailId.resolves(null);

      const changes = [{
        type: 'opportunity',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        statusBefore: 'new',
        statusAfter: 'done',
        recipients: ['unknown@test.com'],
        createdBy: 'owner@test.com',
        assignee: 'unknown@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: 'https://www.example.com',
      });

      expect(summary.sent).to.equal(1);
      const [, emailOptions] = sendEmailStub.firstCall.args;
      expect(emailOptions.templateData.recipient_name).to.equal('unknown@test.com');
      expect(emailOptions.templateData.assignee_name).to.equal('unknown@test.com');
      expect(emailOptions.templateData.strategy_url).to.equal('https://llmo.now/www.example.com/insights/opportunity-workspace');
    });

    it('should call getEmailServiceToken once and pass token to all sendEmail calls', async () => {
      const changes = [
        {
          type: 'opportunity',
          strategyId: 's1',
          strategyName: 'Strategy 1',
          opportunityId: 'o1',
          opportunityName: 'Opp 1',
          statusBefore: 'new',
          statusAfter: 'done',
          recipients: ['user1@test.com'],
          createdBy: 'owner@test.com',
          assignee: 'user1@test.com',
        },
        {
          type: 'opportunity',
          strategyId: 's1',
          strategyName: 'Strategy 1',
          opportunityId: 'o2',
          opportunityName: 'Opp 2',
          statusBefore: 'new',
          statusAfter: 'done',
          recipients: ['user2@test.com'],
          createdBy: 'owner@test.com',
          assignee: 'user2@test.com',
        },
      ];

      await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: 'https://www.example.com',
      });

      expect(getEmailServiceTokenStub).to.have.been.calledOnce;
      expect(sendEmailStub).to.have.been.calledTwice;
      expect(sendEmailStub.firstCall.args[1].accessToken).to.equal('cached-token');
      expect(sendEmailStub.secondCall.args[1].accessToken).to.equal('cached-token');
    });

    it('should return early and not send emails when getEmailServiceToken fails', async () => {
      getEmailServiceTokenStub.rejects(new Error('IMS unavailable'));

      const changes = [{
        type: 'opportunity',
        strategyId: 's1',
        strategyName: 'Strategy 1',
        opportunityId: 'o1',
        opportunityName: 'Opp 1',
        statusBefore: 'new',
        statusAfter: 'done',
        recipients: ['user@test.com'],
        createdBy: 'owner@test.com',
        assignee: 'user@test.com',
      }];

      const summary = await sendStatusChangeNotifications(mockContext, {
        changes, siteBaseUrl: 'https://www.example.com',
      });

      expect(summary.sent).to.equal(0);
      expect(summary.failed).to.equal(0);
      expect(summary.skipped).to.equal(0);
      expect(sendEmailStub).to.not.have.been.called;
      expect(mockContext.log.error).to.have.been.calledWith(sinon.match(/Failed to acquire IMS token/));
    });
  });

  describe('notifyStrategyChanges', () => {
    it('should return zero counts when no changes detected', async () => {
      const data = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{ opportunityId: 'o1', status: 'new', assignee: 'user@test.com' }],
          createdBy: 'owner@test.com',
        }],
      };

      const result = await notifyStrategyChanges(mockContext, {
        prevData: data,
        nextData: data,
        siteId: 'site-1',
        siteBaseUrl: '',
        changedBy: 'admin@test.com',
      });

      expect(result.changes).to.equal(0);
      expect(result.sent).to.equal(0);
      expect(sendEmailStub).to.not.have.been.called;
    });

    it('should detect changes and send notifications end-to-end', async () => {
      const prev = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'o1', name: 'Opp 1', status: 'new', assignee: 'user@test.com',
          }],
          createdBy: 'owner@test.com',
        }],
      };
      const next = {
        strategies: [{
          id: 's1',
          name: 'Strategy 1',
          status: 'new',
          opportunities: [{
            opportunityId: 'o1', name: 'Opp 1', status: 'completed', assignee: 'user@test.com',
          }],
          createdBy: 'owner@test.com',
        }],
      };

      const result = await notifyStrategyChanges(mockContext, {
        prevData: prev,
        nextData: next,
        siteId: 'site-1',
        siteBaseUrl: 'https://www.example.com',
        changedBy: 'admin@test.com',
      });

      expect(result.changes).to.equal(1);
      expect(result.sent).to.equal(2); // assignee + owner
    });

    it('should not throw when an unexpected error occurs', async () => {
      const faultyContext = {
        ...mockContext,
        log: {
          info: sinon.stub().throws(new Error('Simulated failure')),
          warn: sinon.stub(),
          error: sinon.stub(),
        },
      };

      const result = await notifyStrategyChanges(
        faultyContext,
        {
          prevData: {
            strategies: [{
              id: 's1', status: 'new', opportunities: [],
            }],
          },
          nextData: {
            strategies: [{
              id: 's1', status: 'done', opportunities: [],
            }],
          },
          siteId: 'site-1',
          siteBaseUrl: '',
        },
      );

      expect(result.changes).to.equal(0);
      expect(result.sent).to.equal(0);
      expect(faultyContext.log.error).to.have.been.calledOnce;
    });

    it('should detect changes and send notifications when prevData is null (first save)', async () => {
      const result = await notifyStrategyChanges(mockContext, {
        prevData: null,
        nextData: {
          strategies: [{
            id: 's1',
            name: 'Strategy 1',
            status: 'new',
            opportunities: [{ opportunityId: 'o1', status: 'new', assignee: 'user@test.com' }],
            createdBy: 'owner@test.com',
          }],
        },
        siteId: 'site-1',
        siteBaseUrl: '',
        changedBy: 'admin@test.com',
      });

      expect(result.changes).to.be.greaterThan(0);
      expect(sendEmailStub).to.have.been.called;
    });
  });
});
