# Meeting assistant: design and plan

13 November 2026, revised the same day. Status (14 November): packages 1 to 7 are built and merged, behind a flag that is off by default. The audit's nine blocking defects are repaired and a second audit found them closed (`docs/meeting-assistant-audit.md`). One paid run of the whole server chain against the real provider passed. What is left needs the owner: a real call through the media server (6b), then package 8.

**Revision.** The first draft listened with the media server's local Whisper captions service. The owner's instruction is to listen with the OpenAI live model the voice navigator already uses. This version does that. The captions service is not used.

## What this is

An assistant, shown as **Nova**, that a person in a call can invite. It hears everyone in the call, knows who said what, answers when someone addresses it by name, offers actions to the person who asked, and leaves minutes behind. It is the voice navigator's live model and tool catalogue, moved from one person's microphone to a whole call.

The reference product is Claude Meetings (beta, November 2026): a visible participant in a video call that keeps a live transcript, replies in the call chat when addressed by name, acts through each person's own tools with per-request confirmation, and leaves a meeting page with notes, action items and the transcript.

## What already exists

Evidence is from a read of the five repositories on 13 November. Paths are relative to each repository.

| Need | Existing piece | State |
|---|---|---|
| Each speaker's audio, separately, on the server | Media server per-participant taps that POST PCM chunks to a URL (`live-video-streaming` `src/taps/TapManager.js`, `webhook-pcm`, `perParticipant`) | Built |
| Arm a tap for a call | `platform-api` `src/recordings/liveCaptions.ts` arms one for captions with the admin token | Built for a different sink |
| A live model that listens, speaks and delegates tool calls | The voice navigator's session (`middleware/src/lib/voice/openai.ts`), model `gpt-live-1`, delegation to `gpt-6-luna` | Built for one browser microphone over WebRTC |
| A server-side audio path into that model | The Live API's primary WebSocket takes raw PCM (`docs/voice-navigator-spec.md`, "Endpoint"); `scripts/voice/probe-realtime.mjs` uses it | Proven by probes; not in the product |
| A tool catalogue with per-role filtering and confirm cards | `middleware/src/lib/voice/catalogue.ts`, `portal/src/lib/voice/tools.ts` | Built for one person |
| A chat beside the call | `orgiq:huddle:<callId>` (`middleware/src/lib/call-chat.ts`) | Built; refuses anyone without a seat |
| A card with approve and reject in chat | `AgentRunCard` in `ui-components` | Built for agent runs |
| Tell people they are transcribed | `RecordingConsentNotice` (`kind: 'transcription'`) in `ui-components` | Built; the portal has not adopted it |

## What is missing

1. Nothing carries call audio to the live model. The voice session takes one browser's microphone.
2. The live model's transcript has no speaker. The server must work out who spoke.
3. No non-human author can post in the call chat, and nothing plays the model's voice to the call.
4. The voice tools run for the one person holding the tab. There is no "the person who asked" in a call.
5. Nothing stores words. The voice log deliberately keeps none.
6. No per-call session, budget, spend source, invite or consent flow.

## Probe result (13 November)

Six sessions against `gpt-live-1` over the server WebSocket, four billed, 150 seconds in all. The audio was a 46-second synthetic meeting of three voices mixed into one stream.

| Question | Result |
|---|---|
| Does it stay quiet while people talk to each other? | Yes: no output during chatter, in both mixed runs |
| Does it ignore its name when nobody asks it anything? | Yes ("I think Nova could help with that later" drew nothing) |
| Does it answer when addressed? | Yes, about 0.9 s after the request ended |
| Does it delegate a tool call correctly? | Yes: `create_work_item { title: "Login cookie bug", assignee: "Priya" }` 1.8 s after the request; nothing delegated during chatter |
| Is the transcript of everyone complete? | Yes, for all three voices, with start and end times |
| Does the transcript say who spoke? | No. No speaker field exists, and the provider's separate transcription route has none either |
| Is there a silent or text-only mode? | No. Every attempt to turn the voice off was refused. Output audio always exists; it is silent unless the model speaks |
| Do several sessions run at once? | Yes. But a session that hears one person alone treats them as its conversation partner and spoke unprompted twice |

Not determined: the longest a session may run, whether a quiet session bills less, and how the quiet behaviour holds over a long meeting with real overlapping speech. Price on the provider's page: $0.05 per minute, billed per second.

## Decisions

1. **One live session per call, fed a mix made on the server.** The middleware receives each participant's PCM from the media server's taps, mixes it into one stream and sends it to one live session over the WebSocket. One session per speaker is rejected: it multiplies the cost by the number of people, and a lone speaker draws unprompted replies.
2. **The server works out who spoke.** It has each participant's audio separately before mixing, so it keeps a timeline of who was voiced when. Each transcript piece carries start and end times; the speaker is the participant voiced for most of that span. Overlapping speech that cannot be separated is stored as spoken by several people.
3. **Addressed by name, quiet otherwise.** The session's instructions say so, and the probe shows it holds. As a second lock, the server accepts a tool call only when the attributed transcript of the preceding seconds contains the name from the person it attributes the request to; otherwise the call is answered as refused and logged. Typed requests are call chat messages that mention Nova.
4. **Nova answers in the call chat first, and aloud second.** Every answer is posted in the chat from the model's output transcript. Playing its voice to the call is its own package: the server relays the output audio to each participant's browser, which plays it locally. Nova is not a media participant.
5. **Every action runs in the asking person's own browser with their own permissions.** The server never acts as a person. A tool call from the model becomes a turn for the attributed asker's browser: reads run at once, as the voice navigator's do; writes appear as a card in the call chat that only the asker's click runs. A spoken "yes" confirms nothing. The model is told at once that a write is waiting on the asker, and told the outcome when it is decided, because a tool call left unanswered stalls the session.
6. **Asking in the call is choosing to share the answer with the call.** The answer is posted to everyone, labelled with who asked. Tools about one person's private standing (budget, access request status) answer only to the asker.
7. **The tool list is the union the session needs, filtered again per asker.** The session is created with the catalogue for the call's tenant. When a call arrives, the server checks it against the asker's own role before creating the turn, and the asker's browser and the routes check again.
8. **Consent is explicit and visible.** Inviting Nova posts a notice in the chat, shows the transcription notice to every participant, and marks the call bar. Anyone in the call can pause listening or dismiss Nova. A participant's audio is not mixed in, and nothing they say is stored, until they have acknowledged the notice. While paused, no audio is sent to the provider.
9. **Words are stored, audio is not.** Transcript lines are kept 30 days by default, readable only by people who were in the call. Audio passes through memory to the provider and is never written. The voice log's no-words rule does not change.
10. **Spend.** Listening costs money for every minute Nova is in the call. The session reserves against the inviter's budget, on the call's initiative when it has one, under a new spend source `meeting_assistant`. A call has a ceiling in minutes (default 60); Nova says so in the chat five minutes before, and anyone who may invite can extend it. Tool-call tokens settle as the voice navigator's do.
11. **Session length.** The provider's session carries an expiry about two hours after it starts (read from its own events on 13 November). The server replaces the session five minutes before that, and after an unexpected close, starting the new one with a short summary of the call so far.
12. **Mock first.** The default mock world gets an injector for attributed transcript lines and a scripted stand-in for the live session, so every behaviour is walked headlessly without media, a microphone or a paid session.
13. **Off by default.** One server flag, `MEETING_ASSISTANT_ENABLED`; the portal shows Nova, the Meetings list and the meeting page only while the session advertises it (there is no separate portal flag). A new policy action, `InviteMeetingAssistant`, decides who may invite.
14. **Outside guests.** Calls in this product have no guests today. If a lobby type later admits them, Nova leaves when one joins.

## Architecture

```
speakers ─► media server per-participant taps ─► audio intake (middleware)
                                                   │ per-speaker voiced timeline
                                                   │ mix to one 24 kHz stream (acknowledged speakers only)
                                                   ▼
                                        live session (WebSocket, one per call)
                                          │ input transcript   │ output transcript, output audio   │ delegated tool call
                                          ▼                    ▼                                   ▼
                              attribution by timeline     call chat as Nova              name lock, asker's role check
                                          │               (and voice relay)                        │
                                          ▼                                                        ▼
                                   transcript store                              turn for the asker's browser
                                   (30 days, no audio)                           (reads run; writes wait on a card)
                                          │                                                        │
                                          ▼                                                        ▼
                                    minutes at end                                 tool result back to the session
```

Middleware module `lib/meeting-assistant/`:

- `store`: assistant state per call and transcript lines, behind the existing store selection.
- `intake`: the PCM sink for the taps (a secret-guarded route), resampling, the voiced timeline, the mixer, and the acknowledgement gate.
- `session`: the live session over the WebSocket, built on the voice navigator's session code: start, audio, events, tool results, replacement, hangup, metering.
- `attribution`: transcript pieces to speakers.
- `detector`: the name lock, pause and dismiss commands, built on attributed lines.
- `turns`: the exchange with the asker's browser.
- `chat`: posts as Nova into the call chat through a server-side path that does not need a seat.
- `minutes`: notes, decisions and action items at the end, each action item offered as a card to its owner.

Routes under `/api/calls/:callId/assistant`: invite, pause, resume, dismiss, acknowledge, state, turn results, card decision, transcript, minutes.

## Packages

Each package is one branch, verified by the full chain, merged on its own.

| # | Package | Repositories | Size |
|---|---|---|---|
| 1 | Core: flag, policy action, state and transcript stores, acknowledgement, mock line injector, invite/pause/dismiss routes, detector | this one | Done |
| 2 | Nova in chat: server-side post as Nova, join and state notices, message and action card kinds | this one, `ui-components` | Done; three library gaps open (below) |
| 3 | Call UI: Invite Nova, roster entry, listening mark, transcription notice and acknowledgement, pause and dismiss | this one | Done; the ceiling line moves to package 4 |
| 4a | Session and turns on the server: the live session over the WebSocket (run against a fake server only), the scripted stand-in, attribution, the name lock, turns, spend source, hold on the inviter, ceiling and extend | this one | Done |
| 4b | Turns in the asker's browser: reads run, confirmed writes run, results return; three tool calls per request; time left and extend; acknowledgement stays offered; a plain reply when a typed request cannot be heard | this one | Done |
| 5 | Minutes: notes, decisions and action items when Nova leaves; the meeting page and the Meetings list under `/iq/meetings`; delete by the inviter. Not searchable: the search index cannot limit a record to named people | this one | Done; the provider request for minutes has run against a fake server only |
| 6a | Real audio on the server: the guarded sink with a second secret, binding a media id to a person, the mixer and voiced timeline, arming the tap, a forced-live mode, a tap simulator and its dry run | this one | Done; one paid run against the provider passed (below) |
| 6b | A real call: two people in a call through the media server with the secret configured there; measure quiet behaviour, attribution on real microphones and echo | this one, the media stack | Needs the owner |
| 7 | Nova's voice: off by default per call; the server relays the provider's voiced frames to the seats of the call over the call chat's socket, never stored; the browser plays them, shows a speaking mark, and each person can mute Nova; an echo guard keeps Nova's own words from counting as a request | this one | Done on the mock world and in the paid run's relay count; real sound and echo are unmeasured |
| 8 | Later: joining scheduled rooms on its own, a real media participant, minutes from the recorded transcript when a call was recorded | several | Large |

Packages 1 to 5 run entirely on the mock world. Package 6 needs the social stack, and a real call or a headless browser with a fake audio file, on its own ports.

Order: 1, then 2 and 3 in parallel, then 4, then 5, then 6, then 7.

Library gaps found by packages 2 and 3, closed in `ui-components` 2.526.0 and adopted (13 November): the chat panel cannot draw a custom message kind as a system line (Nova's notices show as a bubble); the consent notice has fixed wording and no acknowledge action (a banner is used); the call roster cannot show a non-media entry (Nova's line sits in the conversation pane's header).

## Running it against real media

Package 6a is the server side. The media server's per-participant taps post each speaker's 16 kHz audio to the middleware; the middleware mixes it into one 24 kHz stream for the live session and works out who spoke from the separate streams.

**How a participant becomes a person.** The taps name a participant by the media server's per-join id, `<user id>-<base36 stamp>`, minted from the same `sub` platform-api passes at join (the middleware's call-binding proof pins that to the session's own `sub`). The middleware has no record of it, so the portal reports it: `POST /api/calls/:callId/assistant/participant { participantId }`, a seat required, the id required to be the caller's own `sub`, a dash and a base36 stamp, and an id already bound to someone else refused. Audio from an id nobody bound is dropped and counted (`unmappedChunks`).

**The sink.** `POST /api/internal/meeting-assistant/pcm/:sinkToken`, raw PCM up to 64 KB, no cookie. The token is 32 random bytes made when Nova starts listening and again on every resume, kept only as a SHA-256 on the record, bound to the call's channel (`X-Channel-Arn`), and dead the moment the assistant pauses or leaves. The tap's address is not a secret from call participants (the media server can list a channel's tap destinations), so the token is the second check, not the only one: the media server also sends a shared secret in the header `X-Live-Captions-Secret` on its PCM posts, to the one origin it is configured for, and never lists it. The sink compares that header with `MEETING_ASSISTANT_SINK_SECRET` in constant time before it looks at the token. A missing or wrong secret, an unknown or dead token, a wrong channel: the same 404 with no body. With no secret configured the sink answers nothing and tap arming refuses (the invite answers 503 naming the setting), except under `INSECURE_DEV_MODE=true`, the repo's one switch for opening a security default; then the sink is open and logs once at start that it is. A person who has not acknowledged the notice is dropped before the timeline and the mixer.

**The channel is the server's.** On invite and resume the middleware looks it up from the call's own lobby with platform-api's `GET /api/video/sessions/by-lobby/:lobbyName`, asked as the person who is inviting, then creates one per-participant `webhook-pcm` tap for it on the media server and deletes it when the token dies. If the three settings below are missing, or the channel cannot be found, the invite answers 503 and nothing starts. A tap that cannot be made because nobody publishes audio yet (`409 no audio producer in channel`) is retried for up to a minute, then Nova says in the chat that it cannot hear the call yet.

| Variable | What it is |
|---|---|
| `MEETING_ASSISTANT_MEDIA_URL` | The media server's address, as the middleware reaches it |
| `MEETING_ASSISTANT_MEDIA_ADMIN_TOKEN` | Its admin token (never logged) |
| `MEETING_ASSISTANT_SINK_BASE_URL` | The address the media server reaches the middleware at, for example `http://host.docker.internal:<port>` |
| `MEETING_ASSISTANT_SINK_SECRET` | The shared secret the media server sends on every PCM post. Set the same value there as `LIVE_CAPTIONS_SHARED_SECRET`, with `LIVE_CAPTIONS_ORIGIN` set to the origin in `MEETING_ASSISTANT_SINK_BASE_URL` (the media server sends the header to that one origin only). Never logged |
| `LIVE_CAPTIONS_SHARED_SECRET` and `LIVE_CAPTIONS_ORIGIN` | Media server side (not this repository): the value of the secret above, and the one origin it is sent to |
| `MEETING_ASSISTANT_LIVE=1` | Local only: the mock world uses the provider's real live session for one paid check. The key comes from `middleware/.env`. The process refuses to start with it on when `NODE_ENV=production` |

**Two scripts** (`scripts/meeting-assistant/`):

- `tap-sim.mjs` plays the media server's taps against a running middleware: `--base`, `--token`, `--channel` and a timeline of `{ participantId, wav, atMs }`, posting each speaker's audio in 200 ms chunks at real-time pace with the taps' headers, and `X-Live-Captions-Secret` when `MEETING_ASSISTANT_SINK_SECRET` is set in its environment.
- `live-e2e.mjs` starts its own middleware on port 3953 in the mock world, seats two demo personas in one call, invites Nova and plays about 40 seconds of synthetic speech (macOS `say`, two voices) through the simulator. It checks who each line is attributed to, that Nova stays quiet in chatter and when only named, that the first request is answered in chat labelled with the asker, that the second is an action card waiting for its asker, that the confirmed write is claimed once and its result needs the claim, that the sink refuses a wrong or missing secret, and that no tool call was refused. `--dry` runs the same chain against a fake provider and a fake media server (no cost). Without `--dry` it needs `--yes`, costs about $0.04 and stops itself 75 seconds after the invite.

What the audio is and is not. It passes through memory only: the sink, the mixer and the session write no file and log no audio. The mixer sends the provider one frame per 100 ms of wall time, silence included, so the provider's timeline matches wall time, and the voiced timeline is fed on that same timeline. A replaced session starts both again from zero while the tap and its token carry on.

**The paid run (14 November).** `node scripts/meeting-assistant/live-e2e.mjs --yes`, once, at `b420ddcf`: 28 checks passed. Two synthetic speakers, six utterances, 39 seconds of call audio in 104 chunks, all mixed, none late or unmapped. Every utterance was stored under the person who spoke it. Nova posted nothing during the chatter or when its name was used without a request. "Nova, what is two plus two?" was answered in the call chat, labelled with the asker. "Nova, create a work item for the login cookie bug." became a card for the person who asked, with that title; only that person could confirm it, the turn was claimed once, and a result needed the claim. No tool call was refused. With the voice on, 57 frames of Nova's speech were relayed and none dropped. The provider sent no error events. Billed: 45 seconds, $0.0367, plus $0.0008 of tool-call tokens.

What that run does not show: the media server's own taps (the simulator stood in for them), real microphones, noise, accents, overlapping speech, a long meeting, and sound in a browser.

## How it is judged

- A journey, `meeting-assistant`, on the default mock world at 1440 and 1280: invite, notice shown to a second participant, nothing stored for a participant who has not acknowledged, a read answer lands in chat labelled with the asker, a write shows a card that only the asker can confirm, a second person's "yes" does nothing, a tool call with no name in the asker's recent words is refused, pause stops storing lines, dismiss posts minutes, the meeting page shows them, a person who was not in the call is refused.
- Unit tests for attribution (clean turns, overlap, a speaker who joins late), the mixer and the name lock.
- The scope matrix and the voice inventory classify every new route.
- No validator script of its own: the journey and the unit suites run in the verification chain with the other journeys. The ceiling warning has unit tests but no journey step.
- A scenario suite for the simulator (`scripts/meeting-assistant/scenarios.mjs`): twelve scripted calls, run against a fake provider at no cost or against the real provider with `--yes` and a spending cap.
- Package 6 ends with a measured paid run: quiet during ten minutes of real conversation, answers when addressed, right speaker on each line.

## Risks

- **Quiet behaviour is instructed, not guaranteed.** The probe was 46 seconds of synthetic voices and the paid run 45; in both Nova stayed quiet until addressed. The name lock stops actions, but an unprompted remark is possible over a long real meeting; the voice is off by default and each person has a mute.
- **Attribution in overlap.** Two people talking at once give one transcript piece; the timeline can only say both were speaking.
- **Cost is continuous.** About $3 per hour of meeting, whether or not anyone addresses Nova. The ceiling and the pause control bound it.
- **Audio leaves the machine.** Every acknowledged participant's speech goes to the provider while Nova listens. The notice must say so in plain words.
- **Typed requests on the real session.** The Live API documents no text input, so a typed mention reaches only the scripted session. Until that changes, Nova says in chat that it hears spoken requests only.
- **A restart drops the live session.** On a graceful shutdown the server settles and pauses every call it serves. After a crash a check, at boot and then every two minutes, pauses and settles any listening record whose heartbeat is more than 90 seconds old and asks the media server to delete its taps; anyone seated can then resume.
- **Chained reads.** Text inside a record could lead the model to ask for more reads inside the name window; package 4b caps tool calls per request.
- **The asker's browser must be open.** If the asker leaves mid-turn, the turn expires, the model is told, and the chat says so.
- **Shared answers.** Decision 6 makes an asker responsible for what they ask in front of others. The private-tool list must be reviewed whenever a tool is added.
- **Echo.** With package 7, Nova's voice plays on speakers and can re-enter microphones. The browser's echo cancellation should remove it; package 7 measures it.
- **Service identities in the local stack are unsigned.** The server-side chat path and the tap sink must use credentials that also work with authentication on.

## Not in this plan

Phones and tablets, cloud deployment, calendars, other meeting products, recording changes, and the media server's captions service.
