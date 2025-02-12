import type { PlayMsg } from '../background/audio';

/**
 * WebAudio chime synth. Each sound is a short envelope-shaped note
 * sequence, no audio assets and nothing to license.
 */
const TUNES: Record<PlayMsg['sound'], Array<{ f: number; t: number; d: number }>> = {
  // happy unlock chime: C5 E5 G5 C6 rising arpeggio
  sessionComplete: [
    { f: 523.25, t: 0, d: 0.18 },
    { f: 659.25, t: 0.12, d: 0.18 },
    { f: 783.99, t: 0.24, d: 0.18 },
    { f: 1046.5, t: 0.36, d: 0.4 },
  ],
  breakStart: [
    { f: 659.25, t: 0, d: 0.15 },
    { f: 523.25, t: 0.18, d: 0.3 },
  ],
  breakEnd: [
    { f: 523.25, t: 0, d: 0.15 },
    { f: 659.25, t: 0.18, d: 0.3 },
  ],
  scheduleStart: [
    { f: 523.25, t: 0, d: 0.12 },
    { f: 783.99, t: 0.15, d: 0.35 },
  ],
};

let audioContext: AudioContext | null = null;

function reusableAudioContext(): AudioContext {
  if (audioContext === null || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }
  return audioContext;
}

chrome.runtime.onMessage.addListener((msg: PlayMsg): undefined => {
  if (msg.type !== 'playSound') return;
  const ctx: AudioContext = reusableAudioContext();
  for (const note of TUNES[msg.sound]) {
    const osc: OscillatorNode = ctx.createOscillator();
    const gain: GainNode = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = note.f;
    gain.gain.setValueAtTime(0, ctx.currentTime + note.t);
    gain.gain.linearRampToValueAtTime(msg.volume, ctx.currentTime + note.t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + note.t + note.d);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + note.t);
    osc.stop(ctx.currentTime + note.t + note.d + 0.05);
  }
});
