import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionCardView, askedByLine, decideAssistantAction, readAssistantMessage, type AssistantAction } from '../assistantMessages.ts';

const card = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  assistant: true, displayName: 'Nova', kind: 'assistant-action', actionId: 'act-1', askedBy: 'u-vera', askedByName: 'Vera Lindqvist',
  summary: 'Create work item "Login cookie bug"', detail: ['Assignee: Priya'], tool: { name: 'create_work_item', argsDigest: 'sha256:ab' }, status: 'waiting', ...over,
});

test('reads the three kinds and nothing else', () => {
  assert.deepEqual(readAssistantMessage({ assistant: true, kind: 'assistant-notice' }), { kind: 'assistant-notice' });
  assert.deepEqual(readAssistantMessage({ assistant: true, kind: 'assistant-reply', askedBy: 'u-vera', askedByName: 'Vera' }), { kind: 'assistant-reply', askedBy: 'u-vera', askedByName: 'Vera' });
  const action = readAssistantMessage(card());
  assert.equal(action?.kind, 'assistant-action');
  assert.equal(readAssistantMessage(undefined), null);
  assert.equal(readAssistantMessage({ kind: 'assistant-notice' }), null, 'no marker, no Nova');
  assert.equal(readAssistantMessage({ kind: 'call', callId: 'x' }), null);
});

test('a malformed card or reply is not a card', () => {
  assert.equal(readAssistantMessage({ assistant: true, kind: 'assistant-reply', askedBy: 'u' }), null);
  assert.equal(readAssistantMessage(card({ status: 'pending' })), null);
  assert.equal(readAssistantMessage(card({ tool: undefined })), null);
  assert.equal(readAssistantMessage(card({ actionId: '' })), null);
  assert.deepEqual((readAssistantMessage(card({ detail: undefined })) as AssistantAction).detail, []);
});

test('a reply is captioned with who asked', () => {
  assert.equal(askedByLine({ askedByName: 'Vera Lindqvist' }), 'Asked by Vera Lindqvist');
});

test('only the asker gets Confirm and Decline, and only while it waits; everyone else reads "Waiting for <name>"', () => {
  const waiting = readAssistantMessage(card()) as AssistantAction;
  assert.deepEqual(actionCardView(waiting, 'u-vera'), { statusLabel: 'Waiting for confirmation', tone: 'pending', canDecide: true, waitingNote: null });
  const other = actionCardView(waiting, 'u-release');
  assert.equal(other.canDecide, false);
  assert.equal(other.waitingNote, 'Waiting for Vera Lindqvist');
  assert.equal(actionCardView(waiting, null).canDecide, false);
});

test('a decided card has no controls and no waiting note for anyone', () => {
  for (const status of ['confirmed', 'declined', 'expired', 'done', 'failed']) {
    const action = readAssistantMessage(card({ status })) as AssistantAction;
    for (const viewer of ['u-vera', 'u-release']) {
      const view = actionCardView(action, viewer);
      assert.equal(view.canDecide, false, `${status} for ${viewer}`);
      assert.equal(view.waitingNote, null);
    }
  }
  assert.equal(actionCardView(readAssistantMessage(card({ status: 'done' })) as AssistantAction, 'u-vera').tone, 'success');
  assert.equal(actionCardView(readAssistantMessage(card({ status: 'failed' })) as AssistantAction, 'u-vera').tone, 'error');
});

test('the decision posts to the call\'s route and names the refusal when it is refused', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const ok = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  await decideAssistantAction('call 1', 'act-1', 'confirm', ok);
  assert.equal(seen[0]!.url, '/api/calls/call%201/assistant/actions/act-1/decision');
  assert.equal(seen[0]!.init.method, 'POST');
  assert.equal(seen[0]!.init.credentials, 'include');
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { decision: 'confirm' });
  const no = (async () => new Response(JSON.stringify({ error: 'Only the person who asked can decide this action' }), { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(decideAssistantAction('call-1', 'act-1', 'decline', no), /Only the person who asked/);
  const bare = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(decideAssistantAction('call-1', 'act-1', 'decline', bare), /could not be saved \(500\)/);
});

test('S16: a closing notice carries its meeting in metadata, and only a well-formed id', async () => {
  const { readAssistantMessage } = await import('../assistantMessages.ts');
  assert.deepEqual(readAssistantMessage({ assistant: true, kind: 'assistant-notice', meetingCallId: 'c-1' }), { kind: 'assistant-notice', meetingCallId: 'c-1' });
  assert.deepEqual(readAssistantMessage({ assistant: true, kind: 'assistant-notice' }), { kind: 'assistant-notice' });
  assert.deepEqual(readAssistantMessage({ assistant: true, kind: 'assistant-notice', meetingCallId: 7 }), { kind: 'assistant-notice' });
});

test('the card names the call initiative only for a new work item that names none', async () => {
  const { namesNoInitiative } = await import('../assistantMessages.ts');
  const tool = { name: 'create', argsDigest: '' };
  assert.equal(namesNoInitiative({ tool, detail: ['kind: work-item', 'title: Fix it'] }), true);
  assert.equal(namesNoInitiative({ tool, detail: ['kind: work-item', 'title: Fix it', 'initiative: Atlas'] }), false);
  assert.equal(namesNoInitiative({ tool, detail: ['kind: initiative', 'name: Atlas'] }), false);
  assert.equal(namesNoInitiative({ tool: { name: 'update', argsDigest: '' }, detail: ['kind: work-item'] }), false);
});
