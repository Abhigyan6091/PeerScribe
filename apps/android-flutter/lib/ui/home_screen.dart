import 'package:flutter/material.dart';
import 'package:uuid/uuid.dart';
import 'package:peerscribe_mobile/core/protocol/event_model.dart';
import 'package:peerscribe_mobile/core/storage/database_helper.dart';
import 'package:peerscribe_mobile/core/sync/sync_manager.dart';
import 'package:peerscribe_mobile/core/sync/lan_sync_service.dart';
import 'package:peerscribe_mobile/core/sync/delta_update_manager.dart';
import 'package:peerscribe_mobile/core/clinical/patient_projection.dart';
import 'theme.dart';
import 'casualty_dossier.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({Key? key}) : super(key: key);

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  String _currentMode = 'FIELD'; // DORMANT | FIELD | EMERGENCY
  final DatabaseHelper _db = DatabaseHelper();
  final SyncManager _sync = SyncManager();

  Map<String, dynamic> _operation = {};
  List<ProjectedPatient> _patients = [];
  int _outboxCount = 0;
  int _unresolvedDivergencesCount = 0;
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _initServices();
  }

  Future<void> _initServices() async {
    await LanSyncService().startServer();
    if (mounted) {
      await _refreshState();
    }
  }

  Future<void> _refreshState() async {
    final op = await _db.getActiveOperation();
    final events = await _db.getAllEvents();
    final outbox = await _db.getOutbox();

    // Group events by patient entityId
    final Map<String, List<PeerScribeEvent>> grouped = {};
    for (final e in events) {
      grouped.putIfAbsent(e.entityId, () => []).add(e);
    }

    final patients = <ProjectedPatient>[];
    int divCount = 0;
    for (final entry in grouped.entries) {
      final p = ProjectedPatient.project(entry.value);
      if (p != null) {
        patients.add(p);
        divCount += p.divergenceFlags.where((f) => f['resolved'] != true).length;
      }
    }

    setState(() {
      _operation = op;
      _patients = patients;
      _outboxCount = outbox.length;
      _unresolvedDivergencesCount = divCount;
      _isLoading = false;
    });
  }

  Future<void> _createNewPatient() async {
    final allEvents = await _db.getAllEvents();
    final newId = 'pt_${const Uuid().v4()}';
    final ephemeralTag = 'TAG-${1000 + (allEvents.length * 37) % 9000}';

    final event = PeerScribeEvent(
      eventId: 'evt_${const Uuid().v4()}',
      operationId: _operation['operation_id']?.toString() ?? 'OP_TACTICAL',
      entityId: newId,
      eventType: 'PATIENT_CREATED',
      actorId: 'node_mobile_flutter',
      actorSequence: allEvents.length + 1,
      lamportTimestamp: allEvents.length + 1,
      occurredAtUtc: DateTime.now().toUtc().toIso8601String(),
      payload: {
        'ephemeral_id': ephemeralTag,
        'sector_geohash': 'u15ek200',
      },
    );

    await _db.insertEvent(event);
    await _refreshState();

    if (mounted) {
      Navigator.push(
        context,
        MaterialPageRoute(builder: (_) => CasualtyDossierScreen(patientId: newId)),
      ).then((_) => _refreshState());
    }
  }

  Future<void> _triggerLanSync() async {
    if (_currentMode == 'DORMANT') {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Networking disabled in DORMANT Mode.')),
      );
      return;
    }

    final hostController = TextEditingController(text: '10.0.2.2:4323');
    final pinController = TextEditingController();
    bool isSyncing = false;
    String? syncStatusMessage;
    bool? syncSuccess;

    try {
      await showDialog(
        context: context,
        builder: (dialogCtx) {
          return StatefulBuilder(
            builder: (context, setDialogState) {
              return AlertDialog(
                backgroundColor: TacticalTheme.surface,
                title: Row(
                  children: const [
                    Icon(Icons.wifi_tethering, color: TacticalTheme.primary),
                    SizedBox(width: 8),
                    Text('TACTICAL LAN SYNC', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.bold)),
                  ],
                ),
                content: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Local Mesh Listener: Port ${LanSyncService().port}',
                        style: const TextStyle(color: TacticalTheme.primary, fontSize: 12, fontWeight: FontWeight.bold),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'This Device Pairing PIN: ${LanSyncService().pairingPin}',
                        style: const TextStyle(color: TacticalTheme.textSecondary, fontSize: 11, fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: hostController,
                        style: const TextStyle(color: Colors.white),
                        decoration: const InputDecoration(
                          labelText: 'Peer Address (Host:Port)',
                          hintText: 'e.g. 192.168.1.15:4323 or 10.0.2.2:4323',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: pinController,
                        style: const TextStyle(color: Colors.white),
                        decoration: const InputDecoration(
                          labelText: 'Peer Pairing PIN',
                          hintText: 'e.g. TACTICAL-123456',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      if (isSyncing) ...[
                        const SizedBox(height: 16),
                        const Center(child: CircularProgressIndicator()),
                      ],
                      if (syncStatusMessage != null) ...[
                        const SizedBox(height: 12),
                        Container(
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(
                            color: (syncSuccess == true ? TacticalTheme.triageGreen : TacticalTheme.triageRed).withOpacity(0.2),
                            borderRadius: BorderRadius.circular(4),
                            border: Border.all(color: syncSuccess == true ? TacticalTheme.triageGreen : TacticalTheme.triageRed),
                          ),
                          child: Text(
                            syncStatusMessage!,
                            style: TextStyle(
                              color: syncSuccess == true ? TacticalTheme.triageGreen : TacticalTheme.triageRed,
                              fontSize: 12,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                actions: [
                  TextButton(
                    onPressed: isSyncing ? null : () => Navigator.pop(dialogCtx),
                    child: const Text('CLOSE', style: TextStyle(color: TacticalTheme.textMuted)),
                  ),
                  ElevatedButton(
                    style: ElevatedButton.styleFrom(backgroundColor: TacticalTheme.primary, foregroundColor: Colors.black),
                    onPressed: isSyncing ? null : () async {
                      setDialogState(() {
                        isSyncing = true;
                        syncStatusMessage = 'Connecting to peer at ${hostController.text.trim()}...';
                        syncSuccess = null;
                      });

                      final pinText = pinController.text.trim();
                      final result = await LanSyncService().syncWithPeer(
                        hostController.text.trim(),
                        pairingPin: pinText.isNotEmpty ? pinText : null,
                      );
                      if (mounted) {
                        await _refreshState();
                      }

                      if (dialogCtx.mounted) {
                        setDialogState(() {
                          isSyncing = false;
                          syncSuccess = result.success;
                          if (result.success) {
                            syncStatusMessage = 'Sync Succeeded: ${result.eventsSent} sent, ${result.eventsReceived} received, ${result.divergencesFlagged} divergences flagged.';
                          } else {
                            syncStatusMessage = 'Sync Failed: ${result.errorMessage}';
                          }
                        });
                      }
                    },
                    child: const Text('SYNC NOW', style: TextStyle(fontWeight: FontWeight.bold)),
                  ),
                ],
              );
            },
          );
        },
      );
    } finally {
      hostController.dispose();
      pinController.dispose();
    }
    if (mounted) {
      await _refreshState();
    }
  }

  Widget _buildModeBadge() {
    Color badgeColor = TacticalTheme.primary;
    if (_currentMode == 'DORMANT') badgeColor = TacticalTheme.triageUnassessed;
    if (_currentMode == 'EMERGENCY') badgeColor = TacticalTheme.triageRed;

    return PopupMenuButton<String>(
      onSelected: (mode) {
        setState(() => _currentMode = mode);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Switched to $mode Mode')),
        );
      },
      itemBuilder: (context) => [
        const PopupMenuItem(value: 'FIELD', child: Text('FIELD MODE')),
        const PopupMenuItem(value: 'EMERGENCY', child: Text('EMERGENCY MODE')),
        const PopupMenuItem(value: 'DORMANT', child: Text('DORMANT MODE (Radio Silence)')),
      ],
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: badgeColor.withOpacity(0.2),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: badgeColor, width: 1),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(width: 8, height: 8, decoration: BoxDecoration(color: badgeColor, shape: BoxShape.circle)),
            const SizedBox(width: 6),
            Text(_currentMode, style: TextStyle(color: badgeColor, fontSize: 12, fontWeight: FontWeight.bold)),
          ],
        ),
      ),
    );
  }

  Future<void> _checkForDeltaUpdates() async {
    final update = await DeltaUpdateManager().checkForUpdates();
    if (!mounted) return;
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: TacticalTheme.surface,
        title: Row(
          children: const [
            Icon(Icons.system_update_alt, color: TacticalTheme.primary),
            SizedBox(width: 8),
            Text('DELTA UPDATES', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.bold)),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Installed Version: v${update.currentVersion}', style: const TextStyle(color: TacticalTheme.textPrimary, fontWeight: FontWeight.bold)),
            const SizedBox(height: 6),
            Text(update.releaseNotes ?? 'PeerScribe is up-to-date.', style: const TextStyle(color: TacticalTheme.textSecondary, fontSize: 13)),
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: TacticalTheme.surfaceVariant,
                borderRadius: BorderRadius.circular(4),
              ),
              child: const Text(
                'Delta updates enabled: In-place differential patch application without manual APK reinstallation.',
                style: TextStyle(color: TacticalTheme.primary, fontSize: 11),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('DISMISS', style: TextStyle(color: TacticalTheme.textMuted)),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('PEERSCRIBE v1.0'),
        actions: [
          IconButton(
            icon: const Icon(Icons.system_update, size: 20, color: TacticalTheme.primary),
            tooltip: 'Check Delta Updates',
            onPressed: _checkForDeltaUpdates,
          ),
          Padding(
            padding: const EdgeInsets.only(right: 12.0),
            child: Center(child: _buildModeBadge()),
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _refreshState,
              child: SingleChildScrollView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Operation Card
                    Card(
                      child: Padding(
                        padding: const EdgeInsets.all(16.0),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                const Text('ACTIVE OPERATION', style: TextStyle(color: TacticalTheme.textSecondary, fontSize: 11)),
                                Text(_operation['status']?.toString() ?? 'ACTIVE', style: const TextStyle(color: TacticalTheme.primary, fontSize: 11, fontWeight: FontWeight.bold)),
                              ],
                            ),
                            const SizedBox(height: 6),
                            Text(
                              _operation['name']?.toString() ?? 'Tactical Disaster Mesh',
                              style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.bold),
                            ),
                            const SizedBox(height: 12),
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                _buildStatusMetric('Outbox Queue', '$_outboxCount evts'),
                                _buildStatusMetric('Divergences', '$_unresolvedDivergencesCount unresolved', isWarning: _unresolvedDivergencesCount > 0),
                                _buildStatusMetric('LAN Peers', '${_sync.connectedPeersCount} reachable'),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 16),

                    // Quick Actions
                    Row(
                      children: [
                        Expanded(
                          child: ElevatedButton.icon(
                            style: ElevatedButton.styleFrom(
                              backgroundColor: TacticalTheme.primary,
                              foregroundColor: Colors.black,
                              padding: const EdgeInsets.symmetric(vertical: 12),
                            ),
                            onPressed: _createNewPatient,
                            icon: const Icon(Icons.person_add_alt_1),
                            label: const Text('NEW CASUALTY', style: TextStyle(fontWeight: FontWeight.bold)),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: OutlinedButton.icon(
                            style: OutlinedButton.styleFrom(
                              foregroundColor: TacticalTheme.primary,
                              side: const BorderSide(color: TacticalTheme.primary),
                              padding: const EdgeInsets.symmetric(vertical: 12),
                            ),
                            onPressed: _triggerLanSync,
                            icon: const Icon(Icons.sync),
                            label: const Text('SYNC PEERS', style: TextStyle(fontWeight: FontWeight.bold)),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 20),

                    // Casualties List Header
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text('TRIAGED CASUALTIES', style: TextStyle(color: TacticalTheme.textSecondary, fontSize: 13, fontWeight: FontWeight.bold)),
                        Text('${_patients.length} Registered', style: const TextStyle(color: TacticalTheme.textMuted, fontSize: 12)),
                      ],
                    ),
                    const SizedBox(height: 12),

                    if (_patients.isEmpty)
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(32),
                        decoration: BoxDecoration(
                          color: TacticalTheme.surface,
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: TacticalTheme.border),
                        ),
                        child: Column(
                          children: const [
                            Icon(Icons.healing_outlined, color: TacticalTheme.textMuted, size: 40),
                            SizedBox(height: 8),
                            Text('No casualties recorded yet in this operation.', style: TextStyle(color: TacticalTheme.textMuted, fontSize: 13)),
                          ],
                        ),
                      )
                    else
                      ListView.builder(
                        shrinkWrap: true,
                        physics: const NeverScrollableScrollPhysics(),
                        itemCount: _patients.length,
                        itemBuilder: (context, idx) {
                          final p = _patients[idx];
                          final hasDiv = p.divergenceFlags.any((f) => f['resolved'] != true);
                          return Card(
                            margin: const EdgeInsets.only(bottom: 8),
                            child: ListTile(
                              leading: Container(
                                width: 14,
                                height: 14,
                                decoration: BoxDecoration(
                                  color: TacticalTheme.getTriageColor(p.activeTriage),
                                  shape: BoxShape.circle,
                                ),
                              ),
                              title: Row(
                                children: [
                                  Text(p.ephemeralId, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
                                  if (hasDiv) ...[
                                    const SizedBox(width: 8),
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                      decoration: BoxDecoration(
                                        color: TacticalTheme.triageRed.withOpacity(0.2),
                                        borderRadius: BorderRadius.circular(4),
                                        border: Border.all(color: TacticalTheme.triageRed),
                                      ),
                                      child: const Text('CONFLICT', style: TextStyle(color: TacticalTheme.triageRed, fontSize: 10, fontWeight: FontWeight.bold)),
                                    ),
                                  ],
                                ],
                              ),
                              subtitle: Text('Triage: ${p.activeTriage} • Updated: ${p.updatedAtUtc.substring(11, 16)} UTC', style: const TextStyle(color: TacticalTheme.textMuted, fontSize: 12)),
                              trailing: const Icon(Icons.arrow_forward_ios, size: 14, color: TacticalTheme.textMuted),
                              onTap: () {
                                Navigator.push(
                                  context,
                                  MaterialPageRoute(builder: (_) => CasualtyDossierScreen(patientId: p.patientId)),
                                ).then((_) => _refreshState());
                              },
                            ),
                          );
                        },
                      ),
                  ],
                ),
              ),
            ),
    );
  }

  Widget _buildStatusMetric(String label, String value, {bool isWarning = false}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(value, style: TextStyle(color: isWarning ? TacticalTheme.triageRed : Colors.white, fontSize: 13, fontWeight: FontWeight.bold)),
        const SizedBox(height: 2),
        Text(label, style: const TextStyle(color: TacticalTheme.textMuted, fontSize: 11)),
      ],
    );
  }
}
