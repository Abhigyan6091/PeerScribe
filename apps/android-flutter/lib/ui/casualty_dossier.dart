import 'package:flutter/material.dart';
import 'package:uuid/uuid.dart';
import 'package:peerscribe_mobile/core/protocol/event_model.dart';
import 'package:peerscribe_mobile/core/storage/database_helper.dart';
import 'package:peerscribe_mobile/core/storage/personal_vault_store.dart';
import 'package:peerscribe_mobile/core/clinical/patient_projection.dart';
import 'package:peerscribe_mobile/core/clinical/start_triage_engine.dart';
import 'theme.dart';
import 'divergence_modal.dart';
import 'search_heatmap.dart';

class CasualtyDossierScreen extends StatefulWidget {
  final String patientId;

  const CasualtyDossierScreen({Key? key, required this.patientId}) : super(key: key);

  @override
  State<CasualtyDossierScreen> createState() => _CasualtyDossierScreenState();
}

class _CasualtyDossierScreenState extends State<CasualtyDossierScreen> {
  ProjectedPatient? _patient;
  List<PeerScribeEvent> _timelineEvents = [];
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _loadPatientData();
  }

  Future<void> _loadPatientData() async {
    final db = DatabaseHelper();
    final events = await db.getEventsForPatient(widget.patientId);
    setState(() {
      _timelineEvents = events;
      _patient = ProjectedPatient.project(events);
      _isLoading = false;
    });
  }

  Future<void> _recordTriage(String category, String rationale) async {
    final db = DatabaseHelper();
    final allEvents = await db.getAllEvents();
    final op = await db.getActiveOperation();

    final event = PeerScribeEvent(
      eventId: 'evt_${const Uuid().v4()}',
      operationId: op['operation_id']?.toString() ?? 'OP_TACTICAL',
      entityId: widget.patientId,
      eventType: 'TRIAGE_STATUS_CHANGED',
      actorId: 'node_mobile_flutter',
      actorSequence: allEvents.length + 1,
      lamportTimestamp: allEvents.length + 1,
      occurredAtUtc: DateTime.now().toUtc().toIso8601String(),
      payload: {
        'triage_category': category,
        'protocol': 'START_ADULT_v1.0',
        'rationale': rationale,
      },
    );

    await db.insertEvent(event);
    await _loadPatientData();
  }

  Future<void> _attachEmergencyVaultSnapshot() async {
    final vault = PersonalVaultStore();
    final snapshot = vault.generateEmergencySnapshot();
    if (snapshot == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('No emergency health profile configured or disclosed.')),
        );
      }
      return;
    }
    final db = DatabaseHelper();
    final allEvents = await db.getAllEvents();
    final op = await db.getActiveOperation();

    final event = PeerScribeEvent(
      eventId: 'evt_${const Uuid().v4()}',
      operationId: op['operation_id']?.toString() ?? 'OP_TACTICAL',
      entityId: widget.patientId,
      eventType: 'VAULT_SNAPSHOT_ATTACHED',
      actorId: 'node_mobile_flutter',
      actorSequence: allEvents.length + 1,
      lamportTimestamp: allEvents.length + 1,
      occurredAtUtc: DateTime.now().toUtc().toIso8601String(),
      payload: snapshot,
    );

    await db.insertEvent(event);
    await _loadPatientData();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Personal Health Snapshot Disclosed and Attached')),
      );
    }
  }

  void _showStartTriageDialog() {
    bool canWalk = false;
    bool breathing = true;
    int respRate = 24;
    bool pulsePresent = true;
    bool followsCommands = true;

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: TacticalTheme.surface,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (context, setModalState) {
            return Padding(
              padding: const EdgeInsets.all(20.0),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('DETERMINISTIC START TRIAGE', style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 12),
                  SwitchListTile(
                    title: const Text('Able to Walk? (Walking Wounded)', style: TextStyle(color: Colors.white, fontSize: 13)),
                    value: canWalk,
                    onChanged: (v) => setModalState(() => canWalk = v),
                  ),
                  SwitchListTile(
                    title: const Text('Spontaneous Breathing?', style: TextStyle(color: Colors.white, fontSize: 13)),
                    value: breathing,
                    onChanged: (v) => setModalState(() => breathing = v),
                  ),
                  SwitchListTile(
                    title: const Text('Radial Pulse Present?', style: TextStyle(color: Colors.white, fontSize: 13)),
                    value: pulsePresent,
                    onChanged: (v) => setModalState(() => pulsePresent = v),
                  ),
                  SwitchListTile(
                    title: const Text('Follows Simple Commands?', style: TextStyle(color: Colors.white, fontSize: 13)),
                    value: followsCommands,
                    onChanged: (v) => setModalState(() => followsCommands = v),
                  ),
                  const SizedBox(height: 16),
                  ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: TacticalTheme.primary,
                      foregroundColor: Colors.black,
                      minimumSize: const Size(double.infinity, 44),
                    ),
                    onPressed: () {
                      final eval = StartTriageEngine.evaluateStart(
                        canWalk: canWalk,
                        breathing: breathing,
                        radialPulsePresent: pulsePresent,
                        followsSimpleCommands: followsCommands,
                        respirationRate: respRate,
                      );
                      Navigator.pop(ctx);
                      _recordTriage(eval['category'], eval['rationale']);
                    },
                    child: const Text('CALCULATE & COMMIT TRIAGE', style: TextStyle(fontWeight: FontWeight.bold)),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_patient == null) {
      return const Scaffold(body: Center(child: Text('Patient not found')));
    }

    final p = _patient!;
    final unresolvedDivergences = p.divergenceFlags.where((f) => f['resolved'] != true).toList();

    return Scaffold(
      appBar: AppBar(
        title: Text('CASUALTY: ${p.ephemeralId}'),
        actions: [
          IconButton(
            icon: const Icon(Icons.map_outlined),
            tooltip: 'Search Heatmap',
            onPressed: () {
              Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => SearchHeatmapView(
                    patientEphemeralId: p.ephemeralId,
                    lastKnownLocation: 'Kathmandu Sector 4 (u15ek200)',
                    locationAge: '8 min ago',
                  ),
                ),
              );
            },
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Active Divergence Alert
            if (unresolvedDivergences.isNotEmpty) ...[
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: TacticalTheme.triageRed.withOpacity(0.2),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: TacticalTheme.triageRed, width: 2),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.warning, color: TacticalTheme.triageRed),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'UNRESOLVED CLINICAL DIVERGENCE (${unresolvedDivergences.length})',
                        style: const TextStyle(color: TacticalTheme.triageRed, fontWeight: FontWeight.bold),
                      ),
                    ),
                    ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: TacticalTheme.triageRed,
                        foregroundColor: Colors.white,
                      ),
                      onPressed: () {
                        showDialog(
                          context: context,
                          builder: (_) => DivergenceResolutionDialog(
                            patientId: widget.patientId,
                            divergenceFlag: unresolvedDivergences.first,
                            onResolved: _loadPatientData,
                          ),
                        );
                      },
                      child: const Text('RESOLVE'),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
            ],

            // Triage Header Card
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('ACTIVE TRIAGE CATEGORY', style: TextStyle(color: TacticalTheme.textSecondary, fontSize: 11)),
                        const SizedBox(height: 4),
                        Row(
                          children: [
                            Container(
                              width: 14,
                              height: 14,
                              decoration: BoxDecoration(
                                color: TacticalTheme.getTriageColor(p.activeTriage),
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 8),
                            Text(
                              p.activeTriage,
                              style: TextStyle(
                                color: TacticalTheme.getTriageColor(p.activeTriage),
                                fontSize: 20,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                    ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: TacticalTheme.surfaceVariant,
                        foregroundColor: TacticalTheme.primary,
                      ),
                      onPressed: _showStartTriageDialog,
                      icon: const Icon(Icons.medical_services_outlined, size: 16),
                      label: const Text('START TRIAGE'),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Known Allergies
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text('CRITICAL ALLERGIES', style: TextStyle(color: TacticalTheme.textSecondary, fontSize: 11)),
                        TextButton(
                          onPressed: _attachEmergencyVaultSnapshot,
                          child: const Text('ATTACH VAULT SNAPSHOT', style: TextStyle(fontSize: 11, color: TacticalTheme.primary)),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    if (p.knownAllergies.isEmpty)
                      const Text('No documented allergies', style: TextStyle(color: TacticalTheme.textMuted, fontSize: 13))
                    else
                      Wrap(
                        spacing: 8,
                        children: p.knownAllergies.map((a) {
                          return Chip(
                            backgroundColor: TacticalTheme.triageRed.withOpacity(0.2),
                            side: const BorderSide(color: TacticalTheme.triageRed),
                            label: Text(a, style: const TextStyle(color: TacticalTheme.triageRed, fontWeight: FontWeight.bold)),
                          );
                        }).toList(),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Event Timeline
            const Text('IMMUTABLE EVENT AUDIT TRAIL', style: TextStyle(color: TacticalTheme.textSecondary, fontSize: 12, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            ListView.builder(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: _timelineEvents.length,
              itemBuilder: (context, idx) {
                final e = _timelineEvents[idx];
                return Card(
                  margin: const EdgeInsets.only(bottom: 8),
                  child: ListTile(
                    dense: true,
                    leading: const Icon(Icons.fingerprint, color: TacticalTheme.primary, size: 20),
                    title: Text(e.eventType, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 12)),
                    subtitle: Text('By ${e.actorId} • Lamport: ${e.lamportTimestamp}\n${e.occurredAtUtc}', style: const TextStyle(color: TacticalTheme.textMuted, fontSize: 11)),
                  ),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}
