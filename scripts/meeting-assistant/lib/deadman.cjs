// A dead-man switch for a child process the meeting-assistant scripts start: loaded with NODE_OPTIONS=--require, it ends the
// process when MA_DEADMAN_MS milliseconds have passed since it started, whatever the parent is doing (or whether the parent still exists).
// It reads one number and touches nothing else.
'use strict';
const ms = Number(process.env.MA_DEADMAN_MS);
if (Number.isFinite(ms) && ms > 0) {
  const timer = setTimeout(() => { try { process.stderr.write('deadman: lifetime reached, exiting\n'); } catch { /* ignore */ } process.exit(3); }, ms);
  if (typeof timer.unref === 'function') timer.unref();
}
