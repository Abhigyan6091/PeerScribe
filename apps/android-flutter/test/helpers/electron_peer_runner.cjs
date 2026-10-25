const readline = require('readline');
const path = require('path');
const { LanSyncService } = require('../../../desktop-electron/src/lan_sync.cjs');

/**
 * Headless Electron/Node LanSyncService test runner for cross-platform integration tests.
 * Driven via stdin/stdout JSON-RPC commands from host-side Dart tests.
 */
let service = null;
let eventsLog = [];
let outboxQueue = [];
let activeOperation = { operation_id: 'OP_CROSS_PLATFORM_TEST' };

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
      const port = cmd.port || 4441;
      const pairingPin = cmd.pairingPin || 'TACTICAL-998877';
      const nodeId = cmd.nodeId || 'node_electron_cross_test';

      eventsLog = [];
      outboxQueue = [];

      service = new LanSyncService({
        port,
        nodeId,
        pairingPin,
        getState: () => ({ eventsLog, outboxQueue, activeOperation }),
        onEventsIngested: (newEvents) => {
          for (const evt of newEvents) {
            eventsLog.push(evt);
            // Store-and-forward outbox insertion
            if (!outboxQueue.some(e => e.event_id === evt.event_id)) {
              outboxQueue.push(evt);
            }
          }
          return 0;
        },
        onOutboxAcknowledged: (ackedIds) => {
          const remaining = outboxQueue.filter(e => !ackedIds.includes(e.event_id));
          outboxQueue.length = 0;
          outboxQueue.push(...remaining);
        }
      });

      await service.startServer();
      sendResponse({ status: 'STARTED', port, pairingPin, nodeId });
      break;
    }

    case 'ADD_EVENT': {
      const evt = cmd.event;
      eventsLog.push(evt);
      outboxQueue.push(evt);
      sendResponse({ status: 'EVENT_ADDED', event_id: evt.event_id });
      break;
    }

    case 'GET_STATE': {
      sendResponse({
        status: 'STATE',
        eventsCount: eventsLog.length,
        outboxCount: outboxQueue.length,
        events: eventsLog,
        outbox: outboxQueue,
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
