// The inviter's delete removes every place that holds words (audit M2): the transcript, the minutes, the record's pending requests,
// each turn's tool arguments, each action's result text, and Nova's own chat messages. People's messages are not touched.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } } }));
jest.mock('../../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
import type { ChatMessage } from '@connorhoehn/realtime-modules/chat';
import { InMemoryChatStore } from '@connorhoehn/realtime-modules/chat';

const chat = new InMemoryChatStore();
const updates: string[] = [];
jest.mock('../../call-chat.js', () => ({ callChatChannel: (id: string) => `orgiq:huddle:${id}`, callChatRuntime: () => ({ messages: chat }) }));
jest.mock('../../social-chat.js', () => ({
  postThreadMessage: async (row: ChatMessage) => { await chat.putMessage(row); },
  updateThreadMessage: async (channel: string, id: string, patch: { message?: string; metadata?: Record<string, unknown> }) => {
    updates.push(id);
    const existing = await chat.getMessage(channel, id);
    if (!existing) return null;
    const merged: Record<string, unknown> = { ...(existing.metadata ?? {}) };
    for (const [k, v] of Object.entries(patch.metadata ?? {})) { if (v === undefined) delete merged[k]; else merged[k] = v; }
    return chat.updateMessage(channel, id, { metadata: merged, ...(patch.message ? { message: patch.message } : {}) });
  },
}));
jest.mock('../../social-notify.js', () => ({ notify: async () => [] }));

import { MemoryAssistantStore, REMOVED_BY_INVITER } from '../store.js';
import { SqlAssistantStore } from '../store-sql.js';
import { setAssistantStore } from '../store-select.js';
import { eraseCall } from '../erase.js';
import { postAction, postAsAssistant } from '../chat.js';
import { DELETED_RECORD_LINE, NOVA_USER_ID } from '../chat-types.js';
import type { AssistantRecord } from '../types.js';

const CALL = 'call-1';
const WORDS = ['zebracrossing', 'marmalade', 'quokka', 'turbinefarm', 'saffronpilot'];
const base: AssistantRecord = {
  callId: CALL, tenant: 'orgiq', lobby: 'orgiq:initiative:p-auth', initiativeId: 'p-auth', state: 'left', invitedBy: 'u-vera', invitedAt: 1000, pausedBy: null, leftAt: 9000, leftBy: 'u-vera',
  acked: ['u-vera'], attendees: ['u-vera'], presentAtInvite: ['u-vera'], requests: 1, linesStored: 0, nextSeq: 1, pendingRequests: [],
};

async function seed(store: MemoryAssistantStore) {
  await store.create({ ...base, state: 'listening' });
  await store.transition(CALL, { from: ['listening'], to: 'left', by: 'u-vera', at: 9000 });
  await store.addRequest(CALL, { id: 'r1', askedBy: 'u-vera', text: `please book the ${WORDS[0]} room`, lines: [1], startedAt: 1, endedAt: 2 });
  await store.patchSession(CALL, { listeningSeconds: 120 });
  await store.putMinutes({ callId: CALL, tenant: 'orgiq', lobby: base.lobby, initiativeId: 'p-auth', callName: `The ${WORDS[1]} call`, startedAt: 1, endedAt: 2, invitedBy: 'u-vera', attendees: ['u-vera'], summary: `We discussed ${WORDS[1]}`, decisions: [`Adopt ${WORDS[2]}`], actionItems: [{ text: `Ship ${WORDS[2]}` }], topics: [WORDS[1]], lineCount: 1, truncated: false, writer: 'scripted', createdAt: 5000 });
  await store.createTurn({ turnId: 't1', callId: CALL, askedBy: 'u-vera', tool: { name: 'create_work_item', args: { title: `Fix the ${WORDS[3]}`, body: WORDS[4] } }, kind: 'write', status: 'done', actionId: 'a1', createdAt: 100, expiresAt: 900 });
  await store.createTurn({ turnId: 't2', callId: CALL, askedBy: 'u-vera', tool: { name: 'search', args: { q: WORDS[3] } }, kind: 'read', status: 'expired', createdAt: 100, expiresAt: 900 });
  // Lines are stored only while listening; seed one through a second record is not needed: the contract is the same.
  await postAsAssistant(CALL, { text: `Nova joined; the ${WORDS[1]} topic`, metadata: { assistant: true, displayName: 'Nova', kind: 'assistant-notice', meetingCallId: CALL } }, { minutes: true });
  // The call is over, so the reply goes in as the minutes message does (the one exception postAsAssistant allows after leaving).
  await postAsAssistant(CALL, { text: `The ${WORDS[2]} is ready`, metadata: { assistant: true, displayName: 'Nova', kind: 'assistant-reply', askedBy: 'u-vera', askedByName: 'Vera', private: false } }, { minutes: true });
  await postAction(CALL, { actionId: 'a1', askedBy: 'u-vera', askedByName: 'Vera', summary: `Create work item: ${WORDS[3]}`, detail: [`Title: ${WORDS[3]}`, `Body: ${WORDS[4]}`], tool: { name: 'create_work_item', argsDigest: 'abc123' } }, { minutes: true });
  await store.decideAction(CALL, 'a1', { from: ['waiting'], to: 'done', by: 'u-vera', at: 500, resultText: `Created ${WORDS[3]}` });
  await chat.putMessage({ id: 'h1', clientId: 'c', userId: 'u-nora', channel: `orgiq:huddle:${CALL}`, message: `I like the ${WORDS[2]} idea`, timestamp: new Date(2000).toISOString() });
}

describe('the inviter delete (memory store)', () => {
  let store: MemoryAssistantStore;
  beforeEach(async () => { updates.length = 0; (chat as unknown as { _reset(): void })._reset(); store = new MemoryAssistantStore(); setAssistantStore(store); await seed(store); });

  const everything = async () => JSON.stringify([
    await store.get(CALL), await store.lines(CALL, 0, 100), await store.getMinutes(CALL), await store.listTurns(CALL), await store.getAction(CALL, 'a1'),
    (await chat.listMessages(`orgiq:huddle:${CALL}`, 100)).filter((m) => m.userId === NOVA_USER_ID),
  ]);

  it('leaves none of the words in any stored field for the call', async () => {
    // A transcript line, written while listening, so the words really are in the lines table too.
    const live = new MemoryAssistantStore(); await live.create({ ...base, state: 'listening' });
    await live.appendLine({ callId: CALL, userId: 'u-vera', participantId: 'p', speakerName: 'Vera', text: `Let us talk about the ${WORDS[0]}`, at: 100, captionId: 'c1' });
    expect(JSON.stringify(await live.lines(CALL, 0, 10))).toContain(WORDS[0]);
    expect(await everything()).toEqual(expect.stringContaining(WORDS[3]));
    await eraseCall(live, CALL, 'u-vera', 9500);
    expect(await live.lines(CALL, 0, 10)).toEqual([]);

    await eraseCall(store, CALL, 'u-vera', 9500);
    const after = await everything();
    for (const w of WORDS) expect(after).not.toContain(w);
  });

  it('keeps ids, statuses and times, so the cards and counters stay consistent', async () => {
    await eraseCall(store, CALL, 'u-vera', 9500);
    expect((await store.get(CALL))).toMatchObject({ pendingRequests: [], requests: 2, state: 'left', leftAt: 9000, invitedBy: 'u-vera' });
    expect(await store.listTurns(CALL)).toEqual([
      expect.objectContaining({ turnId: 't1', status: 'done', actionId: 'a1', createdAt: 100, expiresAt: 900, tool: { name: 'create_work_item', args: REMOVED_BY_INVITER } }),
      expect.objectContaining({ turnId: 't2', status: 'expired', tool: { name: 'search', args: REMOVED_BY_INVITER } }),
    ]);
    expect(await store.getAction(CALL, 'a1')).toMatchObject({ status: 'done', decidedBy: 'u-vera', decidedAt: 500, resultText: REMOVED_BY_INVITER, argsDigest: '' });
    expect(await store.getMinutes(CALL)).toMatchObject({ deleted: { at: 9500, by: 'u-vera' } });
  });

  it("replaces Nova's chat text through updateThreadMessage and leaves people's messages alone", async () => {
    await eraseCall(store, CALL, 'u-vera', 9500);
    const rows = await chat.listMessages(`orgiq:huddle:${CALL}`, 100);
    const nova = rows.filter((m) => m.userId === NOVA_USER_ID);
    expect(nova).toHaveLength(3);
    for (const m of nova) expect(m.message).toBe(DELETED_RECORD_LINE);
    expect(updates).toHaveLength(3);
    const card = nova.find((m) => m.metadata?.['kind'] === 'assistant-action')!;
    expect(card.metadata).toMatchObject({ summary: DELETED_RECORD_LINE, status: 'waiting', actionId: 'a1' });
    expect(card.metadata?.['detail']).toBeUndefined(); expect(card.metadata?.['resultText']).toBeUndefined();
    expect(nova.find((m) => m.metadata?.['kind'] === 'assistant-notice')!.metadata?.['meetingCallId']).toBeUndefined(); // the link goes with the page
    expect(rows.find((m) => m.id === 'h1')!.message).toBe(`I like the ${WORDS[2]} idea`);
  });

  it("reaches Nova's messages that are the oldest of a 1,500-message chat", async () => {
    const channel = `orgiq:huddle:${CALL}`;
    for (let i = 0; i < 1500; i++) await chat.putMessage({ id: `bulk-${i}`, clientId: 'c', userId: 'u-nora', channel, message: `chatter ${i}`, timestamp: new Date(10_000 + i).toISOString() });
    const rows = await chat.listMessages(channel, 5000);
    const nova = rows.filter((m) => m.userId === NOVA_USER_ID);
    expect(nova).toHaveLength(3);
    expect(rows.indexOf(nova[nova.length - 1]!)).toBeLessThan(10);
    await eraseCall(store, CALL, 'u-vera', 9500);
    for (const m of (await chat.listMessages(channel, 5000)).filter((x) => x.userId === NOVA_USER_ID)) expect(m.message).toBe(DELETED_RECORD_LINE);
    expect(updates).toHaveLength(3);
  });

  it('is safe to repeat: a second erase changes no chat message and keeps the tombstone', async () => {
    await eraseCall(store, CALL, 'u-vera', 9500);
    updates.length = 0;
    await eraseCall(store, CALL, 'u-vera', 9600);
    expect(updates).toEqual([]);
    expect(await store.getMinutes(CALL)).toMatchObject({ deleted: { by: 'u-vera' } });
  });
});

describe('the inviter delete (SQL statements)', () => {
  it('is one statement that touches every table that holds words, and takes the placeholder as a parameter', async () => {
    const calls: Array<{ sql: string; params: Array<{ name: string; value?: { stringValue?: string } }> }> = [];
    const store = new SqlAssistantStore(async (sql, params) => { calls.push({ sql, params: (params ?? []) as never }); return [{ removed: 2 }]; });
    expect(await store.tombstoneMinutes(CALL, 'u-vera', 5)).toBe(2);
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0]!;
    for (const table of ['meeting_transcript_lines', 'meeting_assistants', 'meeting_assistant_turns', 'meeting_assistant_actions', 'meeting_minutes']) expect(sql).toContain(table);
    expect(sql).toMatch(/UPDATE meeting_assistants SET pending_requests = '\[\]'/);
    expect(sql).toMatch(/UPDATE meeting_assistant_turns SET tool_args = /);
    expect(sql).toMatch(/UPDATE meeting_assistant_actions SET args_digest = '', result_text = CASE WHEN result_text IS NULL/);
    expect(params.find((p) => p.name === 'removed')?.value?.stringValue).toBe(REMOVED_BY_INVITER);
  });
});
