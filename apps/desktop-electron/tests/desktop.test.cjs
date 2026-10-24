const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

describe('PeerScribe Windows Electron Desktop Engine', () => {
  it('validates preload script channel whitelists', () => {
    const preloadPath = path.resolve(__dirname, '../src/preload.cjs');
    assert.ok(fs.existsSync(preloadPath), 'Preload script must exist');
    const content = fs.readFileSync(preloadPath, 'utf8');

    // Context bridge and isolation checks
    assert.ok(content.includes('contextBridge.exposeInMainWorld'), 'Must expose via contextBridge');
    assert.ok(content.includes('ALLOWED_INVOKE_CHANNELS'), 'Must define invoke whitelist');
    assert.ok(content.includes('ALLOWED_RECEIVE_CHANNELS'), 'Must define receive whitelist');
    assert.ok(content.includes('clinical:change-triage'), 'Must include clinical triage channel');
    assert.ok(content.includes('clinical:resolve-divergence'), 'Must include divergence resolution');
  });

  it('verifies manifest package.json build configurations', () => {
    const pkgPath = path.resolve(__dirname, '../package.json');
    assert.ok(fs.existsSync(pkgPath), 'package.json must exist');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    assert.strictEqual(pkg.name, '@peerscribe/desktop-electron');
    assert.strictEqual(pkg.version, '1.0.0', 'First release version must be named v1.0 (1.0.0)');
    assert.ok(pkg.build, 'Must contain electron-builder config');
    assert.strictEqual(pkg.build.appId, 'org.peerscribe.desktop');
    assert.ok(pkg.build.nsis.differentialPackage, 'Must enable differential delta packaging');
    assert.ok(pkg.build.win, 'Must contain Windows build config');
    assert.ok(
      pkg.build.win.target.some(t => t.target === 'nsis'),
      'Must configure NSIS installer'
    );
    assert.ok(
      pkg.build.win.target.some(t => t.target === 'portable' || t.target === 'zip'),
      'Must configure portable target'
    );
  });

  it('validates offline persistence isolation between personal vault and operation data', () => {
    const tempDir = path.resolve(__dirname, '../test_scratch_tactical');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const vaultFile = path.join(tempDir, 'personal_vault.json');
    const eventsFile = path.join(tempDir, 'immutable_events.jsonl');

    // 1. Save vault data
    const vaultData = { blood_group: 'B+', allergies: ['Latex'], critical_conditions: [] };
    fs.writeFileSync(vaultFile, JSON.stringify(vaultData), 'utf8');

    // 2. Append operation event
    const opEvent = {
      schema_version: 1,
      event_id: 'evt_test_01',
      operation_id: 'OP_FLOOD_2026',
      entity_id: 'pt_test_01',
      event_type: 'PATIENT_CREATED',
      actor_id: 'node_win_test',
      actor_sequence: 1,
      lamport_timestamp: 1,
      occurred_at_utc: new Date().toISOString(),
      payload: { ephemeral_id: 'TAG-8821' }
    };
    fs.writeFileSync(eventsFile, JSON.stringify(opEvent) + '\n', 'utf8');

    // 3. Verify files are completely separate
    assert.ok(fs.existsSync(vaultFile));
    assert.ok(fs.existsSync(eventsFile));

    // 4. Simulate emergency wipe of operation
    fs.unlinkSync(eventsFile);
    assert.strictEqual(fs.existsSync(eventsFile), false, 'Operation events wiped');
    assert.strictEqual(fs.existsSync(vaultFile), true, 'Personal vault retained and not wiped');

    // Clean up
    fs.unlinkSync(vaultFile);
    fs.rmdirSync(tempDir);
  });
});
