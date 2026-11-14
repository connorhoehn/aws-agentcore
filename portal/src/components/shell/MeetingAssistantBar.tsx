// The call assistant in the shell (docs/meeting-assistant-design.md, decisions 8 and 13):
//   NovaBarControls  Invite Nova, the "Nova is listening" mark, Pause/Resume and Dismiss — the HuddleBar's `extras`
//   NovaNotice       the transcription notice for someone who has not acknowledged, above the footer row
//   useNovaRosterEntry  the "Nova (Assistant, listening)" line for the call's people lists
// Everything renders nothing unless the server advertises the feature (session.meetingAssistant) and a call is live.

import { Button, CheckIcon, Chip, CloseIcon, DropdownMenu, InlinePopover, Inline, PauseCircleIcon, PlayCircleIcon, PlusCircleIcon, T, Tooltip } from '@connorhoehn/ui-components/shared';
import { MicOffIcon, RecordingConsentNotice, SpeakerIcon, type RosterExtraEntry } from '@connorhoehn/ui-components/video';
import { ComposerPromptDeck, type ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { useMemo, useRef, useState } from 'react';
import { useNovaVoice } from '../../lib/novaVoice';
import { useMeetingAssistant } from '../../lib/meetingAssistant';
import { assistantPresent, assistantStateWords, markWords, timeLeftWords, noticeText, noticeVisible, rosterEntry, ASSISTANT_LABEL, ASSISTANT_NAME } from '../../lib/meetingAssistantModel';
import { useCallHost } from '../../lib/conversationCall';
import { hideNovaNotice, useNovaNoticeHidden } from '../../lib/novaNoticeHidden';

/** The live call's id, or null while there is no joined call to listen to. */
export function useLiveCallId(): string | null {
  const host = useCallHost();
  const call = host?.call;
  const joined = !!call && (call.phase === 'live' || call.phase === 'connecting' || call.phase === 'reconnecting');
  return joined ? call.call?.callId ?? null : null;
}

export function NovaBarControls() {
  const callId = useLiveCallId();
  const nova = useMeetingAssistant(callId);
  const { controls, view, busy } = nova;
  const noticeClosed = useNovaNoticeHidden(callId);
  const voice = useNovaVoice(callId, nova.view);
  const errorRef = useRef<HTMLButtonElement | null>(null);
  const [errorOpen, setErrorOpen] = useState(false);
  if (controls.hidden) return null;
  const state = assistantStateWords(view);
  const markBase = markWords(view, noticeClosed);
  const words = markBase === `${ASSISTANT_NAME} is listening` && voice.speaking ? `${ASSISTANT_NAME} is speaking` : markBase;
  const voiceMenu = assistantPresent(view);
  const left = timeLeftWords(view);
  const soundPrompt = !!words && voice.needsGesture && (voice.framesPlayed > 0 || voice.framesIgnored > 0);
  // Someone who cannot invite, with no Nova in the call, gets no bar at all (not an empty ruled slot).
  if (!controls.invite && !(state && controls.left) && !(words && !controls.left) && !soundPrompt && !nova.error) return null;
  return <Inline gap="xs" align="center" wrap={false} className="shrink-0 border-l border-border pl-2" data-testid="nova-bar">
    {controls.invite && <Tooltip content="Nova listens to this call and answers when asked by name" placement="top">
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void nova.invite()} data-testid="nova-invite">Invite Nova</Button>
    </Tooltip>}
    {/* One compact control keeps the dense bar on a line: the state in words is the trigger; acknowledge, pause or resume, extend and dismiss are its menu. */}
    {state && controls.left && <Chip size="xs" tone="neutral" data-testid="nova-left">{state}</Chip>}
    {words && !controls.left && <DropdownMenu align="end" triggerVariant="secondary" triggerClassName="px-2" triggerLabel={`${words}${left ? `, ${left}` : ''}${view.voice ? ", Nova's voice is on" : ''}. Acknowledge, pause, extend or dismiss Nova`} triggerTestId="nova-mark"
      triggerAttributes={{ 'data-phase': view.phase, 'data-voice': String(view.voice), 'data-voice-muted': String(voice.muted), 'data-voice-speaking': String(voice.speaking), 'data-voice-frames': String(voice.framesPlayed), 'data-voice-ignored': String(voice.framesIgnored), 'data-voice-last-seq': String(voice.lastSeq), 'data-must-ack': String(controls.acknowledge), ...(left ? { 'data-time-left': left } : {}) }} disabled={busy} data-testid="nova-menu"
      trigger={<T size="xs" weight="medium" className="whitespace-nowrap">{words}{left ? ` · ${left}` : ''}</T>}
      sections={[{ items: [
        ...(controls.acknowledge ? [{ label: 'Acknowledge', description: 'Nova cannot hear you until you do', icon: <CheckIcon size={14} />, onSelect: () => void nova.acknowledge() }] : []),
        ...(controls.pause ? [{ label: 'Pause Nova', icon: <PauseCircleIcon size={14} />, onSelect: () => void nova.pause() }] : []),
        ...(controls.resume ? [{ label: 'Resume Nova', icon: <PlayCircleIcon size={14} />, onSelect: () => void nova.resume() }] : []),
        ...(voiceMenu && nova.canSetVoice ? [{ label: view.voice ? "Turn Nova's voice off" : "Turn Nova's voice on", description: view.voice ? "Nova's voice is on in this call" : 'Nova answers aloud when asked', icon: <SpeakerIcon size={14} />, onSelect: () => void nova.setVoice(!view.voice) }] : []),
        ...(voiceMenu ? [{ label: voice.muted ? 'Unmute Nova for me' : 'Mute Nova for me', description: 'Only for you, on this browser', icon: <MicOffIcon size={14} />, onSelect: () => voice.setMuted(!voice.muted) }] : []),
        ...(controls.extend ? [{ label: 'Extend time', ...(left ? { description: left } : {}), icon: <PlusCircleIcon size={14} />, onSelect: () => void nova.extend() }] : []),
        ...(controls.dismiss ? [{ label: 'Dismiss Nova', icon: <CloseIcon size={14} />, danger: true, onSelect: () => void nova.dismiss() }] : []),
      ] }]} />}
    {soundPrompt && <Button variant="ghost" size="sm" onClick={() => void voice.enableSound()} data-testid="nova-enable-sound">Click to hear Nova</Button>}
    {/* The refusal sentence is read in full in a popover; the row keeps one short line. */}
    {nova.error && <>
      <Button ref={errorRef} variant="ghost" size="sm" className="max-w-[12rem] truncate text-danger" onClick={() => setErrorOpen((v) => !v)} aria-expanded={errorOpen} title={nova.error} data-testid="nova-error">{nova.error}</Button>
      <InlinePopover trigger={errorRef} open={errorOpen} onClose={() => setErrorOpen(false)} placement="top-end" className="max-w-sm p-3" aria-label="Why Nova could not do that" data-testid="nova-error-full">
        <T size="sm" tone="danger" wrap role="alert" data-testid="nova-error-text">{nova.error}</T>
      </InlinePopover>
    </>}
  </Inline>;
}

/** The server's over-budget refusal, asked as a deck prompt above the footer row (no dialog): the refusal sentence, then Go ahead or Cancel. */
export function NovaBudgetAsk() {
  const callId = useLiveCallId();
  const nova = useMeetingAssistant(callId);
  const { ask, answerAsk } = nova;
  const prompts = useMemo<ComposerPrompt[]>(() => ask ? [{
    id: `nova-budget:${callId}:${ask.action}:${ask.detail}`, scope: `nova-budget:${callId}`, kind: 'choice', eyebrow: 'Nova', title: ask.title,
    question: ask.detail,
    options: [{ id: 'go', label: 'Go ahead', emphasis: 'primary' }, { id: 'cancel', label: 'Cancel' }],
    onAnswer: async (a) => { await answerAsk('optionId' in a && a.optionId === 'go'); },
  }] : [], [ask, callId, answerAsk]);
  if (!ask) return null;
  return <ComposerPromptDeck prompts={prompts} scope={`nova-budget:${callId}`} className="mx-4 my-1" data-testid="nova-budget-ask" />;
}

/** The notice, on the library's RecordingConsentNotice with its own wording and two actions. Its close mark only hides it here; nothing is acknowledged or dismissed by it. */
export function NovaNotice() {
  const callId = useLiveCallId();
  const nova = useMeetingAssistant(callId);
  const hidden = useNovaNoticeHidden(callId);
  if (hidden || !noticeVisible(nova.enabled, nova.view)) return null;
  const text = noticeText(nova.view);
  return <RecordingConsentNotice open kind="transcription" placement="inline" className="mx-4 my-1" data-testid="nova-notice"
    title={text.title} description={text.body}
    acknowledgeLabel="I understand" onAcknowledge={nova.busy ? () => {} : () => void nova.acknowledge()}
    secondaryLabel="Dismiss Nova" onSecondary={nova.busy ? () => {} : () => void nova.dismiss()}
    onDismiss={() => { if (callId) hideNovaNotice(callId); }} />;
}

/** Nova as a non-media entry for the call's people lists; null when it is not in this call. */
export function useNovaRosterEntry(callId: string | null): string | null {
  const nova = useMeetingAssistant(callId);
  return nova.enabled && assistantPresent(nova.view) ? rosterEntry(nova.view) : null;
}

/** Nova as the library roster's non-media entry (`RosterPanel extraEntries`); empty when it is not in this call. */
export function useNovaRosterEntries(): RosterExtraEntry[] {
  const callId = useLiveCallId();
  const nova = useMeetingAssistant(callId);
  return nova.enabled && assistantPresent(nova.view)
    ? [{ id: 'assistant-nova', name: ASSISTANT_NAME, label: ASSISTANT_LABEL, status: nova.view.phase === 'paused' ? 'paused' : 'listening' }] : [];
}
