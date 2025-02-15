import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useState } from 'preact/hooks';
import type { Ack, SoundId } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import type { Settings, SoundSettings } from '../shared/types';

export interface SoundsBadgeProps {
  settings: Settings;
  onChange: (next: Settings) => void;
}

const SOUND_EVENTS: ReadonlyArray<{ id: SoundId; key: keyof SoundSettings; label: string }> = [
  { id: 'sessionComplete', key: 'sessionComplete', label: 'Session complete' },
  { id: 'breakStart', key: 'breakStart', label: 'Break start' },
  { id: 'breakEnd', key: 'breakEnd', label: 'Break end' },
  { id: 'scheduleStart', key: 'scheduleStart', label: 'Schedule auto-start' },
];

/** Master volume, per-event sound toggles with previews, badge countdown. */
export function SoundsBadge(props: SoundsBadgeProps): VNode {
  const s: Settings = props.settings;
  const [pendingSound, setPendingSound]: [SoundId | null, Dispatch<StateUpdater<SoundId | null>>] =
    useState<SoundId | null>(null);
  const [previewError, setPreviewError]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);

  const preview: (sound: SoundId) => Promise<void> = async (sound: SoundId): Promise<void> => {
    setPreviewError(null);
    setPendingSound(sound);
    try {
      const ack: Ack = await sendRequest({ type: 'previewSound', sound });
      if (!ack.ok) setPreviewError(ack.error);
    } catch {
      setPreviewError('Could not preview the sound. Try again.');
    } finally {
      setPendingSound(null);
    }
  };
  return (
    <div>
      <h3>Sounds</h3>
      <label class="field">
        Master volume
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round(s.sounds.masterVolume * 100)}
          onInput={(event: Event): void => {
            const value: number = Number((event.currentTarget as HTMLInputElement).value);
            props.onChange({ ...s, sounds: { ...s.sounds, masterVolume: value / 100 } });
          }}
        />
      </label>
      {SOUND_EVENTS.map(
        (sound: { id: SoundId; key: keyof SoundSettings; label: string }): VNode => (
          <div class="field" key={sound.id}>
            <label class="check">
              <input
                type="checkbox"
                checked={s.sounds[sound.key] === true}
                onClick={(): void => {
                  props.onChange({
                    ...s,
                    sounds: { ...s.sounds, [sound.key]: s.sounds[sound.key] !== true },
                  });
                }}
              />
              {sound.label}
            </label>
            <button
              type="button"
              class="ghost"
              aria-label={`Preview ${sound.label}`}
              disabled={pendingSound !== null}
              onClick={(): void => {
                void preview(sound.id);
              }}
            >
              Play
            </button>
          </div>
        ),
      )}
      {previewError !== null ? (
        <p class="save-error" role="alert">
          {previewError}
        </p>
      ) : null}
      <h3>Notifications</h3>
      <label class="check">
        <input
          type="checkbox"
          checked={s.sessionCompleteNotification}
          onClick={(): void => {
            props.onChange({
              ...s,
              sessionCompleteNotification: !s.sessionCompleteNotification,
            });
          }}
        />
        Show a system notification when a session completes
      </label>
      <h3>Badge</h3>
      <label class="check">
        <input
          type="checkbox"
          checked={s.badgeCountdown}
          onClick={(): void => {
            props.onChange({ ...s, badgeCountdown: !s.badgeCountdown });
          }}
        />
        Show the remaining time on the toolbar icon
      </label>
    </div>
  );
}
