// The request detector (docs/meeting-assistant-design.md, decision 4). Pure state machine: attributed
// caption lines go in, request / cancel / command events come out. No I/O, no timers; time is the
// injected `clock`, and `tick()` is how a quiet speaker's request gets closed.
//
// What the rules are for. The captions service cuts a window after 3 s of audio or 0.6 s of
// silence, so one spoken request arrives as several captions, sometimes with a word cut in half and
// with junk slivers ("Thank you.") between. The detector rebuilds the request for ONE speaker.
//
//   Name.    "Nova" as a whole word, any case, punctuation around it, "Nova's" tolerated.
//   Address. A caption is a request only if the name is *addressing* the assistant:
//     A. the name starts the caption or a sentence, or only greeting words precede it
//        ("Hey Nova", "Okay, Nova", "...logic. Nova, please."); or
//     B. mid-sentence, it is followed by a comma / colon / dash ("so, Nova, can you"), or by
//        "please", an imperative verb ("Nova write up ..."), a question word, or "can/could/would/will you".
//     So "I think Nova could help with that budget question" is NOT a request (mid-sentence, "could"
//     not followed by "you"), but "I think Nova, could you help" and "Nova could help with budget" are.
//   C. the name is the last word of the caption (unless it follows thanks / bye): the request starts next caption.
//   Text before the name is dropped. If nothing follows the name ("...Nova.") the request is opened
//   empty and starts with the same speaker's next caption.
//   Stitching. The same speaker's following captions join the request. It closes when the speaker has been
//     quiet for 1.5 s since their last caption arrived; the wait stretches to 4 s when that caption looks
//     cut off (no closing . ? ! or a dangling word like "and") or the request has under three words so far
//     (a bare "Nova, please."). Hard caps: 12 captions or 60 s per request.
//   Other speakers' captions never join; each speaker has at most one open request.
//   Half-cut words. A caption ending in `pr-` followed by one starting with lowercase `iya` is joined: "priya".
//   Slivers. A caption of at most two words that is exactly a known Whisper filler is not stitched and
//     never becomes a request; the intake still stores it in the transcript.
//   Cancel. "Nova, never mind / cancel / stop" from the asker, while their request is open, cancels it.
//   Commands. "Nova, stop listening" / "Nova, pause" -> pause; "Nova, leave" -> dismiss; any speaker
//     (decision 8: anyone in the call can pause or dismiss).
import type { TranscriptLine } from './types.js';

export interface RequestEvent {
  type: 'request';
  callId: string;
  askedBy: string;
  text: string;
  /** Transcript line numbers that make up the request, in order. */
  lines: number[];
  startedAt: number;
  endedAt: number;
}
export interface CancelEvent {
  type: 'cancel';
  callId: string;
  askedBy: string;
  lines: number[];
  /** `cancelled`: the asker took it back. `empty`: they said the name and nothing followed. */
  reason: 'cancelled' | 'empty';
}
export interface CommandEvent {
  type: 'command';
  callId: string;
  command: 'pause' | 'dismiss';
  by: string;
  line: number;
}
export type DetectorEvent = RequestEvent | CancelEvent | CommandEvent;

export const DETECTOR_LIMITS = {
  quietMs: 1500,
  cutWaitMs: 4000,
  maxCaptions: 12,
  maxMs: 60_000,
  /** Under this many words the request is still an opener and waits the long time. */
  openerWords: 3,
} as const;

const NAME = /(^|[^\p{L}\p{N}_])(nova)(?:['’]s)?(?![\p{L}\p{N}_]|-\p{L})/giu;
const GREETING_ONLY = /^(?:(?:hey|hi|hello|ok|okay|so|yo|and|but|alright|well|um|uh|oh|there)[\s,.!-]*)+$/i;
const IMPERATIVES = new Set([
  'please', 'write', 'create', 'make', 'summarize', 'summarise', 'assign', 'add', 'draft', 'tell', 'show', 'find',
  'open', 'list', 'remind', 'schedule', 'send', 'give', 'set', 'update', 'check', 'look', 'pull', 'file', 'log',
  'post', 'share', 'put', 'take', 'note', 'what', 'whats', "what's", 'who', 'when', 'where', 'how', 'why', 'which',
]);
/**
 * Whisper's known silence hallucinations, matched whole and only on a caption of two words or fewer.
 * PROVISIONAL: the words now come from a live session's transcript, which may not produce these.
 */
export const WHISPER_FILLERS = new Set([
  'thank you', 'thanks', 'you', 'bye', 'bye bye', 'goodbye', 'thanks for watching', 'okay', 'ok', 'uh', 'um', 'hmm', 'mm', 'mhm', 'the end',
]);
const DANGLING = new Set(['and', 'or', 'but', 'to', 'for', 'the', 'a', 'an', 'of', 'with', 'that', 'in', 'on', 'so', 'then', 'about', 'at', 'is', 'it']);

const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();

export function isFillerSliver(text: string): boolean {
  const n = norm(text);
  return n !== '' && words(n).length <= 2 && WHISPER_FILLERS.has(n);
}

/** A caption that was probably cut by the window, not finished by the speaker. */
export function looksCut(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/[a-z]-$/i.test(t)) return true;
  if (!/[.!?]["')\]]*$/.test(t)) return true;
  const last = norm(t).split(' ').pop() ?? '';
  return DANGLING.has(last);
}

/**
 * Capitalised words that, straight after the assistant's name with only a space between, make a known place or product name
 * ("Nova Scotia"), not an address. A small explicit list: an address has a comma, a pause or a request after the name.
 */
const NAME_PHRASE_SECOND_WORDS: ReadonlySet<string> = new Set(['Scotia', 'Scotian', 'Lima', 'Gorica', 'Friburgo', 'Poshta', 'Launcher']);

interface NameHit { addressed: boolean; rest: string }

/** The first mention of the name that is addressing the assistant, and what follows it. */
export function findAddress(text: string): NameHit | null {
  for (const m of text.matchAll(NAME)) {
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    const end = (m.index ?? 0) + m[0].length;
    const before = text.slice(0, start).trim();
    const after = text.slice(end);
    const rest = after.replace(/^[\s,:;.\-–—!?…]+/, '').trim();
    if (/^ +\S/.test(after) && NAME_PHRASE_SECOND_WORDS.has(after.trim().split(/\s+/)[0]!.replace(/[^\p{L}]+$/u, ''))) continue;
    const initial = before === '' || /[.!?;…]["')\]]*$/.test(before) || GREETING_ONLY.test(before);
    let addressed = initial;
    // Name as the very last word: the request is coming in the speaker's next caption, unless it is a thank-you.
    if (!addressed && rest === '' && !/(thanks|thank you|bye|goodbye|cheers|sorry)[\s,.!]*$/i.test(before)) addressed = true;
    if (!addressed) {
      if (/^\s*([,:;—–-]|\.\.\.|…)/.test(after)) addressed = true;
      else {
        const [first = '', second = ''] = norm(rest).split(' ');
        if (IMPERATIVES.has(first)) addressed = true;
        else if (['can', 'could', 'would', 'will'].includes(first) && second === 'you') addressed = true;
      }
    }
    if (addressed) return { addressed, rest };
  }
  return null;
}

const CANCEL = /^(?:never ?mind|cancel|stop|forget it|scratch that|cancel that|stop that|never ?mind that|forget that)(?: please| thanks)?$/;
const PAUSE = /^(?:please )?(?:stop listening|pause|pause listening|stop recording)(?: please| now)?$/;
const DISMISS = /^(?:please )?(?:leave|leave now|leave the call|leave the meeting|leave us)(?: please| now)?$/;

export function parseCommand(rest: string): 'cancel' | 'pause' | 'dismiss' | null {
  const n = norm(rest);
  if (PAUSE.test(n)) return 'pause';
  if (DISMISS.test(n)) return 'dismiss';
  if (CANCEL.test(n)) return 'cancel';
  return null;
}

interface Open {
  askedBy: string;
  parts: string[];
  lines: number[];
  startedAt: number;
  endedAt: number;
  startedClock: number;
  lastClock: number;
  lastLooksCut: boolean;
  captions: number;
}

/** Join a half-cut word across a caption boundary: "...assign it to pr-" + "iya". */
export function appendText(parts: string[], text: string): void {
  const last = parts[parts.length - 1];
  if (last !== undefined && /[A-Za-z]-$/.test(last) && /^[a-z]/.test(text)) parts[parts.length - 1] = last.slice(0, -1) + text;
  else parts.push(text);
}

export class RequestDetector {
  private readonly open = new Map<string, Open>();
  constructor(private readonly callId: string, private readonly clock: () => number = Date.now) {}

  /** The speaker's open request, if any (for tests and the intake's counters). */
  hasOpen(userId: string): boolean { return this.open.has(userId); }

  push(line: TranscriptLine): DetectorEvent[] {
    const events = this.expire();
    // A piece nobody's audio was voiced for has no speaker to ask anything: it is stored but never a request or a command.
    const userId = line.userId;
    if (userId === null) return events;
    const now = this.clock();
    const text = line.text.trim();
    if (!text) return events;
    const sliver = isFillerSliver(text);

    const hit = sliver ? null : findAddress(text);
    if (hit) {
      const command = parseCommand(hit.rest);
      if (command === 'pause' || command === 'dismiss') {
        events.push({ type: 'command', callId: this.callId, command, by: userId, line: line.seq });
        return events;
      }
      if (command === 'cancel') {
        const o = this.open.get(userId);
        if (o) {
          this.open.delete(userId);
          events.push({ type: 'cancel', callId: this.callId, askedBy: userId, lines: [...o.lines, line.seq], reason: 'cancelled' });
        }
        return events;
      }
      // A fresh mention closes the same speaker's earlier request first.
      const previous = this.open.get(userId);
      if (previous) events.push(...this.close(previous));
      const o: Open = { askedBy: userId, parts: [], lines: [line.seq], startedAt: line.at, endedAt: line.at,
        startedClock: now, lastClock: now, lastLooksCut: true, captions: 1 };
      if (hit.rest) { appendText(o.parts, hit.rest); o.lastLooksCut = looksCut(hit.rest); }
      this.open.set(userId, o);
      return this.capped(o, events, now);
    }

    const o = this.open.get(userId);
    if (!o || sliver) return events;
    appendText(o.parts, text);
    o.lines.push(line.seq);
    o.endedAt = line.at;
    o.lastClock = now;
    o.lastLooksCut = looksCut(text);
    o.captions += 1;
    return this.capped(o, events, now);
  }

  /** Close every request whose quiet time or cap has passed on the clock. */
  tick(): DetectorEvent[] { return this.expire(); }

  private deadline(o: Open): number {
    const text = o.parts.join(' ');
    const wait = o.lastLooksCut || words(text).length < DETECTOR_LIMITS.openerWords ? DETECTOR_LIMITS.cutWaitMs : DETECTOR_LIMITS.quietMs;
    return Math.min(o.lastClock + wait, o.startedClock + DETECTOR_LIMITS.maxMs);
  }
  private capped(o: Open, events: DetectorEvent[], now: number): DetectorEvent[] {
    if (o.captions >= DETECTOR_LIMITS.maxCaptions || now - o.startedClock >= DETECTOR_LIMITS.maxMs) events.push(...this.close(o));
    return events;
  }
  private expire(): DetectorEvent[] {
    const now = this.clock();
    const events: DetectorEvent[] = [];
    for (const o of [...this.open.values()]) if (now >= this.deadline(o)) events.push(...this.close(o));
    return events;
  }
  private close(o: Open): DetectorEvent[] {
    this.open.delete(o.askedBy);
    const text = o.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return [{ type: 'cancel', callId: this.callId, askedBy: o.askedBy, lines: o.lines, reason: 'empty' }];
    return [{ type: 'request', callId: this.callId, askedBy: o.askedBy, text, lines: o.lines, startedAt: o.startedAt, endedAt: o.endedAt }];
  }
}

/**
 * Name lock: did `userId` say the name in the `windowMs` before `atMs`? True when any line attributed to
 * that person (as `userId` or listed in `speakers`, so an overlapped line counts for each of them) ending in
 * [atMs - windowMs, atMs] contains an addressing mention of the name by `findAddress`. A line's end is
 * `at`. Pure; the audio side of the gate is a later package.
 */
export function nameLock(lines: readonly TranscriptLine[], userId: string, atMs: number, windowMs = 20_000): boolean {
  return lines.some((l) => (l.userId === userId || l.speakers?.includes(userId) === true)
    && l.at <= atMs && l.at >= atMs - windowMs && findAddress(l.text) !== null);
}
