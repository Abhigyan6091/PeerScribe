import 'package:flutter/material.dart';
import 'package:uuid/uuid.dart';
import '../protocol/event_model.dart';
import '../storage/database_helper.dart';
import '../storage/personal_vault_store.dart';
import '../sync/sync_manager.dart';
import '../clinical/patient_projection.dart';
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
  final PersonalVaultStore _vault = PersonalVaultStore();

  Map<String, dynamic> _operation = {};
  List<ProjectedPatient> _patients = [];
  int _outboxCount = 0;
  int _unresolvedDivergencesCount = 0;
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _refreshState();
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

    final bundle = await _sync.createOutboxBundle(localNodeId: 'node_mobile_flutter');
    final result = await _sync.ingestBundle(bundle);
    await _refreshState();

    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('LAN Sync Complete: ${result['inserted_events']} new events synced')),
      );
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('PEERSCRIBE TACTICAL'),
        actions: [
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
