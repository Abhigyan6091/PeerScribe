const { contextBridge, ipcRenderer } = require('electron');

/**
 * Secure Preload Bridge for PeerScribe Tactical Desktop.
 * Enforces strict IPC channel whitelisting and context isolation.
 */
const ALLOWED_INVOKE_CHANNELS = [
  'system:get-status',
  'system:set-mode',
  'system:wipe-data',
  'operation:get-active',
  'operation:create',
  'operation:finalize',
  'patient:list',
  'patient:get',
  'patient:create',
  'clinical:record-vitals',
  'clinical:record-injury',
  'clinical:record-medication',
  'clinical:change-triage',
  'clinical:resolve-divergence',
  'vault:get-profile',
  'vault:save-profile',
  'vault:disclose-snapshot',
  'sync:trigger-lan',
  'sync:get-peers',
  'sync:get-outbox'
];

const ALLOWED_RECEIVE_CHANNELS = [
  'sync:event-received',
  'sync:divergence-flagged',
  'sync:status-updated'
];

contextBridge.exposeInMainWorld('peerScribeDesktop', {
  isElectron: true,
  platform: 'windows',
  version: '1.0.0-alpha.1',

  invoke: (channel, data) => {
    if (!ALLOWED_INVOKE_CHANNELS.includes(channel)) {
      return Promise.reject(new Error(`Unauthorized IPC invoke channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, data);
  },

  on: (channel, callback) => {
    if (!ALLOWED_RECEIVE_CHANNELS.includes(channel)) {
      throw new Error(`Unauthorized IPC receive channel: ${channel}`);
    }
    const subscription = (event, ...args) => callback(...args);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  }
});
