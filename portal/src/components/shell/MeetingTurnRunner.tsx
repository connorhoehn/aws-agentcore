// Runs the call assistant's turns in this person's own browser (docs/meeting-assistant-design.md, decision 5).
// Renders nothing. While this person is seated in a call with Nova (listening, paused, or after it left, on a confirmation), it asks the server for the turns made for
// this person every TURN_POLL_MS (the 5 s state poll is too slow for a read that someone is waiting on) and runs each
// one once through the voice navigator's executor with this person's own session. See lib/meetingTurns.ts for the
// rules: reads when pending, writes only when running, never twice.

import { useEffect, useMemo, useRef } from 'react';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { useMeetingAssistant } from '../../lib/meetingAssistant';
import { ownMediaId, reportMediaId } from '../../lib/meetingParticipant';
import { useCallHost } from '../../lib/conversationCall';
import { onTurnsPoke } from '../../lib/meetingTurnsPoke';
import { PendingResults, SeenTurns, flushResults, parseClaim, parseTurns, pollChain, processTurns, turnPollBaseMs, EXECUTOR_REQUEST_MS, TURN_POLL_MS, type ClaimResult } from '../../lib/meetingTurns';
import { runCallTool } from '../../lib/voice/runCore';
import { useFetch } from '../../hooks/useFetch';
import { ResultMemory, type DeliveryRecord, type ToolContext } from '../../lib/voice/tools';
import { PAGES, isPageVisible } from './portalCommands';
import { useLiveCallId } from './MeetingAssistantBar';

export { TURN_POLL_MS };
/** After Nova has left, a confirmed card is followed by these extra polls (ms after the poke). */
const POKE_FOLLOW_UPS_MS = [1500, 4000, 9000];
/** An error doubles the wait, up to this. */
const POLL_MAX_MS = 30_000;
export const pollDelay = (base: number, failures: number): number => Math.min(base * 2 ** Math.min(failures, 10), POLL_MAX_MS);

export function MeetingTurnRunner() {
  const callId = useLiveCallId();
  const nova = useMeetingAssistant(callId);
  const { session } = useSession();
  const { can } = useCapabilities();
  // Seated in the live call (callId) is the first condition. Confirmed turns run whenever the person is seated: keep asking
  // while Nova listens or is paused; after it has left, ask when a card is confirmed (a poke) and a few times after.
  const phase = nova.view.phase;
  const mode: 'active' | 'poke' | 'off' = !nova.enabled ? 'off' : phase === 'listening' || phase === 'invited' || phase === 'paused' ? 'active' : phase === 'left' ? 'poke' : 'off';
  const userId = session?.sub ?? null;
  const ledger = useMemo(() => new Map<string, DeliveryRecord>(), [userId]);
  const results = useMemo(() => new ResultMemory(), [userId, session?.tenant]);
  const host = useCallHost();
  const mediaId = ownMediaId(host?.call?.call?.participants as Parameters<typeof ownMediaId>[0], userId);
  // M7: once an assistant record exists for this call and Nova has not left, tell the server this person's media id (again if it changes after a rejoin).
  const present = nova.enabled && (nova.view.phase === 'invited' || nova.view.phase === 'listening' || nova.view.phase === 'paused');
  useEffect(() => {
    if (!present || !callId || !mediaId) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = (): void => { void reportMediaId(callId, mediaId).then((done) => { if (!done && !stopped) timer = setTimeout(send, 5000); }); };
    send();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [present, callId, mediaId]);
  const callInitiative = useRef<{ id: string; name: string | null } | null>(null);
  const initiativeId = nova.view.initiativeId;
  const initiativeName = useFetch<{ name?: string }>(initiativeId ? `/api/graph/projects/${encodeURIComponent(initiativeId)}` : null).data?.name ?? null;
  callInitiative.current = initiativeId ? { id: initiativeId, name: initiativeName } : null;
  const live = useRef({ session, can });
  live.current = { session, can };

  useEffect(() => {
    if (mode === 'off' || !callId || !userId) return undefined;
    const seen = new SeenTurns(`nova-turns:${callId}:${userId}`);
    const pending = new PendingResults(`nova-results:${callId}:${userId}`);
    // The server's clock, from the `Date` header of its answers: a turn's expiry is the server's time, not this browser's.
    let offset = 0;
    const serverNow = (): number => Date.now() + offset;
    const learn = (res: Response): void => {
      const at = Date.parse(res.headers.get('date') ?? '');
      if (Number.isFinite(at)) offset = at - Date.now();
    };
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Every request this runner makes ends within EXECUTOR_REQUEST_MS, so one hung request cannot hold the runner.
    const limited = (own?: AbortSignal | null): AbortSignal => (own ? AbortSignal.any([own, AbortSignal.timeout(EXECUTOR_REQUEST_MS)]) : AbortSignal.timeout(EXECUTOR_REQUEST_MS));
    const claim = async (turnId: string): Promise<ClaimResult> => {
      try {
        const res = await fetch(`${base}/turns/${encodeURIComponent(turnId)}/claim`, { method: 'POST', credentials: 'include', cache: 'no-store', signal: limited() });
        learn(res);
        if (res.status === 404 || res.status === 409) return { status: 'refused' };
        return res.ok ? parseClaim(await res.json().catch(() => null)) : { status: 'error' };
      } catch { return { status: 'error' }; }
    };
    const post = async (turnId: string, body: { claimId: string; ok: boolean; output?: unknown; error?: string }): Promise<number> => {
      const res = await fetch(`${base}/turns/${encodeURIComponent(turnId)}/result`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: limited(),
      });
      learn(res);
      return res.status;
    };
    const flush = async (): Promise<void> => {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      const next = await flushResults({ pending, now: serverNow, post });
      if (next !== null && !stopped) retryTimer = setTimeout(() => void flush(), Math.max(0, next - Date.now()));
    };
    const base = `/api/calls/${encodeURIComponent(callId)}/assistant`;
    let stopped = false;
    let busy = false;
    // A tool context for this person only. It cannot navigate (a call is not the place to move their page).
    const context = (): ToolContext => {
      const s = live.current.session;
      return {
        tenant: s?.tenant ?? 'orgiq', role: s?.role ?? 'member', switchable: s?.switchable?.[s.tenant] ?? null, userId, userName: s?.name ?? null,
        ledger, results, palette: { pages: PAGES, visible: isPageVisible },
        can: live.current.can, fetch: (url, init) => fetch(url, { ...init, signal: limited(init?.signal) }), navigate: () => undefined, now: () => new Date(),
        // The call's initiative stands in for "the page in view": a work item made from a card lands on the CALL's initiative, never on
        // whatever page this person is looking at. With none, the tools fail with their own "name the initiative" sentence.
        page: () => { const c = callInitiative.current; return c ? { path: window.location.pathname, record: { ref: `initiative:${c.id}`, title: c.name ?? 'the call\'s initiative' }, rows: [] } : null; },
        tabs: () => null,
      };
    };
    // Resolves true when the server answered (even with nothing to run), false on an error, so the loop can back off.
    const poll = async (): Promise<boolean> => {
      if (busy || stopped) return true;
      busy = true;
      try {
        const res = await fetch(`${base}/turns?mine=1`, { credentials: 'include', cache: 'no-store', signal: limited() });
        learn(res);
        if (!res.ok || stopped) return res.ok;
        await processTurns(parseTurns(await res.json().catch(() => null)), {
          seen, pending, now: serverNow, claim,
          run: (name, args, write) => runCallTool(name, args, context(), { write }),
          post,
        });
        if (pending.size > 0 && !retryTimer) void flush();
        return true;
      } catch { return false; } finally { busy = false; }
    };
    const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const followUps: ReturnType<typeof setTimeout>[] = [];
    // While Nova is listening or paused the browser keeps asking; after it has left it asks only when a card is confirmed.
    // A hidden tab still polls (slower): its reads and confirmed writes must not wait.
    const chain = pollChain<ReturnType<typeof setTimeout>>({
      poll, schedule: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h),
      nextMs: (failures) => { const every = turnPollBaseMs(mode, hidden()); return every === null ? null : pollDelay(every, failures); },
    });
    void flush(); // a result kept from before a reload is posted again, not run again
    chain.start();
    const onVisible = (): void => chain.nudge();
    const off = onTurnsPoke(callId, () => {
      void poll();
      if (mode === 'poke') for (const ms of POKE_FOLLOW_UPS_MS) followUps.push(setTimeout(() => void poll(), ms));
    });
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true; chain.stop(); for (const t of followUps) clearTimeout(t);
      if (retryTimer) clearTimeout(retryTimer); off(); document.removeEventListener('visibilitychange', onVisible);
    };
  }, [mode, callId, userId, ledger, results]);
  return null;
}
