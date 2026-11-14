#!/usr/bin/env node
// The call assistant's call UI (docs/meeting-assistant-design.md, package 3), walked in a browser on the default mock
// world with no media, no microphone and no paid session:
//   1 Invite Nova is offered to a person in a call    2 inviting: "Nova is listening" for both, Nova in the roster
//   3 the notice shows to the second person only      4 nothing stored before the acknowledgement, lines after it
//   5 pause and resume from the second person         7 nothing clipped or scrolling in the call bar at 1280 (run before 6)
//   6 dismiss: the mark goes, Invite does not return, "Nova has left this call"
//   8 to 11 (package 4a, API level: the scripted session answers, no model): a spoken read lands in the call chat labelled with
//     the asker; a write is a card only the asker confirms and shows as a running turn only after that; a tool call from someone
//     who never said the name is refused and counted; after dismissal the inviter's spend has a meeting_assistant entry.
//   12 to 17 (package 5, the minutes; the scripted writer): the leaving message in the call chat, the meeting page at 1440 and 1280,
//     a person who was not there gets 404 and a not-found page, the Meetings list, the :minutes ledger entry, the inviter's delete.
//
// Two people share one call without media the way portal/e2e/work-huddle-navigation.spec.ts does: one starts a call on an
// initiative page, the other accepts the ring, and the SFU session metadata is the only thing stubbed (the realtime token
// advertises a stand-in platform API that answers join/end; mic and camera stay off). Seats, call chat and the gateway are real.
// Transcript lines come from the mock-only injector (POST /api/dev/calls/:callId/transcript-lines).
//
//   cd portal && npm run journey:meeting-assistant [-- --shots <dir> --out <dir>]
//
// Exit codes as learning-loop.mjs: 0 every step passed, 1 a step failed, 2 the stack is unreachable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(path.join(ROOT, 'portal', 'package.json'));
const playwright = await import(pathToFileURL(req.resolve('playwright')).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORTAL = (process.env.PORTAL_URL ?? 'http://localhost:5166').replace(/\/$/, '');
const MIDDLEWARE = (process.env.MIDDLEWARE_URL ?? 'http://127.0.0.1:3966').replace(/\/$/, '');
const OUT = flag('--out') ?? process.env.OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-assistant-'));
const SHOTS = flag('--shots') ?? path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const VERA = { userId: 'u-vera', role: 'org-leader' };
const NORA = { userId: 'u-nora', role: 'sme' };
const INITIATIVE = '/iq/projects/p-observability';
const PRE_JOIN_KEY = 'orgiq.call-prejoin.v1';
const STAND_IN_SFU = 'http://meeting-assistant.test';

class StepFailure extends Error {}
const check = (cond, msg) => { if (!cond) throw new StepFailure(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');

async function reachable() {
  for (const [name, url] of [['middleware', `${MIDDLEWARE}/api/health`], ['portal', `${PORTAL}/`]]) {
    try { const r = await fetch(url); if (r.status >= 500) throw new Error(`HTTP ${r.status}`); } catch (e) { return `${name} at ${url}: ${e.message}`; }
  }
  return null;
}

/** Waits for a test id to be (in)visible; the assistant state refreshes every five seconds, so the waits are generous. */
async function seen(page, id, ms = 15000) {
  await page.getByTestId(id).first().waitFor({ state: 'visible', timeout: ms }).catch(() => { throw new StepFailure(`${id} never appeared`); });
}
async function gone(page, id, ms = 15000) {
  await page.getByTestId(id).first().waitFor({ state: 'detached', timeout: ms }).catch(() => { throw new StepFailure(`${id} never went away`); });
}
async function markText(page, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = (await page.getByTestId('nova-mark').first().innerText().catch(() => '')).trim();
    if (t) return t;
    await sleep(300);
  }
  return '';
}
async function waitMark(page, re, ms = 15000) {
  const end = Date.now() + ms;
  let t = '';
  while (Date.now() < end) { t = await markText(page, 600); if (re.test(t)) return t; await sleep(400); }
  throw new StepFailure(`the call bar never read ${re}: "${t}"`);
}

/** The bar: no sideways page scroll, Nova's controls inside the call dock, the dock inside the footer row, no control cut off. */
async function barFits(page, label, width) {
  await page.setViewportSize({ width, height: 900 });
  await sleep(700);
  const r = await page.evaluate(() => {
    const rect = (el) => el.getBoundingClientRect();
    const dock = document.querySelector('[data-testid="shell-call-dock"]');
    const row = document.querySelector('[data-testid="shell-footer-row"]');
    const nova = document.querySelector('[data-testid="nova-bar"]');
    if (!dock || !row) return { missing: !dock ? 'shell-call-dock' : 'shell-footer-row' };
    const bad = [];
    const scrollX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const rr = rect(row), dr = rect(dock);
    if (dr.right > rr.right + 1) bad.push(`dock ends at ${Math.round(dr.right)}, row at ${Math.round(rr.right)}`);
    if (dock.scrollWidth > dock.clientWidth + 1) bad.push(`dock scrolls by ${dock.scrollWidth - dock.clientWidth}px`);
    for (const el of dock.querySelectorAll('button')) {
      const b = rect(el);
      if (b.width > 0 && (b.right > dr.right + 1 || b.left < dr.left - 1)) bad.push(`${el.getAttribute('data-testid') ?? el.textContent?.trim().slice(0, 18)} outside the dock`);
    }
    if (nova) {
      const nr = rect(nova);
      if (nr.right > rr.right + 1 || nr.left < rr.left - 1) bad.push(`Nova's controls run outside the footer row (${Math.round(nr.left)}..${Math.round(nr.right)} in ${Math.round(rr.left)}..${Math.round(rr.right)})`);
      if (nr.height > 40) bad.push(`Nova's controls wrapped (${Math.round(nr.height)}px tall)`);
      for (const el of nova.querySelectorAll('[data-testid]')) {
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') bad.push(`${el.getAttribute('data-testid')} is cut off`);
      }
    }
    return { scrollX, bad, barHeight: Math.round(rr.height), rowHeight: Math.round(rr.height), novaWidth: nova ? Math.round(rect(nova).width) : 0 };
  });
  check(!r.missing, `${label}: ${r.missing} is not on the page`);
  check(r.scrollX <= 1, `${label} scrolls sideways at ${width} by ${r.scrollX}px`);
  check(r.bad.length === 0, `${label} at ${width}: ${r.bad.join('; ')}`);
  return r;
}
async function shot(page, name, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await sleep(600);
  await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: false });
}

async function main() {
  const down = await reachable();
  if (down) { console.error(`meeting-assistant: unreachable: ${down}`); return 2; }
  const r = await fetch(`${MIDDLEWARE}/api/__mock/reset`, { method: 'POST' });
  if (r.status !== 200) { console.error(`meeting-assistant: POST /api/__mock/reset answered ${r.status}`); return 2; }

  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const results = [];
  const errors = [];
  const allErrors = []; // every page error of the whole walk, never cleared: the last step fails on any
  const results_ = []; // every result post a browser made: { turnId, ok, say, answered }
  const contexts = [];
  let callId = null;

  /** Collects page errors (the step's and the walk's) and every claim result the page posts, with what the server answered. */
  function watch(page, label) {
    page.on('pageerror', (e) => { errors.push(`${label}: ${e.message}`); allErrors.push(`${label}: ${e.message}`); });
    page.on('response', async (res) => {
      const m = /\/api\/calls\/[^/]+\/assistant\/turns\/([^/]+)\/result$/.exec(new URL(res.url()).pathname);
      if (!m || res.request().method() !== 'POST') return;
      let sent = {}; let answered = null;
      try { sent = JSON.parse(res.request().postData() ?? '{}'); } catch { /* not json */ }
      try { answered = (await res.json()).status ?? null; } catch { /* not json */ }
      results_.push({ turnId: decodeURIComponent(m[1]), by: label, ok: sent.ok === true, say: sent.output?.say ?? null, http: res.status(), answered });
    });
  }

  /** A signed-in person with their own browser context and page, the call's SFU stubbed (see the header). */
  async function person(who) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(context);
    const login = await context.request.post(`${PORTAL}/api/session/login`, { data: { userId: who.userId } });
    check(login.status() === 200, `login ${who.userId}: ${login.status()}`);
    const role = await context.request.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: who.role } });
    check(role.status() === 200, `role ${who.role}: ${role.status()}`);
    await context.addInitScript(([key]) => localStorage.setItem(key, JSON.stringify({ micOn: false, cameraOn: false, remember: true })), [PRE_JOIN_KEY]);
    await context.route('**/api/session/realtime-token', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), platformApiUrl: STAND_IN_SFU, videoUrl: null } });
    });
    await context.route(`${STAND_IN_SFU}/**`, (route) => {
      const p = new URL(route.request().url()).pathname;
      return route.fulfill({ json: p.endsWith('/join') ? { participantId: `participant-${who.userId}`, token: null } : p.endsWith('/end') ? { ok: true } : { sessionId: 'meeting-assistant-signalling-only' } });
    });
    const page = await context.newPage();
    watch(page, who.userId);
    page.on('request', (rq) => { const m = /\/api\/calls\/([^/]+)\/chat(?:\?|$)/.exec(new URL(rq.url()).pathname + new URL(rq.url()).search); if (m && !callId) callId = decodeURIComponent(m[1]); });
    await page.goto(`${PORTAL}${INITIATIVE}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.getByTestId('initiative-header').waitFor({ timeout: 30000 });
    return { who, context, page, api: context.request };
  }

  const step = async (name, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      check(errors.length === 0, `page errors: ${errors.join(' | ')}`);
      results.push({ step: name, ok: true, ms: Date.now() - started, detail });
      console.log(`PASS ${name}${detail ? `\n  ${detail}` : ''}`);
    } catch (e) {
      results.push({ step: name, ok: false, ms: Date.now() - started, error: e.message });
      console.log(`FAIL ${name}\n  ${e.message}`);
      if (!(e instanceof StepFailure)) console.log(e.stack);
      errors.length = 0;
    }
  };
  /** Pause, Resume or Dismiss live in the mark's menu (one compact control keeps the footer on a line). */
  const novaMenu = async (p, name) => {
    await p.page.getByTestId('nova-mark').click();
    await p.page.getByRole('menuitem', { name }).click();
  };
  const transcript = async (p) => {
    const res = await p.api.get(`${PORTAL}/api/calls/${encodeURIComponent(callId)}/assistant/transcript`);
    check(res.status() === 200, `GET transcript answered ${res.status()}`);
    return (await res.json()).lines.map((l) => l.text);
  };
  const inject = async (userId, text) => {
    const res = await fetch(`${MIDDLEWARE}/api/dev/calls/${encodeURIComponent(callId)}/transcript-lines`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId, text }),
    });
    check(res.status < 300, `the injector answered ${res.status}`);
  };
  const stored = async (p, text, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if ((await transcript(p)).includes(text)) return true; await sleep(500); }
    return false;
  };

  const asApi = (p, p2) => `${PORTAL}/api/calls/${encodeURIComponent(callId)}/assistant/${p2}`;
  const chatMessages = async (p) => {
    const res = await p.api.get(`${PORTAL}/api/calls/${encodeURIComponent(callId)}/chat?limit=100`);
    check(res.status() === 200, `GET the call chat answered ${res.status()}`);
    return (await res.json()).messages;
  };
  const novaOf = async (p, kind) => (await chatMessages(p)).filter((m) => m.metadata?.kind === kind);
  const waitFor = async (fn, ms, what) => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new StepFailure(`${what} never happened`); await sleep(400); }
  };
  const myTurns = async (p) => {
    const res = await p.api.get(asApi(p, 'turns?mine=1'));
    check(res.status() === 200, `GET turns answered ${res.status()}`);
    return (await res.json()).turns;
  };
  const chatPanel = (p) => p.page.getByTestId('huddle-thread');
  const workTitles = async (p) => {
    const res = await p.api.get(`${PORTAL}/api/graph/work`);
    check(res.status() === 200, `GET the work list answered ${res.status()}`);
    const rows = JSON.stringify(await res.json());
    return rows;
  };
  /** Every work item with exactly this title, as { id, projectId }, found anywhere in the work list's JSON. */
  const itemsTitled = async (p, title) => {
    const res = await p.api.get(`${PORTAL}/api/graph/work`);
    check(res.status() === 200, `GET the work list answered ${res.status()}`);
    const found = [];
    const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (typeof v.title === 'string' && v.title.toLowerCase().includes(title.toLowerCase())) found.push({ id: v.id, projectId: v.projectId ?? v.project_id ?? null, title: v.title }); Object.values(v).forEach(walk); } };
    walk(await res.json());
    return found;
  };
  const stateOf = async (p) => (await (await p.api.get(asApi(p, 'state'))).json());

  let vera, nora;
  try {
    // ── Setup: two people in one call, no media ──
    await step('0: setup: one person starts a call on an initiative, the other accepts, both are in it', async () => {
      vera = await person(VERA);
      nora = await person(NORA);
      const me = await (await vera.api.get(`${PORTAL}/api/session/me`)).json();
      check(me.meetingAssistant === true, `/api/session/me does not advertise the assistant: ${JSON.stringify(me.meetingAssistant)}`);
      await vera.page.getByTestId('initiative-start-call').click();
      await nora.page.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 30000 });
      await vera.page.getByTestId('shell-call-dock').waitFor({ timeout: 30000 });
      await nora.page.getByTestId('shell-call-dock').waitFor({ timeout: 30000 });
      const end = Date.now() + 15000;
      while (!callId && Date.now() < end) await sleep(300);
      check(callId, 'no call id was seen on the wire');
      return `call ${callId}`;
    });
    if (!callId) throw new StepFailure('no call to walk');

    // ── 1. Invite is offered ──
    await step('1: the feature is advertised; a person in the call sees Invite Nova (every orgiq role holds the capability, so the "without it" half is skipped here and unit-tested in meetingAssistantModel)', async () => {
      await seen(vera.page, 'nova-invite');
      await seen(nora.page, 'nova-invite');
      const heights = [];
      for (const width of [1440, 1280]) heights.push(`${width}: ${(await barFits(vera.page, 'the bar with Invite Nova', width)).barHeight}px`);
      await shot(vera.page, '1-invite');
      return `Invite Nova on both bars; no mark yet; bar height ${heights.join(', ')}`;
    });

    // ── 2. Invite ──
    await step('2: inviting shows "Nova is listening" to both people and Nova in the roster; Invite goes', async () => {
      await vera.page.getByTestId('nova-invite').click();
      const a = await waitMark(vera.page, /^Nova is listening$/);
      const b = await waitMark(nora.page, /^Nova is listening$/);
      await gone(vera.page, 'nova-invite');
      await gone(nora.page, 'nova-invite');
      // The roster: the conversation pane's destination row (the call's tiles never list a non-media entry).
      const chat = vera.page.getByTestId('shell-call-dock-chat');
      if (!(await vera.page.getByTestId('conversation-pane-destination').isVisible().catch(() => false))) await chat.click();
      await seen(vera.page, 'nova-roster-entry');
      const line = (await vera.page.getByTestId('nova-roster-entry').innerText()).trim();
      check(/Nova \(Assistant, listening\)/.test(line), `the roster line does not name Nova: "${line}"`);
      check(!(await vera.page.locator('[data-call-stream], video').filter({ hasText: /Nova/ }).count()), 'Nova took a media tile');
      for (const width of [1440, 1280]) await barFits(vera.page, 'the bar with Nova listening', width);
      await shot(vera.page, '2-listening-roster');
      return `marks "${a}" and "${b}"; roster "${line.trim().slice(0, 120)}"`;
    });

    // ── 3. The notice ──
    await step('3: the second person sees the notice (the inviter named, speech provider, the retention period set by the organisation, nothing kept until acknowledged); the inviter does not', async () => {
      await seen(nora.page, 'nova-notice');
      const text = (await nora.page.getByTestId('nova-notice').innerText()).replace(/\s+/g, ' ');
      const inviterName = (await (await vera.api.get(`${PORTAL}/api/session/me`)).json()).name;
      check(typeof inviterName === 'string' && inviterName.length > 0, `the inviter has no display name: ${inviterName}`);
      check(text.includes(`${inviterName} invited Nova`), `the notice does not name the inviter "${inviterName}": "${text}"`);
      check(/speech provider/.test(text), `the notice does not say speech goes to a provider: "${text}"`);
      check(/retention period set by your organisation/.test(text) && !/30 days/.test(text), `the notice does not say how long it is kept, or promises a fixed period: "${text}"`);
      check(/Nothing you say is kept until you acknowledge/.test(text), `the notice does not say nothing is kept before acknowledging: "${text}"`);
      check(await nora.page.getByTestId('nova-notice-acknowledge').isVisible(), 'no acknowledge control');
      check(await nora.page.getByTestId('nova-notice-secondary').isVisible(), 'no way to dismiss Nova from the notice');
      check(await vera.page.getByTestId('nova-notice').count() === 0, 'the inviter sees the notice');
      await barFits(nora.page, 'the bar under the notice', 1280);
      await shot(nora.page, '3-notice');
      return `"${text.slice(0, 200)}"`;
    });

    // ── 3b. Hiding the notice does not acknowledge; the mark keeps offering it ──
    await step('3b: the second person closes the notice with its own mark: nothing is acknowledged, and the Nova mark says Nova cannot hear them with Acknowledge one click away', async () => {
      await nora.page.getByTestId('nova-notice-dismiss').click();
      await gone(nora.page, 'nova-notice');
      await waitMark(nora.page, /^Nova cannot hear you yet$/);
      check((await stateOf(nora)).youMustAck === true, 'closing the notice acknowledged for the person');
      check(await vera.page.getByTestId('nova-mark').innerText().then((t) => /Nova is listening/.test(t)), 'the inviter\'s mark changed');
      await nora.page.getByTestId('nova-mark').click();
      const item = nora.page.getByRole('menuitem', { name: /Acknowledge/ });
      check(await item.isVisible(), 'no Acknowledge in the Nova menu');
      check(/cannot hear you until you do/i.test(await item.innerText()), 'the Acknowledge item does not say why');
      await barFits(nora.page, 'the bar with the mark prompting', 1280);
      await shot(nora.page, '3b-notice-hidden-mark-menu');
      await barFits(nora.page, 'the bar with the mark prompting', 1440);
      await nora.page.keyboard.press('Escape');
      return 'notice hidden; mark "Nova cannot hear you yet"; menu offers Acknowledge';
    });

    // ── 4. Nothing kept before the acknowledgement ──
    await step('4: a line for the second person is not stored before they acknowledge; after they do, a new one is', async () => {
      const before = 'Before ack: the canary rollout is on hold until Thursday.';
      const after = 'After ack: the canary rollout resumes on Friday.';
      await inject(NORA.userId, before);
      check(!(await stored(vera, before, 3500)), 'a line from a person who had not acknowledged was stored');
      await novaMenu(nora, /Acknowledge/);
      await waitMark(nora.page, /^Nova is listening$/);
      check((await stateOf(nora)).youMustAck === false, 'the menu\'s Acknowledge did not acknowledge');
      await inject(NORA.userId, after);
      check(await stored(vera, after, 10000), 'a line after the acknowledgement was not stored');
      check(!(await transcript(vera)).includes(before), 'the line from before the acknowledgement appeared later');
      return 'before: absent; after: stored';
    });

    // ── 5. Pause and resume ──
    await step('5: the second person pauses Nova: both see "paused" and a line is not stored; resume brings listening back', async () => {
      await novaMenu(nora, 'Pause Nova');
      await waitMark(nora.page, /^Nova is paused$/);
      await waitMark(vera.page, /^Nova is paused$/);
      await vera.page.getByTestId('nova-mark').click();
      check(await vera.page.getByRole('menuitem', { name: 'Resume Nova' }).isVisible(), 'no Resume Nova while paused');
      check(await vera.page.getByRole('menuitem', { name: 'Pause Nova' }).count() === 0, 'Pause Nova is offered while paused');
      await vera.page.keyboard.press('Escape');
      const heldBack = 'While paused: this must not be kept.';
      await inject(NORA.userId, heldBack);
      check(!(await stored(vera, heldBack, 3500)), 'a line was stored while Nova was paused');
      await barFits(vera.page, 'the bar while paused', 1280);
      await shot(vera.page, '5-paused');
      await novaMenu(vera, 'Resume Nova');
      await waitMark(vera.page, /^Nova is listening$/);
      await waitMark(nora.page, /^Nova is listening$/);
      const resumed = 'After resume: kept again.';
      await inject(NORA.userId, resumed);
      check(await stored(vera, resumed, 10000), 'a line after resume was not stored');
      return 'paused: both see it, nothing stored; resumed: stored';
    });

    // ── 8. A spoken read is answered in the call chat, labelled with who asked (the scripted session: no model) ──
    await step('8: "Nova, what is two plus two?" from the inviter lands in the call chat as Nova\'s reply to that person; nothing else was asked of the browser', async () => {
      await inject(VERA.userId, 'Nova, what is two plus two?');
      const reply = await waitFor(async () => (await novaOf(vera, 'assistant-reply')).find((m) => m.message === 'Four.'), 20000, 'the reply "Four."');
      check(reply.metadata.askedBy === VERA.userId, `the reply is labelled for ${reply.metadata.askedBy}, not ${VERA.userId}`);
      check(typeof reply.metadata.askedByName === 'string' && reply.metadata.askedByName.length > 0 && reply.metadata.askedByName !== VERA.userId, `the label has no display name: ${reply.metadata.askedByName}`);
      check((await myTurns(vera)).length === 0, 'a plain answer left a turn for the browser');
      check((await myTurns(nora)).length === 0, 'a plain answer left a turn for the other person');
      return `reply "Four." labelled "${reply.metadata.askedByName}"`;
    });

    // ── 8a. A spoken read runs in the asker's own browser ──
    await step('8a: "Nova, search for login" from the inviter: the inviter\'s browser runs the read and posts the result, and Nova\'s reply appears in the chat labelled with the asker', async () => {
      const beforeReplies = (await novaOf(vera, 'assistant-reply')).length;
      const refusedBefore = (await stateOf(vera)).refusedCalls ?? 0;
      await inject(VERA.userId, 'Nova, search for login');
      const reply = await waitFor(async () => (await novaOf(vera, 'assistant-reply')).slice(beforeReplies).find((m) => m.message === 'Here is the result.'), 25000, 'the reply to the search');
      check(reply.metadata.askedBy === VERA.userId, `the reply is labelled for ${reply.metadata.askedBy}`);
      check((await myTurns(vera)).length === 0, 'the read is still waiting for the browser');
      const posted = results_.filter((r) => r.by === VERA.userId && r.ok && r.answered === 'done');
      check(posted.length >= 1, `no result post of the asker's browser was answered "done": ${JSON.stringify(results_)}`);
      check(((await stateOf(vera)).refusedCalls ?? 0) === refusedBefore, 'the read was refused');
      await seen(vera.page, 'huddle-thread');
      const label = await waitFor(async () => /Here is the result\.[\s\S]*Asked by Vera/.test(await chatPanel(vera).innerText()), 15000, 'the reply and its "Asked by" line on the inviter\'s screen');
      await shot(vera.page, '8a-read-reply-labelled');
      await shot(vera.page, '8a-read-reply-labelled', 1440);
      return `reply "${reply.message}" labelled "${reply.metadata.askedByName}"; shown with "Asked by"`;
    });

    // ── 9. A write is a card; only the asker confirms; the asker's browser then runs it ──
    await step('9: "Nova, create a work item ..." is a card both people see, controls for the asker only; the asker confirms in the chat, the browser creates it, the card reads done, and it exists', async () => {
      await inject(VERA.userId, 'Nova, create a work item for the login cookie bug.');
      const card = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.tool?.name === 'create' && /login cookie bug/.test(m.metadata.summary)), 20000, 'the action card');
      check(card.metadata.askedBy === VERA.userId && card.metadata.status === 'waiting', `the card is ${card.metadata.status} for ${card.metadata.askedBy}`);
      check((await myTurns(vera)).length === 0, 'a turn reached the asker\'s browser before they confirmed');
      check((await itemsTitled(vera, 'login cookie bug')).length === 0, 'the work item existed before the card was confirmed');
      const callInitiative = (await stateOf(vera)).initiativeId;
      check(callInitiative === 'p-observability', `the call's initiative is ${callInitiative}`);
      // Both people see the card; only the asker has controls.
      const veraCard = vera.page.getByTestId('assistant-action-card').filter({ hasText: /login cookie bug/ }).last();
      const noraCard = nora.page.getByTestId('assistant-action-card').filter({ hasText: /login cookie bug/ }).last();
      await veraCard.waitFor({ timeout: 20000 }); await noraCard.waitFor({ timeout: 20000 });
      check(await veraCard.getByTestId('assistant-action-confirm').isVisible(), 'the asker has no Confirm');
      check(await noraCard.getByTestId('assistant-action-confirm').count() === 0 && await noraCard.getByTestId('assistant-action-decline').count() === 0, 'the other person has controls on the card');
      const cardText = await veraCard.innerText();
      check(cardText.includes(card.metadata.summary), `the card does not carry the action's sentence "${card.metadata.summary}": "${cardText}"`);
      check(/title\W.*login cookie bug/i.test(cardText), `the card has no title line: "${cardText}"`);
      check(/Initiative: .+/.test(cardText), `the card names no initiative: "${cardText}"`);
      check(/Waiting for Vera/.test(await noraCard.innerText()), `the other person's card does not say who it waits for: "${await noraCard.innerText()}"`);
      await shot(vera.page, '9-card-waiting-asker'); await shot(nora.page, '9-card-waiting-other');
      const stranger = await nora.api.post(asApi(nora, `actions/${encodeURIComponent(card.metadata.actionId)}/decision`), { data: { decision: 'confirm' } });
      check(stranger.status() === 403, `another person confirming answered ${stranger.status()}, not 403`);
      check((await myTurns(vera)).length === 0, 'another person\'s confirm made a turn');
      await veraCard.getByTestId('assistant-action-confirm').click();
      await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.actionId === card.metadata.actionId && m.metadata.status === 'done'), 25000, 'the card going to done');
      const made = await itemsTitled(vera, 'login cookie bug');
      check(made.length === 1, `${made.length} work items titled "login cookie bug" exist after one confirm, not one: ${JSON.stringify(made)}`);
      check(made[0].projectId === callInitiative, `the work item is on ${made[0].projectId}, the call's initiative is ${callInitiative}`);
      check((await myTurns(vera)).length === 0, 'the confirmed turn is still waiting');
      await waitFor(async () => /Done/.test(await noraCard.getByTestId('assistant-action-status').innerText()) && (await noraCard.getByTestId('assistant-action-result').count()) > 0, 15000, 'the other person\'s card reading done with a result sentence');
      const resultLine = await noraCard.getByTestId('assistant-action-result').innerText();
      await shot(nora.page, '9-card-done-other'); await shot(vera.page, '9-card-done-asker');
      await shot(vera.page, '9-card-done-asker', 1440);
      return `card waiting (controls: asker only), 403 for the other person, confirmed in the UI, done: "${resultLine}"; the work item exists`;
    });

    // ── 9c. A declined card creates nothing ──
    await step('9c: a second card is declined by the asker: it reads declined for both, nothing is created, no turn reaches the browser', async () => {
      await inject(VERA.userId, 'Nova, create a work item for the nightly export audit.');
      const card = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => /nightly export audit/.test(m.metadata.summary)), 20000, 'the second card');
      const veraCard = vera.page.getByTestId('assistant-action-card').filter({ hasText: /nightly export audit/ }).last();
      await veraCard.waitFor({ timeout: 20000 });
      await veraCard.getByTestId('assistant-action-decline').click();
      await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.actionId === card.metadata.actionId && m.metadata.status === 'declined'), 15000, 'the card going to declined');
      const noraCard = nora.page.getByTestId('assistant-action-card').filter({ hasText: /nightly export audit/ }).last();
      await waitFor(async () => /Declined/.test(await noraCard.getByTestId('assistant-action-status').innerText()), 15000, 'the other person seeing declined');
      await sleep(3500);
      check(!(await workTitles(vera)).includes('nightly export audit'), 'a declined card created the work item');
      check((await myTurns(vera)).length === 0, 'a declined card left a turn');
      await shot(vera.page, '9c-card-declined');
      return 'declined for both; nothing created';
    });

    // ── 9d. A private answer reaches only the asker ──
    await step('9d: "Nova, how much budget do I have" is answered privately: the asker\'s toast reads the answer itself, the call chat shows only "Answered privately for Vera.", and the other person sees nothing', async () => {
      const noraBefore = (await chatMessages(nora)).length;
      const asks = (await novaOf(vera, 'assistant-reply')).length;
      const sentBefore = results_.length;
      await inject(VERA.userId, 'Nova, how much budget do I have?');
      const toast = vera.page.getByText(/only you can see this/i).first();
      await toast.waitFor({ timeout: 25000 });
      const sent = await waitFor(() => results_.slice(sentBefore).find((r) => r.by === VERA.userId && r.ok && typeof r.say === 'string' && r.say.length > 0), 15000, 'the private result post with a say sentence');
      check(sent.answered === 'done', `the private turn was answered "${sent.answered}", not done`);
      await shot(vera.page, '9d-private-toast');
      const toastBox = await toast.evaluate((el) => (el.closest('[role="status"],[role="alert"],[data-testid*="toast"]') ?? el.parentElement).innerText.replace(/\s+/g, ' '));
      check(toastBox.includes(sent.say.replace(/\s+/g, ' ').trim()), `the toast "${toastBox}" does not carry the say sentence "${sent.say}"`);
      await waitFor(async () => (await novaOf(vera, 'assistant-reply')).length === asks + 1, 15000, 'the one public line');
      const line = (await novaOf(vera, 'assistant-reply')).slice(asks);
      check(line.length === 1 && /^Answered privately for Vera/.test(line[0].message), `the call chat got: ${JSON.stringify(line.map((m) => m.message))}`);
      const noraChat = (await chatMessages(nora)).slice(noraBefore).filter((m) => m.metadata?.assistant || m.metadata?.kind);
      check(noraChat.every((m) => /^Answered privately for Vera/.test(m.message)), `the other person's chat carries more than the fixed line: ${JSON.stringify(noraChat.map((m) => m.message))}`);
      check(!(await chatPanel(nora).innerText()).includes(sent.say.slice(0, 40)), 'the private sentence is in the other person\'s chat');
      check(await nora.page.getByText(/only you can see this/i).count() === 0, 'the other person sees the private toast');
      return `toast: "${toastBox.slice(0, 120)}"; public line "${line[0].message}"; other person: the fixed line only`;
    });

    // ── 9f. Two tabs, one confirm, one work item ──
    await step('9f: the asker has a second tab with its own runner: one write card confirmed once is run by exactly one runner, makes exactly one work item on the call\'s initiative, and a second claim and a result with a wrong claim are refused', async () => {
      const tab2 = await vera.context.newPage();
      watch(tab2, `${VERA.userId}#2`);
      await tab2.goto(`${PORTAL}${INITIATIVE}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await tab2.getByTestId('initiative-header').waitFor({ timeout: 30000 });
      // A second tab cannot be seated in a call that is already running, so its runner is the app's own turn code (the module the footer's
      // runner uses: processTurns, runCallTool, pollChain) started in that tab with the same endpoints. Tab 1's turn list is held empty
      // while the card is confirmed, so the confirmed turn is claimed and run by tab 2's runner alone.
      const initiativeId = (await stateOf(vera)).initiativeId;
      await tab2.evaluate(async ({ base, initiativeId, userId }) => {
        const [turns, core, tools, palette] = await Promise.all([
          import('/src/lib/meetingTurns.ts'), import('/src/lib/voice/runCore.ts'), import('/src/lib/voice/tools.ts'), import('/src/components/shell/portalCommands.ts'),
        ]);
        const log = { polls: 0, claims: [], ran: [], posted: [] };
        const seen = new turns.SeenTurns('walk-tab2-seen'); const pending = new turns.PendingResults('walk-tab2-pending');
        const ctx = { tenant: 'orgiq', role: 'org-leader', switchable: null, userId, userName: null, ledger: new Map(), results: new tools.ResultMemory(),
          palette: { pages: palette.PAGES, visible: palette.isPageVisible }, can: () => true, fetch: (u, i) => fetch(u, i), navigate: () => undefined, now: () => new Date(),
          page: () => ({ path: location.pathname, record: { ref: `initiative:${initiativeId}`, title: 'the call\'s initiative' }, rows: [] }), tabs: () => null };
        const claim = async (turnId) => {
          const res = await fetch(`${base}/turns/${encodeURIComponent(turnId)}/claim`, { method: 'POST', credentials: 'include', cache: 'no-store' });
          log.claims.push({ turnId, http: res.status });
          return res.status === 404 || res.status === 409 ? { status: 'refused' } : res.ok ? turns.parseClaim(await res.json().catch(() => null)) : { status: 'error' };
        };
        const post = async (turnId, body) => {
          const res = await fetch(`${base}/turns/${encodeURIComponent(turnId)}/result`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          log.posted.push({ turnId, http: res.status }); return res.status;
        };
        const poll = async () => {
          log.polls += 1;
          const res = await fetch(`${base}/turns?mine=1`, { credentials: 'include', cache: 'no-store' });
          if (!res.ok) return false;
          await turns.processTurns(turns.parseTurns(await res.json().catch(() => null)), {
            seen, pending, now: () => Date.now(), claim, post,
            run: async (name, args, write) => { log.ran.push({ name, write }); return core.runCallTool(name, args, ctx, { write }); },
          });
          return true;
        };
        const chain = turns.pollChain({ poll, nextMs: () => 300, schedule: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h) });
        chain.start();
        window.__walkRunner = { log, stop: () => chain.stop() };
      }, { base: `/api/calls/${encodeURIComponent(callId)}/assistant`, initiativeId, userId: VERA.userId });
      const title = 'two tab audit trail';
      const sentBefore = results_.length;
      const holdTab1 = /\/assistant\/turns\?mine=1/;
      await vera.page.route(holdTab1, (route) => route.fulfill({ json: { turns: [] } }));
      try {
        await inject(VERA.userId, `Nova, create a work item for the ${title}.`);
        const card = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.tool?.name === 'create' && m.metadata.summary.includes(title)), 20000, 'the action card');
        const cardOnTab1 = vera.page.getByTestId('assistant-action-card').filter({ hasText: title }).last();
        await cardOnTab1.waitFor({ timeout: 20000 });
        await cardOnTab1.getByTestId('assistant-action-confirm').click(); // confirmed once
        await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.actionId === card.metadata.actionId && m.metadata.status === 'done'), 25000, 'the card going to done');
      } finally { await vera.page.unroute(holdTab1); }
      await sleep(6000); // long enough for tab 1 to have polled again, with its list back
      const made = await itemsTitled(vera, title);
      check(made.length === 1, `${made.length} work items titled "${title}" exist after one confirm`);
      check(made[0].projectId === initiativeId, `the item is on ${made[0].projectId}, not the call's initiative`);
      const mine = results_.slice(sentBefore).filter((r) => r.ok && r.http === 200);
      check(mine.length === 1, `the browsers posted ${mine.length} accepted results for one turn: ${JSON.stringify(mine)}`);
      check(mine[0].by === `${VERA.userId}#2`, `the accepted result came from ${mine[0].by}, not the second tab's runner`);
      const log = await tab2.evaluate(() => window.__walkRunner.log);
      check(log.polls >= 3, `the second tab's runner polled ${log.polls} times`);
      check(log.ran.length === 1 && log.ran[0].write === true, `the second tab's runner ran ${JSON.stringify(log.ran)}, not one write`);
      check(log.claims.length >= 1 && log.claims[0].http === 200, `the second tab's claim answered ${JSON.stringify(log.claims)}`);
      // Another claim of the same turn, and a result without its claim, are refused by the server.
      const turnId = mine[0].turnId;
      const url = `/api/calls/${encodeURIComponent(callId)}/assistant/turns/${encodeURIComponent(turnId)}`;
      const again = await vera.page.evaluate(async (u) => {
        const claim = await fetch(`${u}/claim`, { method: 'POST', credentials: 'include' });
        const result = await fetch(`${u}/result`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claimId: 'abcdef0123456789abcdef01', ok: true, output: {} }) });
        return { claim: claim.status, result: result.status };
      }, url);
      check(again.claim === 409, `a second claim answered ${again.claim}, not 409`);
      check(again.result === 409, `a result with a wrong claim answered ${again.result}, not 409`);
      check((await itemsTitled(vera, title)).length === 1, 'the second claim or result made another work item');
      await tab2.evaluate(() => window.__walkRunner.stop());
      await shot(tab2, '9f-two-tabs-card-done');
      await tab2.close();
      return `one item on ${made[0].projectId}; the second tab's runner ran it once (${log.polls} polls); a second claim 409 and a result with a wrong claim 409`;
    });

    // ── 9g. A write whose record is not named exactly fails on its card, and nothing changes ──
    await step('9g: a card for a write that names its record by position is confirmed, the runner refuses it ("Say the record\'s full name."), and the card reads Failed for both', async () => {
      await inject(VERA.userId, 'Nova, I need a hand with something else.');
      await sleep(1500);
      const before = (await itemsTitled(vera, 'login cookie bug'))[0];
      const res = await fetch(`${MIDDLEWARE}/api/dev/calls/${encodeURIComponent(callId)}/assistant-tool-call`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ askedBy: VERA.userId, name: 'update', args: { ref: '1', fields: { status: 'cancelled' } } }),
      });
      check(res.status === 202, `the dev tool call answered ${res.status}`);
      const card = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.tool?.name === 'update' && m.metadata.status === 'waiting'), 20000, 'the update card');
      const veraCard = vera.page.getByTestId('assistant-action-card').filter({ hasText: card.metadata.summary }).last();
      await veraCard.waitFor({ timeout: 20000 });
      await veraCard.getByTestId('assistant-action-confirm').click();
      const failed = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.actionId === card.metadata.actionId && m.metadata.status === 'failed'), 25000, 'the card going to failed');
      check(/full name/i.test(failed.metadata.resultText ?? ''), `the failed card says "${failed.metadata.resultText}", not the exact-name sentence`);
      await waitFor(async () => /Failed/.test(await nora.page.getByTestId('assistant-action-card').filter({ hasText: card.metadata.summary }).last().getByTestId('assistant-action-status').innerText().catch(() => '')), 15000, 'the other person seeing Failed');
      const after = (await itemsTitled(vera, 'login cookie bug'))[0];
      check(before && after && before.id === after.id, 'the work item is gone or changed');
      check((await myTurns(vera)).length === 0, 'a turn is still waiting');
      await shot(vera.page, '9g-card-failed');
      return `failed for both: "${failed.metadata.resultText}"`;
    });

    // ── 10. A tool call with no name in the asker's recent words is refused ──
    await step('10: a tool call attributed to someone who never said the name is refused, counted and posts nothing', async () => {
      const before = (await stateOf(vera)).refusedCalls ?? 0;
      const messages = (await chatMessages(vera)).length;
      const res = await fetch(`${MIDDLEWARE}/api/dev/calls/${encodeURIComponent(callId)}/assistant-tool-call`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ askedBy: NORA.userId, name: 'search', args: { query: 'canary' } }),
      });
      check(res.status === 202, `the dev tool call answered ${res.status}`);
      await waitFor(async () => ((await stateOf(vera)).refusedCalls ?? 0) > before, 10000, 'the refused-call counter rising');
      await sleep(1500);
      check((await chatMessages(vera)).length === messages, 'a refused call posted something in the chat');
      check((await myTurns(nora)).length === 0, 'a refused call made a turn');
      return `refusedCalls ${before} -> ${(await stateOf(vera)).refusedCalls}`;
    });

    // ── 9e. At most three tool calls per addressed request ──
    await step('9e: the fourth tool call inside one addressed request is refused ("too many steps") and counted; the first three ran', async () => {
      await inject(VERA.userId, 'Nova, I need a hand with something.');
      await sleep(1500);
      const before = (await stateOf(vera)).refusedCalls ?? 0;
      for (const n of [1, 2, 3, 4]) {
        const res = await fetch(`${MIDDLEWARE}/api/dev/calls/${encodeURIComponent(callId)}/assistant-tool-call`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ askedBy: VERA.userId, name: 'search', args: { query: `chain ${n}` } }),
        });
        check(res.status === 202, `dev tool call ${n} answered ${res.status}`);
        await sleep(300);
      }
      await waitFor(async () => ((await stateOf(vera)).refusedCalls ?? 0) > before, 15000, 'the fourth call being refused');
      await sleep(2500);
      const after = (await stateOf(vera)).refusedCalls ?? 0;
      check(after === before + 1, `refusedCalls went ${before} -> ${after}, not by exactly one`);
      check((await myTurns(vera)).length === 0, 'a turn is still waiting');
      return `refusedCalls ${before} -> ${after} after four chained calls`;
    });

    // ── 7. The bar at both widths with Nova's controls present ──
    await step('7: with Nova listening and its controls present the call bar and Nova controls neither scroll sideways nor clip at 1440 and 1280, and the footer keeps its height', async () => {
      const out = [];
      for (const p of [vera, nora]) for (const width of [1440, 1280]) {
        const m = await barFits(p.page, `${p.who.userId}'s bar`, width);
        out.push(`${p.who.userId}@${width}: dock ${m.barHeight}px, Nova ${m.novaWidth}px`);
      }
      // Nova must not make the bar taller: the dock measures the same with Nova's controls taken out of the layout.
      for (const p of [vera, nora]) for (const width of [1440, 1280]) {
        await p.page.setViewportSize({ width, height: 900 });
        await sleep(600);
        const [withNova, without] = await p.page.evaluate(async () => {
          const row = document.querySelector('[data-testid="shell-footer-row"]');
          const nova = document.querySelector('[data-testid="nova-bar"]');
          const a = row.getBoundingClientRect().height;
          nova.style.display = 'none';
          await new Promise((r) => setTimeout(r, 300));
          const b = row.getBoundingClientRect().height;
          nova.style.display = '';
          return [Math.round(a), Math.round(b)];
        });
        check(withNova <= without + 1, `${p.who.userId}@${width}: Nova's controls grow the footer row from ${without}px to ${withNova}px`);
        out.push(`${p.who.userId}@${width}: ${withNova}px with Nova, ${without}px without`);
      }
      return out.join('; ');
    });

    // ── 7b. Nova's voice (package 7b): off by default, on by an inviter, played in both browsers, muted per person ──
    // The page counts what it scheduled in data-voice-* attributes on the mark; headless sound is not asserted.
    const voiceOf = async (p) => {
      const a = await p.page.getByTestId('nova-mark').first().evaluate((el) => ({
        on: el.getAttribute('data-voice') === 'true', muted: el.getAttribute('data-voice-muted') === 'true',
        frames: Number(el.getAttribute('data-voice-frames')), ignored: Number(el.getAttribute('data-voice-ignored')), lastSeq: Number(el.getAttribute('data-voice-last-seq')),
      }));
      return a;
    };
    const watchSpeaking = (p) => p.page.evaluate(() => {
      const el = document.querySelector('[data-testid="nova-mark"]');
      window.__novaSeen = { speaking: false, listeningAfter: false };
      new MutationObserver(() => {
        const t = (el.innerText || '').trim();
        if (/Nova is speaking/.test(t)) window.__novaSeen.speaking = true;
        else if (window.__novaSeen.speaking && /Nova is listening/.test(t)) window.__novaSeen.listeningAfter = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const ask = async () => { await inject(VERA.userId, 'Nova, what is two plus two?'); };
    const voiceWords = async (p) => (await (await p.api.get(asApi(p, 'state'))).json());

    await step('7b-a: voice is off by default: after a spoken request the asker\'s page scheduled no frames and the server relayed none', async () => {
      const before = await voiceOf(vera);
      check(before.on === false, 'voice reads on before anyone turned it on');
      await ask();
      await sleep(4000);
      const after = await voiceOf(vera);
      check(after.frames === 0, `${after.frames} frames played with voice off`);
      const st = await voiceWords(vera);
      check(st.voice === false && (st.voiceFramesRelayed ?? 0) === 0, `state: voice=${st.voice} relayed=${st.voiceFramesRelayed}`);
      return 'no frames with voice off';
    });

    await step('7b-b: the inviter turns the voice on: both see the notice in the chat and the mark says so', async () => {
      await novaMenu(vera, "Turn Nova's voice on");
      for (const p of [vera, nora]) {
        await waitFor(async () => (await voiceOf(p)).on, 15000, `${p.who.userId} seeing voice on`);
        await waitFor(async () => /turned Nova's voice on/.test(await bodyText(p.page)), 15000, `${p.who.userId} seeing the notice`);
        const label = await p.page.getByTestId('nova-mark').first().getAttribute('aria-label');
        check(/Nova's voice is on/.test(label ?? ''), `the mark does not say voice is on: "${label}"`);
      }
      await vera.page.getByTestId('nova-mark').click();
      check(await vera.page.getByRole('menuitem', { name: "Turn Nova's voice off" }).isVisible(), 'no "Turn Nova\'s voice off" item');
      check(await vera.page.getByRole('menuitem', { name: 'Mute Nova for me' }).isVisible(), 'no "Mute Nova for me" item');
      await shot(vera.page, '7b-voice-menu');
      await vera.page.keyboard.press('Escape');
      return 'voice on: notice and mark in both pages';
    });

    await step('7b-c: a spoken request: both pages schedule frames with increasing seq, the mark reads "Nova is speaking" and goes back to listening', async () => {
      await watchSpeaking(vera); await watchSpeaking(nora);
      const v0 = await voiceOf(vera); const n0 = await voiceOf(nora);
      await ask();
      for (const [p, b] of [[vera, v0], [nora, n0]]) {
        await waitFor(async () => (await voiceOf(p)).frames > b.frames, 20000, `${p.who.userId} scheduling frames`);
      }
      await sleep(2500);
      for (const [p, b] of [[vera, v0], [nora, n0]]) {
        const a = await voiceOf(p);
        check(a.frames - b.frames >= 5, `${p.who.userId} scheduled only ${a.frames - b.frames} frames`);
        check(a.lastSeq > b.lastSeq, `${p.who.userId}: seq did not rise (${b.lastSeq} -> ${a.lastSeq})`);
        const seen = await p.page.evaluate(() => window.__novaSeen);
        check(seen.speaking, `${p.who.userId}: the mark never read "Nova is speaking"`);
        check(seen.listeningAfter, `${p.who.userId}: the mark did not return to "Nova is listening"`);
        await waitMark(p.page, /^Nova is listening$/);
      }
      return `frames in both pages, seq ${(await voiceOf(vera)).lastSeq}`;
    });

    await step('7b-c2: while frames play the mark reads "Nova is speaking" (screenshot)', async () => {
      const v0 = await voiceOf(vera);
      await ask();
      await waitMark(vera.page, /^Nova is speaking$/, 20000);
      // At once: the mark holds "speaking" only 400 ms after the last frame, so `shot`'s settle delay would miss it.
      await vera.page.screenshot({ path: path.join(SHOTS, '7b-speaking-1280.png') });
      await waitFor(async () => (await voiceOf(vera)).frames > v0.frames, 5000, 'frames');
      await waitMark(vera.page, /^Nova is listening$/);
      return 'speaking mark captured';
    });

    await step('7b-d: the second person mutes Nova: on the next request their page plays nothing and the asker\'s still does; unmute brings it back', async () => {
      await novaMenu(nora, 'Mute Nova for me');
      await waitFor(async () => (await voiceOf(nora)).muted, 5000, 'the mute');
      const v0 = await voiceOf(vera); const n0 = await voiceOf(nora);
      await ask();
      await waitFor(async () => (await voiceOf(vera)).frames > v0.frames, 20000, 'the asker\'s frames');
      await sleep(3000);
      check((await voiceOf(nora)).frames === n0.frames, 'a muted page scheduled frames');
      await novaMenu(nora, 'Unmute Nova for me');
      await waitFor(async () => !(await voiceOf(nora)).muted, 5000, 'the unmute');
      const n1 = await voiceOf(nora); const v1 = await voiceOf(vera);
      await sleep(1500);
      await ask();
      await waitFor(async () => (await voiceOf(nora)).frames > n1.frames, 20000, 'frames after unmute');
      check((await voiceOf(vera)).frames > v1.frames, 'the asker stopped hearing Nova');
      return 'muted page silent, others unaffected, unmute restores';
    });

    await step('7b-e: paused: a request plays nothing on either page; resume brings it back', async () => {
      await sleep(2500);
      await novaMenu(vera, 'Pause Nova');
      await waitMark(vera.page, /^Nova is paused$/); await waitMark(nora.page, /^Nova is paused$/);
      const v0 = await voiceOf(vera); const n0 = await voiceOf(nora);
      await ask();
      await sleep(4000);
      check((await voiceOf(vera)).frames === v0.frames && (await voiceOf(nora)).frames === n0.frames, 'frames were scheduled while Nova was paused');
      await novaMenu(vera, 'Resume Nova');
      await waitMark(vera.page, /^Nova is listening$/); await waitMark(nora.page, /^Nova is listening$/);
      return 'nothing scheduled while paused';
    });

    await step('7b-f: voice off: a request plays nothing and both pages say so', async () => {
      await novaMenu(vera, "Turn Nova's voice off");
      for (const p of [vera, nora]) await waitFor(async () => !(await voiceOf(p)).on, 15000, `${p.who.userId} seeing voice off`);
      await sleep(1500);
      const v0 = await voiceOf(vera); const n0 = await voiceOf(nora);
      await ask();
      await sleep(4000);
      check((await voiceOf(vera)).frames === v0.frames && (await voiceOf(nora)).frames === n0.frames, 'frames were scheduled with voice off');
      await barFits(vera.page, 'the bar with the voice items', 1280);
      return 'nothing scheduled with voice off';
    });

    // ── 6. Dismiss ──
    let expiryCard = null;
    await step('6a: a write card nobody confirms stays waiting for both people', async () => {
      await inject(VERA.userId, 'Nova, create a work item for the expiry audit.');
      expiryCard = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.tool?.name === 'create' && m.metadata.summary.includes('expiry audit')), 20000, 'the card');
      check(expiryCard.metadata.status === 'waiting', `the card is ${expiryCard.metadata.status}`);
      for (const p of [vera, nora]) await p.page.getByTestId('assistant-action-card').filter({ hasText: 'expiry audit' }).last().waitFor({ timeout: 20000 });
      return 'waiting for both';
    });

    await step('6: dismiss: the mark goes, Invite does not return, the bar says "Nova has left this call", re-invite is refused', async () => {
      await novaMenu(nora, 'Dismiss Nova');
      await seen(nora.page, 'nova-left');
      await seen(vera.page, 'nova-left');
      for (const p of [vera, nora]) {
        check(/Nova has left this call/.test(await p.page.getByTestId('nova-left').innerText()), 'the left state is not in words');
        check(await p.page.getByTestId('nova-mark').count() === 0, 'the listening mark stayed');
        check(await p.page.getByTestId('nova-invite').count() === 0, 'Invite Nova came back');
        check(await p.page.getByTestId('nova-menu').count() === 0, 'Nova controls stayed');
      }
      const again = await vera.api.post(`${PORTAL}/api/calls/${encodeURIComponent(callId)}/assistant/invite`, { data: {} });
      check(again.status() === 409, `a re-invite answered ${again.status()}, not 409`);
      check(await vera.page.getByTestId('nova-roster-entry').count() === 0, 'Nova stayed in the roster');
      await barFits(vera.page, 'the bar after dismissal', 1280);
      await shot(vera.page, '6-left');
      return 'left; re-invite 409';
    });

    await step('6b: with Nova dismissed the unconfirmed card reads Expired for both, says nobody confirmed it in time, and nothing was created', async () => {
      const expired = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.actionId === expiryCard.metadata.actionId && m.metadata.status === 'expired'), 20000, 'the card going to expired');
      check(/did not confirm this in time/.test(expired.metadata.resultText ?? ''), `the expired card says "${expired.metadata.resultText}"`);
      for (const p of [vera, nora]) {
        const card = p.page.getByTestId('assistant-action-card').filter({ hasText: 'expiry audit' }).last();
        await waitFor(async () => /Expired/.test(await card.getByTestId('assistant-action-status').innerText().catch(() => '')), 15000, `${p.who.userId} seeing Expired`);
        check(await card.getByTestId('assistant-action-confirm').count() === 0, `${p.who.userId} still has Confirm on an expired card`);
      }
      check((await itemsTitled(vera, 'expiry audit')).length === 0, 'an expired card created the work item');
      await shot(vera.page, '6b-card-expired');
      return `expired for both: "${expired.metadata.resultText}"`;
    });

    // ── 11. The inviter's spend ──
    await step('11: after the dismissal the inviter\'s spend has a meeting_assistant entry, and the state shows the listening time', async () => {
      const entry = await waitFor(async () => {
        const spend = await (await vera.api.get(`${PORTAL}/api/me/spend?period=month`)).json();
        return spend.byInitiative?.find((r) => r.bySource && 'meeting_assistant' in r.bySource);
      }, 15000, 'a meeting_assistant ledger entry for the inviter');
      const st = await stateOf(vera);
      check(st.state === 'left' && st.listeningSeconds > 0, `the state after leaving: ${JSON.stringify({ state: st.state, listeningSeconds: st.listeningSeconds })}`);
      check(st.ceilingSeconds >= 60, `the state has no ceiling: ${st.ceilingSeconds}`);
      return `entry ${JSON.stringify(entry.bySource)}; listened ${st.listeningSeconds} s of ${st.ceilingSeconds} s`;
    });
    // ── Package 5: the minutes (steps 12 to 17 run after the dismissal; the scripted writer, no model) ──
    const MEETING = () => `${PORTAL}/iq/meetings/${encodeURIComponent(callId)}`;
    const LAYLA = { userId: 'u-layla', role: 'sme' };
    /** A person who was not in the call: logged in, no call, no initiative page needed. */
    const outsider = async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      contexts.push(context);
      const login = await context.request.post(`${PORTAL}/api/session/login`, { data: { userId: LAYLA.userId } });
      check(login.status() === 200, `login ${LAYLA.userId}: ${login.status()}`);
      const role = await context.request.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: LAYLA.role } });
      check(role.status() === 200, `role ${LAYLA.role}: ${role.status()}`);
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(`${LAYLA.userId}: ${e.message}`));
      return { who: LAYLA, context, page, api: context.request };
    };
    /** No sideways scroll and no element running past the right edge of the page. */
    const fitsWidth = async (page, label, width) => {
      await page.setViewportSize({ width, height: 900 });
      await sleep(600);
      const out = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
      check(out.over <= 1, `${label} scrolls sideways at ${width} by ${out.over}px`);
    };
    let layla;

    await step('12: after the dismissal Nova leaves one message in the call chat: the summary and the decision and action item counts, no path in its sentence, and a link element "Open the meeting page" that goes to the meeting page', async () => {
      const msg = await waitFor(async () => (await chatMessages(vera)).find((m) => /Nova's minutes/.test(m.message ?? '')), 20000, 'the minutes message in the call chat');
      check(msg.userId === 'agent:nova' || msg.metadata?.assistant === true, 'the minutes message is not Nova\'s');
      check(/\d+ decisions? and \d+ action items?/.test(msg.message), `no counts in "${msg.message}"`);
      check(!msg.message.includes('/iq/meetings'), `the sentence still carries a path: "${msg.message}"`);
      check(msg.metadata?.meetingCallId === callId, `the message carries meetingCallId ${msg.metadata?.meetingCallId}, not ${callId}`);
      check(/ said: /.test(msg.message), `no summary in "${msg.message}"`);
      const all = (await chatMessages(vera)).filter((m) => /Nova's minutes/.test(m.message ?? ''));
      check(all.length === 1, `${all.length} minutes messages were posted`);
      const expected = `/iq/meetings/${encodeURIComponent(callId)}`;
      const link = vera.page.getByTestId('assistant-notice-meeting-link').last();
      await link.waitFor({ state: 'visible', timeout: 20000 }).catch(() => { throw new StepFailure('the chat shows no meeting link under the closing notice'); });
      check(await link.evaluate((el) => el.tagName) === 'A', 'the meeting link is not an anchor');
      check((await link.getAttribute('href')) === expected, `the link goes to ${await link.getAttribute('href')}, not ${expected}`);
      check(/^Open the meeting page$/.test((await link.innerText()).trim()), `the link reads "${await link.innerText()}"`);
      check(await vera.page.getByTestId('assistant-notice-meeting-link').count() === 1, 'more than one meeting link in the chat');
      await link.click();
      await vera.page.waitForURL((u) => u.pathname === expected, { timeout: 20000 }).catch(() => { throw new StepFailure(`clicking the link did not open ${expected}: ${vera.page.url()}`); });
      await seen(vera.page, 'meeting-page', 30000);
      await vera.page.goBack({ waitUntil: 'domcontentloaded' });
      await vera.page.getByTestId('shell-footer-row').waitFor({ timeout: 30000 });
      return `"${msg.message.slice(0, 200)}"; link ${expected}`;
    });

    // The minutes steps read in a fresh tab of each person, so the first tabs stay in the call until step 18.
    const veraM = { page: await vera.context.newPage() }; const noraM = { page: await nora.context.newPage() };
    watch(veraM.page, 'vera#m'); watch(noraM.page, 'nora#m');
    await step('13: the meeting page renders for an attendee at 1440 and 1280 with the summary, the action item for the work item made in the call (by its title) and the transcript with speaker names', async () => {
      await veraM.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(veraM.page, 'meeting-page', 30000);
      await seen(veraM.page, 'meeting-summary');
      await seen(veraM.page, 'meeting-action-items');
      const out = [];
      for (const width of [1440, 1280]) {
        await fitsWidth(veraM.page, 'the meeting page', width);
        const text = await bodyText(veraM.page);
        check(/Nova invited by /.test(text), 'the header does not say who invited Nova');
        check(/summary/i.test(text) && /decisions/i.test(text) && /action items/i.test(text) && /transcript/i.test(text), `a section is missing at ${width}: ${text.slice(0, 300)}`);
        const summary = (await veraM.page.getByTestId('meeting-summary').innerText()).trim();
        check(summary.length > 10, 'the summary is empty');
        const items = (await veraM.page.getByTestId('meeting-action-items').innerText()).replace(/\s+/g, ' ');
        check(/login cookie bug/i.test(items), `the action items do not hold the work item created in the call (by its title): "${items}"`);
        check((await itemsTitled(vera, 'login cookie bug')).length === 1, 'the work item the action item names does not exist exactly once');
        // Speaker names, not ids: the transcript lines were injected for u-nora and u-vera.
        check(/Nora/.test(text), 'Nora is not named in the transcript');
        check(!/\bu-nora\b|\bu-vera\b/.test(text), 'a raw user id shows on the page');
        check(text.includes('After resume: kept again.'), 'a transcript line is missing');
        out.push(`${width}: ok`);
      }
      await veraM.page.setViewportSize({ width: 1280, height: 900 });
      await veraM.page.evaluate(() => window.scrollTo(0, 0));
      await sleep(400);
      await veraM.page.screenshot({ path: path.join(SHOTS, '13-meeting-page-1280.png'), fullPage: false });
      return out.join(', ');
    });

    await step('14: a person who was not in the call gets a not-found page and a 404 from both API routes', async () => {
      layla = await outsider();
      const min = await layla.api.get(asApi(layla, 'minutes'));
      const tr = await layla.api.get(asApi(layla, 'transcript'));
      check(min.status() === 404, `minutes answered ${min.status()} to an outsider`);
      check(tr.status() === 404, `transcript answered ${tr.status()} to an outsider`);
      check(!/login cookie|canary|resume/i.test(await min.text() + await tr.text()), 'the 404 body carries meeting words');
      await layla.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(layla.page, 'meeting-not-found', 30000);
      const text = await bodyText(layla.page);
      check(!/login cookie|canary|rollout|resumes/i.test(text), 'the not-found page shows meeting words');
      return 'API 404 x2; "Meeting not found" page';
    });

    await step('15: the Meetings list shows the meeting to an attendee (the row found by its own title), table first, and not to the outsider', async () => {
      await veraM.page.goto(`${PORTAL}/iq/meetings`, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(veraM.page, 'iq-meetings-table', 30000);
      const listed = await (await vera.api.get(`${PORTAL}/api/meetings`)).json();
      const own = listed.meetings.find((m) => m.callId === callId);
      check(own && typeof own.callName === 'string' && own.callName.length > 0, `the API list has no title for this call: ${JSON.stringify(listed).slice(0, 200)}`);
      const row = veraM.page.getByTestId('iq-meetings-table').getByText(own.callName, { exact: true }).first();
      await row.waitFor({ state: 'visible', timeout: 15000 }).catch(() => { throw new StepFailure('the meeting is not in the list'); });
      for (const width of [1440, 1280]) {
        await fitsWidth(veraM.page, 'the Meetings list', width);
        const top = await row.evaluate((el) => el.getBoundingClientRect().top).catch(() => null);
        check(top !== null && top < 600, `the first row starts at ${top}px: the table is not above the fold at ${width}`);
      }
      const text = await bodyText(veraM.page);
      check(/Nora/.test(text), 'the list does not name the people');
      await veraM.page.setViewportSize({ width: 1280, height: 900 });
      await sleep(400);
      await veraM.page.screenshot({ path: path.join(SHOTS, '15-meetings-list-1280.png'), fullPage: false });
      const mine = await (await vera.api.get(`${PORTAL}/api/meetings`)).json();
      check(mine.meetings.some((m) => m.callId === callId && m.actionItemCount >= 1), `the API list lacks the meeting: ${JSON.stringify(mine).slice(0, 200)}`);
      const theirs = await (await layla.api.get(`${PORTAL}/api/meetings`)).json();
      check(Array.isArray(theirs.meetings) && theirs.meetings.length === 0, `the outsider's list is ${JSON.stringify(theirs).slice(0, 200)}`);
      await layla.page.goto(`${PORTAL}/iq/meetings`, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(layla.page, 'iq-meetings-table', 30000);
      check(!/ said: /.test(await layla.page.getByTestId('iq-meetings-table').innerText()), 'the outsider\'s table shows a meeting');
      return `attendee: ${mine.meetings.length} meeting(s); outsider: none`;
    });

    await step('16: a ledger entry for the minutes exists, booked to the inviter (source id ending :minutes)', async () => {
      const res = await vera.api.get(`${PORTAL}/api/spend/entries?groupBy=source&key=meeting_assistant&period=month&limit=50`);
      check(res.status() === 200, `the spend entries answered ${res.status()}`);
      const body = await res.json();
      const ids = (body.entries ?? []).map((e) => e.sourceId);
      check(ids.some((id) => id === `ma:${callId}:minutes`), `no :minutes entry among ${JSON.stringify(ids)}`);
      return `entries ${JSON.stringify(ids)}`;
    });

    await step('17: only the inviter sees Delete; deleting (after the confirm step) makes the page and the transcript route 404 for everyone', async () => {
      await noraM.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(noraM.page, 'meeting-page', 30000);
      check(await noraM.page.getByTestId('meeting-delete').count() === 0, 'a person who did not invite Nova is offered Delete');
      const refused = await nora.api.delete(asApi(nora, 'minutes'));
      check(refused.status() === 403, `a non-inviter deleting answered ${refused.status()}`);
      await veraM.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(veraM.page, 'meeting-delete', 30000);
      await veraM.page.getByTestId('meeting-delete').click();
      await shot(veraM.page, '17-delete-prompt');
      await veraM.page.getByRole('button', { name: /Delete the record/ }).click();
      await veraM.page.waitForURL(/\/iq\/meetings$/, { timeout: 20000 }).catch(() => { throw new StepFailure('deleting did not return to the Meetings list'); });
      for (const p of [vera, nora]) {
        const a = await p.api.get(asApi(p, 'minutes')); const b = await p.api.get(asApi(p, 'transcript'));
        check(a.status() === 404 && b.status() === 404, `${p.who.userId}: minutes ${a.status()}, transcript ${b.status()} after the delete`);
      }
      await veraM.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(veraM.page, 'meeting-not-found', 30000);
      const list = await (await vera.api.get(`${PORTAL}/api/meetings`)).json();
      check(!list.meetings.some((m) => m.callId === callId), 'the deleted meeting is still listed');
      return 'non-inviter: no button, 403; inviter: confirm, then 404 on the page and both routes, gone from the list';
    });
    await step('17b: after the delete every message Nova left in the call chat is the one fixed line: no words of the meeting, no card detail, no link to the page', async () => {
      const nova = (await chatMessages(vera)).filter((m) => m.userId === 'agent:nova' || m.metadata?.assistant === true);
      check(nova.length >= 3, `only ${nova.length} Nova messages remain in the chat`);
      const lines = new Set(nova.map((m) => m.message));
      check(lines.size === 1, `Nova's messages read ${JSON.stringify([...lines]).slice(0, 300)}, not one fixed line`);
      const blob = JSON.stringify(nova);
      for (const word of ['login cookie bug', 'two tab audit', 'expiry audit', 'nightly export', 'meetingCallId']) check(!blob.toLowerCase().includes(word.toLowerCase()), `"${word}" is still in Nova's messages`);
      for (const card of nova.filter((m) => m.metadata?.kind === 'assistant-action')) {
        check(card.metadata.detail === undefined && card.metadata.resultText === undefined, 'a card kept its detail or result');
      }
      await sleep(3500); // the page's own refresh
      check(await vera.page.getByTestId('assistant-notice-meeting-link').count() === 0, 'the chat still shows a link to the deleted meeting page');
      return `${nova.length} messages, all "${[...lines][0]}"`;
    });
    // ── 18. Both people leave; the footer renders on; no page error in the whole walk ──
    await step('18: both people leave the call: the footer still renders with the call gone, and no page error happened in the whole walk', async () => {
      const ended = [];
      // (When the first person leaves a two-person call the call can end for the second, whose button then reads Dismiss.)
      for (const p of [vera, nora]) {
        const leave = p.page.getByRole('button', { name: /^(Leave|Dismiss)$/ });
        const present = await leave.waitFor({ timeout: p === vera ? 20000 : 4000 }).then(() => true, () => false);
        if (!present && p === vera) throw new StepFailure(`${p.who.userId}: no Leave button on the page`);
        if (present) await leave.click(); else ended.push(p.who.userId);
        await p.page.getByRole('button', { name: 'Leave', exact: true }).waitFor({ state: 'detached', timeout: 20000 }).catch(() => { throw new StepFailure(`${p.who.userId}: the page still shows Leave after leaving`); });
        await sleep(2500); // long enough for a state poll to run with the call gone
        check(await p.page.getByTestId('shell-footer-row').isVisible(), `${p.who.userId}: the footer row is gone after leaving`);
        check(await p.page.getByTestId('nova-bar').count() === 0, `${p.who.userId}: Nova's controls are still drawn after leaving`);
        await shot(p.page, `18-after-leave-${p.who.userId}`);
      }
      check(allErrors.length === 0, `page errors in the walk: ${allErrors.join(' | ')}`);
      return `both are out of the call${ended.length ? ` (the call had already ended for ${ended.join(', ')})` : ''}; footer row present; zero page errors`;
    });
  } finally {
    for (const p of [vera, nora]) {
      const leave = p?.page.getByTestId('shell-call-dock').getByRole('button', { name: /Leave|Hang up/ }).first();
      if (leave && await leave.isVisible().catch(() => false)) await leave.click().catch(() => undefined);
    }
    for (const c of contexts) await c.close().catch(() => undefined);
    await browser.close();
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'meeting-assistant.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  const fails = results.filter((x) => !x.ok).length;
  console.log(`meeting-assistant: ${results.length - fails}/${results.length} passed; fails=${fails}; screenshots in ${SHOTS}`);
  return fails === 0 ? 0 : 1;
}

process.exit(await main());
