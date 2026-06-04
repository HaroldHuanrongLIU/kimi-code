import { describe, expect, it } from 'vitest';

import {
  AgentSwarmProgressComponent,
  agentSwarmDescriptionFromArgs,
  agentSwarmItemsFromArgs,
  agentSwarmPartialItemsCountFromArguments,
  agentSwarmPartialItemsFromArguments,
} from '#/tui/components/messages/agent-swarm-progress';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('AgentSwarmProgressComponent', () => {
  it('renders an orchestrating panel before subagents spawn', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('Agent swarm: Review changed files');
    expect(output).toContain('Orchestrating...');
    expect(output).not.toContain('01');
  });

  it('renders spawned subagents as queued progress rows', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.registerSubagent({ agentId: 'agent-2', description: 'Review changed files #2 (coder)' });

    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('001 [');
    expect(output).toContain('002 [');
    expect(output).toContain('Queued');
    expect(output).not.toContain('agents=2');
  });

  it('advances one step when a subagent tool call starts and marks terminal states', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.registerSubagent({ agentId: 'agent-2', description: 'Review changed files #2 (coder)' });
    component.recordToolCall({ agentId: 'agent-1', toolCallId: 'call-read' });

    let output = strip(component.render(100).join('\n'));
    expect(output).toContain('001 [');
    expect(output).toContain('Running');
    expect(output).toContain('002 [');
    expect(output).toContain('Queued');

    component.markCompleted('agent-1');
    component.markFailed('agent-2');

    output = strip(component.render(100).join('\n'));
    expect(output).toContain('001 [');
    expect(output).toContain('Completed');
    expect(output).toContain('002 [');
    expect(output).toContain('Failed');
  });

  it('shows latest assistant text after the progress bar with ellipsis truncation', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    component.markInputComplete();
    component.recordToolCall({ agentId: 'agent-1', toolCallId: 'call-read' });
    component.appendAssistantDelta({
      agentId: 'agent-1',
      delta: 'Reviewing src/a.ts and checking imports for regressions in detail',
    });

    const output = strip(component.render(44).join('\n'));
    expect(output).toContain('001 [');
    expect(output).toContain('Reviewing');
    expect(output).toContain('…');
    expect(output).not.toContain('Working');
  });

  it('keeps spawned rows queued when AgentSwarm input completes', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({
      agentId: 'agent-1',
      description: 'Review changed files #1 (coder)',
    });
    let output = strip(component.render(100).join('\n'));
    expect(output).toContain('001 [');
    expect(output).toContain('Queued');

    component.markInputComplete();
    output = strip(component.render(100).join('\n'));
    expect(output).toContain('001 [');
    expect(output).toContain('Queued');
  });

  it('creates pending rows from streamed args items', () => {
    const component = new AgentSwarmProgressComponent({
      description: '',
      colors: darkColors,
    });

    component.updateArgs({
      description: 'Review changed files',
      items: ['src/a.ts', 'src/b.ts'],
    });
    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('Agent swarm: Review changed files');
    expect(output).toContain('001 src/a.ts');
    expect(output).toContain('002 src/b.ts');
  });

  it('counts partial items before each string is complete', () => {
    expect(
      agentSwarmPartialItemsCountFromArguments('{"items":["src/a.ts","src/b'),
    ).toBe(2);
    expect(
      agentSwarmPartialItemsCountFromArguments('{"items":["src/a.ts","src/\\"b.ts","src/c'),
    ).toBe(3);
    expect(
      agentSwarmPartialItemsFromArguments('{"items":["src/a.ts","src/\\"b.ts","src/c'),
    ).toEqual(['src/a.ts', 'src/"b.ts', 'src/c']);
  });

  it('creates pending rows from partial streaming arguments', () => {
    const component = new AgentSwarmProgressComponent({
      description: '',
      colors: darkColors,
    });

    component.updateArgs({}, {
      streamingArguments: '{"description":"Review changed files","items":["src/a.ts","src/b',
    });
    const output = strip(component.render(100).join('\n'));

    expect(output).toContain('001 src/a.ts');
    expect(output).toContain('002 src/b');
  });

  it('adds subagent rows incrementally as spawn events arrive', () => {
    const component = new AgentSwarmProgressComponent({
      description: 'Review changed files',
      colors: darkColors,
    });

    component.registerSubagent({ agentId: 'agent-1', description: 'Review changed files #1 (coder)' });
    let output = strip(component.render(100).join('\n'));
    expect(output).toContain('001 [');
    expect(output).toContain('Queued');
    expect(output).not.toContain('002');

    component.registerSubagent({ agentId: 'agent-2', description: 'Review changed files #2 (coder)' });
    output = strip(component.render(100).join('\n'));
    expect(output).toContain('001 [');
    expect(output).toContain('002 [');
    expect(output).toContain('Queued');
  });

  it('extracts description and item list from AgentSwarm args', () => {
    const args = {
      description: 'Review changed files',
      items: ['src/a.ts', 123],
    };

    expect(agentSwarmDescriptionFromArgs(args)).toBe('Review changed files');
    expect(agentSwarmItemsFromArgs(args)).toEqual(['src/a.ts', '123']);
  });
});
