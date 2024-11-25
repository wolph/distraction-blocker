import { defineManifest } from '@crxjs/vite-plugin';
import { MANIFEST_KEY } from './src/shared/manifest-key';

export default defineManifest({
  manifest_version: 3,
  name: 'Focus Lock',
  version: '0.1.0',
  description: 'Focus sessions that lock distracting sites, with earned pauses.',
  key: MANIFEST_KEY,
  icons: {
    16: 'assets/icons/idle-16.png',
    32: 'assets/icons/idle-32.png',
    48: 'assets/icons/idle-48.png',
    128: 'assets/icons/idle-128.png',
  },
  action: { default_popup: 'src/popup/popup.html' },
  options_page: 'src/options/options.html',
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.iife.ts'],
      run_at: 'document_start',
      all_frames: false,
    },
  ],
  permissions: [
    'storage',
    'alarms',
    'tabs',
    'webNavigation',
    'offscreen',
    'notifications',
    'scripting',
  ],
  host_permissions: ['<all_urls>'],
  incognito: 'spanning',
});
