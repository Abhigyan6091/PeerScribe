const readline = require('readline');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { LanSyncService } = require('../../../desktop-electron/src/lan_sync.cjs');
const { TacticalStorageEngine } = require('../../../desktop-electron/src/persistence_store.cjs');

/**
 * Headless Electron/Node LanSyncService test runner for cross-platform integration tests.
 * Driven via stdin/stdout JSON-RPC commands from host-side Dart tests.
 * Uses real disk persistence via TacticalStorageEngine to verify durable acceptance and crash recovery.
 */
let service = null;
let storageEngine = null;
let currentDataDir = null;
let currentPort = 4441;
let currentNodeId = 'node_electron_cross_test';
let currentPin = 'TACTICAL-998877';
let activeOperation = { operation_id: 'OP_CROSS_PLATFORM_TEST' };

// Redirect console.log to stderr so stdout contains exclusively JSON-RPC responses
console.log = (...args) => {
  process.stderr.write(args.join(' ') + '\n');
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', async (line) => {
  if (!line.trim()) return;
  try {
    const cmd = JSON.parse(line.trim());
    await handleCommand(cmd);
  } catch (err) {
    sendResponse({ status: 'ERROR', error: err.message, stack: err.stack });
  }
});

function sendResponse(resp) {
  process.stdout.write(JSON.stringify(resp) + '\n');
}

async function handleCommand(cmd) {
  switch (cmd.action) {
    case 'START': {
      currentPort = cmd.port || currentPort;
      currentPin = cmd.pairingPin || currentPin;
      currentNodeId = cmd.nodeId || currentNodeId;
      currentDataDir = cmd.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'peerscribe_node_cross_'));

      storageEngine = new TacticalStorageEngine(currentDataDir);

      service = new LanSyncService({
        port: currentPort,
        nodeId: currentNodeId,
        pairingPin: currentPin,
        getState: () => ({
          eventsLog: storageEngine.eventsLog,
          outboxQueue: storageEngine.outboxQueue,
          activeOperation
        }),
        onEventsIngested: (newEvents) => {
          for (const evt of newEvents) {
            storageEngine.persistEvent(evt);
          }
          return 0;
        },
        onOutboxAcknowledged: (ackedIds) => {
          storageEngine.acknowledgeEvents(ackedIds);
        }
      });

      const actualPort = await service.startServer();
      currentPort = actualPort;
      sendResponse({ status: 'STARTED', port: actualPort, pairingPin: currentPin, nodeId: currentNodeId, dataDir: currentDataDir });
      break;
    }

    case 'SET_PIN': {
      if (!service) throw new Error('Service not started');
      currentPin = cmd.pairingPin;
      service.setPairingPin(cmd.pairingPin, cmd.ttlSeconds || 300);
      sendResponse({ status: 'PIN_SET', pairingPin: cmd.pairingPin });
      break;
    }

    case 'ADD_EVENT': {
      if (!storageEngine) throw new Error('Storage engine not initialized');
      const evt = cmd.event;
      storageEngine.persistEvent(evt);
      sendResponse({ status: 'EVENT_ADDED', event_id: evt.event_id });
      break;
    }

    case 'GET_STATE': {
      if (!storageEngine) throw new Error('Storage engine not initialized');
      sendResponse({
        status: 'STATE',
        eventsCount: storageEngine.eventsLog.length,
        outboxCount: storageEngine.outboxQueue.length,
        events: storageEngine.eventsLog,
        outbox: storageEngine.outboxQueue,
        rejectedEvents: service ? service.rejectedEventsLog : []
      });
      break;
    }

    case 'SYNC_WITH_PEER': {
      if (!service) throw new Error('Service not started');
      const result = await service.syncWithPeer(cmd.peerAddress, cmd.pairingPin);
      sendResponse({ status: 'SYNC_COMPLETE', result });
      break;
    }

    case 'RESTART': {
      if (service) {
        await service.stopServer();
        service = null;
      }
      // Re-open storage engine from same data directory to verify recovery
      storageEngine = new TacticalStorageEngine(currentDataDir);
      currentPort = cmd.port || currentPort;
      currentPin = cmd.pairingPin || currentPin;
      currentNodeId = cmd.nodeId || currentNodeId;

      service = new LanSyncService({
        port: currentPort,
        nodeId: currentNodeId,
        pairingPin: currentPin,
        getState: () => ({
          eventsLog: storageEngine.eventsLog,
          outboxQueue: storageEngine.outboxQueue,
          activeOperation
        }),
        onEventsIngested: (newEvents) => {
          for (const evt of newEvents) {
            storageEngine.persistEvent(evt);
          }
          return 0;
        },
        onOutboxAcknowledged: (ackedIds) => {
          storageEngine.acknowledgeEvents(ackedIds);
        }
      });

      const actualPort = await service.startServer();
      currentPort = actualPort;
      sendResponse({
        status: 'RESTARTED',
        port: actualPort,
        nodeId: currentNodeId,
        dataDir: currentDataDir,
        eventsCount: storageEngine.eventsLog.length,
        outboxCount: storageEngine.outboxQueue.length
      });
      break;
    }

    case 'STOP': {
      if (service) {
        await service.stopServer();
        service = null;
      }
      sendResponse({ status: 'STOPPED' });
      process.exit(0);
      break;
    }

    default:
      sendResponse({ status: 'UNKNOWN_ACTION', action: cmd.action });
  }
}
