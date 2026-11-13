import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskPlanWorkspaceAdapter, renderTaskPlanSnapshot } from '../../../src/agent-server/context/task-plan.ts';
import { TaskPlanTools } from '../../../src/agent-server/tools/task-plan.ts';

test('an unclassified task remains a main-model decision instead of being labelled simple QA', async () => {
    const tools = new TaskPlanTools({ journal: {}, pendingTools: {} });
    const scope = await tools.scope({ conversationId: 'conversation', rootRunId: 'task',
        roots: [process.cwd()], signal: new AbortController().signal });
    assert.equal(Object.hasOwn(scope, 'workKind'), false);
    const adapter = createTaskPlanWorkspaceAdapter({ read: async () => null, write: async () => { throw new Error('unexpected write'); } });
    const snapshot = await adapter.read(scope);
    assert.equal(snapshot.planRequired, null);
    assert.match(renderTaskPlanSnapshot(snapshot), /Task complexity has not been preclassified/);
    assert.match(renderTaskPlanSnapshot(snapshot), /before multi-step work/);
});

test('explicit task classifications preserve complex-task requirements and lightweight exemptions', async () => {
    const adapter = createTaskPlanWorkspaceAdapter({ read: async () => null, write: async () => { throw new Error('unexpected write'); } });
    for (const [workKind, required] of [['multi_step', true], ['simple_qa', false], ['single_image', false]]) {
        const scope = { conversationId: 'conversation', taskId: 'task', directory: 'plans/conversation', workKind };
        const snapshot = await adapter.read(scope);
        assert.equal(snapshot.planRequired, required);
        assert.equal(snapshot.scope.workKind, workKind);
    }
});
