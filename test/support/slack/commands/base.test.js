/*
 * Copyright 2023 Adobe. All rights reserved.
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

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';

import BaseCommand from '../../../../src/support/slack/commands/base.js';

use(chaiAsPromised);

describe('BaseCommand', () => {
  describe('Initialization and Properties', () => {
    it('initializes with given properties', () => {
      const options = {
        id: 'testCommand',
        description: 'Test Description',
        name: 'TestName',
        usageText: 'Test Usage',
        phrases: ['test', 'testCommand'],
      };
      const command = BaseCommand(options);

      expect(command.id).to.equal(options.id);
      expect(command.description).to.equal(options.description);
      expect(command.name).to.equal(options.name);
      expect(command.phrases).to.deep.equal(options.phrases);
    });
  });

  describe('accepts Method', () => {
    const options = {
      phrases: ['test', 'hello'],
    };
    const command = BaseCommand(options);

    it('accepts messages starting with a triggering phrase followed by a space', () => {
      expect(command.accepts('test message')).to.be.true;
    });

    it('accepts messages that exactly match a triggering phrase', () => {
      expect(command.accepts('test')).to.be.true;
    });

    it('rejects messages starting with a triggering phrase followed by a non-space character', () => {
      expect(command.accepts('testXmessage')).to.be.false;
    });

    it('rejects messages not starting with any triggering phrase', () => {
      expect(command.accepts('invalid message')).to.be.false;
    });
  });

  describe('execute Method', () => {
    it('throws an error indicating it must be overridden', async () => {
      const command = BaseCommand({});
      await expect(command.execute()).to.be.rejectedWith('Execute method must be overridden');
    });
  });

  describe('handleExecution Method', () => {
    it('throws an error by default', async () => {
      const command = BaseCommand({});
      await expect(command.handleExecution()).to.be.rejectedWith('Execute method must be overridden');
    });
  });

  describe('usage Method', () => {
    it('returns custom usage text if provided', () => {
      const command = BaseCommand({ usageText: 'custom usage' });
      expect(command.usage()).to.equal('Usage: _custom usage_');
    });

    it('returns phrases as usage if no custom usage text is provided', () => {
      const command = BaseCommand({ phrases: ['test', 'demo'] });
      expect(command.usage()).to.equal('Usage: _test, demo_');
    });
  });

  describe('init Method', () => {
    it('throws an error if context is not an object', () => {
      const command = BaseCommand({});
      expect(() => command.init(null)).to.throw('Context object is required');
    });

    it('does not throw an error for valid context', () => {
      const command = BaseCommand({});
      expect(() => command.init({})).to.not.throw();
    });
  });

  describe('extractArguments Method', () => {
    const options = {
      phrases: ['test', 'execute'],
    };

    it('extracts arguments correctly for valid triggering phrases', async () => {
      const command = BaseCommand(options);
      command.handleExecution = sinon.stub().resolves('handled');

      const result = await command.execute('test argument1 argument2', sinon.stub(), []);
      expect(result).to.equal('handled');
      expect(command.handleExecution.calledWith(['argument1', 'argument2'])).to.be.true;
    });

    it('returns empty arguments array for non-triggering phrases', async () => {
      const command = BaseCommand(options);
      command.handleExecution = sinon.stub().resolves('handled');

      const result = await command.execute('non-triggering phrase', sinon.stub(), []);
      expect(result).to.equal('handled');
      expect(command.handleExecution.calledWith([])).to.be.true;
    });
  });
});
