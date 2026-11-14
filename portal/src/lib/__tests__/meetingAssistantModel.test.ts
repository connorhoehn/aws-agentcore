import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_POLL_MS, assistantControls, assistantPresent, assistantStateWords, noticeText, noticeVisible, NO_ASSISTANT, parseAssistantState, rosterEntry, markWords, timeLeftWords,
} from '../meetingAssistantModel.ts';

const view = (state: string, extra: Record<string, unknown> = {}) => parseAssistantState('c1', { state, invitedBy: 'u-a', invitedByName: 'Vera Lindqvist', youMustAck: false, ...extra });

test('a bad or missing body reads as no assistant', () => {
  for (const body of [null, undefined, 'x', [], {}, { state: 'weird' }]) assert.equal(parseAssistantState('c1', body).phase, 'none');
  assert.equal(parseAssistantState('c1', { state: 'none', youMustAck: true }).youMustAck, false);
});

test('the state is said in words and the poll is no faster than five seconds', () => {
  assert.equal(assistantStateWords(view('listening')), 'Nova is listening');
  assert.equal(assistantStateWords(view('invited')), 'Nova is listening');
  assert.equal(assistantStateWords(view('paused')), 'Nova is paused');
  assert.equal(assistantStateWords(view('left')), 'Nova has left this call');
  assert.equal(assistantStateWords(NO_ASSISTANT('c1')), null);
  assert.ok(ASSISTANT_POLL_MS >= 5000);
});

test('Invite needs the capability and an empty call; pause, resume and dismiss are for everyone', () => {
  const base = { enabled: true, inCall: true, canInvite: true };
  assert.equal(assistantControls({ ...base, view: NO_ASSISTANT('c1') }).invite, true);
  assert.equal(assistantControls({ ...base, canInvite: false, view: NO_ASSISTANT('c1') }).invite, false);
  const listening = assistantControls({ ...base, canInvite: false, view: view('listening') });
  assert.deepEqual([listening.invite, listening.pause, listening.resume, listening.dismiss], [false, true, false, true]);
  const paused = assistantControls({ ...base, canInvite: false, view: view('paused') });
  assert.deepEqual([paused.pause, paused.resume, paused.dismiss], [false, true, true]);
});

test('after dismissal Invite does not return and the bar says Nova left', () => {
  const left = assistantControls({ enabled: true, inCall: true, canInvite: true, view: view('left') });
  assert.deepEqual([left.invite, left.pause, left.resume, left.dismiss, left.left], [false, false, false, false, true]);
});

test('with the flag off, or outside a call, everything is hidden', () => {
  for (const input of [{ enabled: false, inCall: true }, { enabled: true, inCall: false }]) {
    const c = assistantControls({ ...input, canInvite: true, view: view('listening') });
    assert.equal(c.hidden, true);
    assert.equal(c.invite || c.pause || c.resume || c.dismiss || c.left, false);
  }
});

test('the notice shows only to someone who owes an acknowledgement while Nova is present', () => {
  assert.equal(noticeVisible(true, view('listening', { youMustAck: true })), true);
  assert.equal(noticeVisible(true, view('paused', { youMustAck: true })), true);
  assert.equal(noticeVisible(true, view('listening')), false);
  assert.equal(noticeVisible(true, view('left', { youMustAck: true })), false);
  assert.equal(noticeVisible(false, view('listening', { youMustAck: true })), false);
});

test('the notice names the inviter and says where speech goes, for how long, and what is kept before agreeing', () => {
  const n = noticeText(view('listening', { youMustAck: true }));
  assert.match(n.title, /Vera Lindqvist invited Nova/);
  assert.match(n.body, /speech provider/); assert.match(n.body, /30 days/); assert.match(n.body, /Nothing you say is kept until you acknowledge/);
  assert.match(noticeText(view('listening', { invitedByName: null })).title, /^A participant invited Nova/);
});

test('the roster entry is a non-human line with its label and state', () => {
  assert.equal(rosterEntry(view('listening')), 'Nova (Assistant, listening)');
  assert.equal(rosterEntry(view('paused')), 'Nova (Assistant, paused)');
  assert.equal(rosterEntry(view('left')), null);
  assert.equal(assistantPresent(NO_ASSISTANT('c1')), false);
});

test('time left shows under ten minutes while listening, rounded up, never negative', () => {
  assert.equal(timeLeftWords(view('listening', { listeningSeconds: 100, ceilingSeconds: 3600 })), null);
  assert.equal(timeLeftWords(view('listening', { listeningSeconds: 3000, ceilingSeconds: 3600 })), null);
  assert.equal(timeLeftWords(view('listening', { listeningSeconds: 3061, ceilingSeconds: 3600 })), '9 min left');
  assert.equal(timeLeftWords(view('listening', { listeningSeconds: 3700, ceilingSeconds: 3600 })), '0 min left');
  assert.equal(timeLeftWords(view('paused', { listeningSeconds: 3500, ceilingSeconds: 3600 })), null);
  assert.equal(timeLeftWords(view('listening')), null);
});

test('the mark says Nova cannot hear you until you acknowledge, and the menu offers it', () => {
  const owing = view('listening', { youMustAck: true });
  assert.equal(markWords(owing, true), 'Nova cannot hear you yet');
  const controls = assistantControls({ enabled: true, inCall: true, canInvite: false, view: owing });
  assert.equal(controls.acknowledge, true);
  assert.equal(controls.extend, false);
  assert.equal(markWords(owing, false), 'Nova is listening');
  assert.equal(markWords(view('listening'), true), 'Nova is listening');
  assert.equal(assistantControls({ enabled: true, inCall: true, canInvite: true, view: view('listening') }).extend, true);
  assert.equal(assistantControls({ enabled: true, inCall: true, canInvite: true, view: view('left') }).extend, false);
});

test('the call state carries the call initiative', () => {
  assert.equal(parseAssistantState('c1', { state: 'listening', initiativeId: 'p-1' }).initiativeId, 'p-1');
  assert.equal(parseAssistantState('c1', { state: 'listening' }).initiativeId, null);
});

test('S13: Meetings shows only while the session advertises the feature', async () => {
  const { meetingsAdvertised } = await import('../meetingAssistantModel.ts');
  const { PALETTE } = await import('./../voice/__tests__/voiceHarness.ts');
  assert.equal(meetingsAdvertised({ meetingAssistant: true }), true);
  for (const s of [{ meetingAssistant: false }, {}, null, undefined]) assert.equal(meetingsAdvertised(s), false);
  const row = PALETTE.pages.find((p) => p.path === '/iq/meetings') as { feature?: string } | undefined;
  assert.equal(row?.feature, 'meetingAssistant', 'the palette row is tied to the flag');
});
