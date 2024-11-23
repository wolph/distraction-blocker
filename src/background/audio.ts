import type { SoundId } from '../shared/messages';
import type { SoundSettings } from '../shared/types';

/**
 * Worker-to-offscreen sound command. Background-internal protocol:
 * both ends live in this workstream, the offscreen page imports the
 * type from here.
 */
export interface PlayMsg {
  type: 'playSound';
  sound: SoundId;
  volume: number;
}

const OFFSCREEN_URL: string = 'src/offscreen/audio.html';

let creating: Promise<void> | null = null;

/** MV3 workers cannot play audio, an offscreen document does it instead. */
async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (creating === null) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'play focus session chimes',
      })
      .finally((): void => {
        creating = null;
      });
  }
  await creating;
}

export async function playSound(sound: SoundId, settings: SoundSettings): Promise<void> {
  if (!settings[sound] || settings.masterVolume <= 0) return;
  await ensureOffscreen();
  const msg: PlayMsg = { type: 'playSound', sound, volume: settings.masterVolume };
  // The worker itself never receives this (senders are excluded), the
  // offscreen page does. No receiver acking is fine.
  await chrome.runtime.sendMessage(msg).catch((): undefined => undefined);
}

export function notify(title: string, message: string): void {
  const icon: string = chrome.runtime.getManifest().icons?.['128'] ?? 'assets/icons/idle-128.png';
  void chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL(icon),
    title,
    message,
  });
}
