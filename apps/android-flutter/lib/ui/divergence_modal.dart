import 'package:flutter/material.dart';
import 'package:uuid/uuid.dart';
import 'package:peerscribe_mobile/core/protocol/event_model.dart';
import 'package:peerscribe_mobile/core/storage/database_helper.dart';
import 'theme.dart';

class DivergenceResolutionDialog extends StatefulWidget {
  final String patientId;
  final Map<String, dynamic> divergenceFlag;
  final VoidCallback onResolved;

  const DivergenceResolutionDialog({
    Key? key,
    required this.patientId,
    required this.divergenceFlag,
    required this.onResolved,
  }) : super(key: key);

  @override
  State<DivergenceResolutionDialog> createState() => _DivergenceResolutionDialogState();
}

class _DivergenceResolutionDialogState extends State<DivergenceResolutionDialog> {
  String _selectedCategory = 'RED';
  final TextEditingController _noteController = TextEditingController();
  bool _isSubmitting = false;

  @override
  void dispose() {
    _noteController.dispose();
    super.dispose();
  }

  Future<void> _submitResolution() async {
    setState(() => _isSubmitting = true);
    final db = DatabaseHelper();
    final allEvents = await db.getAllEvents();
    final op = await db.getActiveOperation();

    final resolutionEvent = PeerScribeEvent(
      eventId: 'res_${const Uuid().v4()}',
      operationId: op['operation_id']?.toString() ?? 'OP_TACTICAL',
      entityId: widget.patientId,
      eventType: 'DIVERGENCE_RESOLVED',
      actorId: 'node_mobile_clinician',
      actorSequence: allEvents.length + 1,
      lamportTimestamp: allEvents.length + 1,
      occurredAtUtc: DateTime.now().toUtc().toIso8601String(),
      payload: {
        'flag_id': widget.divergenceFlag['flag_id'],
        'resolved_category': _selectedCategory,
        'clinician_signoff_note': _noteController.text.trim().isEmpty
            ? 'Authorized clinician override'
            : _noteController.text.trim(),
      },
    );

    await db.insertEvent(resolutionEvent);
    widget.onResolved();
    if (mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final flag = widget.divergenceFlag;
    return AlertDialog(
      backgroundColor: TacticalTheme.surface,
      shape: RoundedRectangleBorder(
        side: const BorderSide(color: TacticalTheme.triageRed, width: 2),
        borderRadius: BorderRadius.circular(8),
      ),
      title: Row(
        children: const [
          Icon(Icons.warning_amber_rounded, color: TacticalTheme.triageRed, size: 28),
          SizedBox(width: 8),
          Expanded(
            child: Text(
              'CLINICAL DIVERGENCE DETECTED',
              style: TextStyle(
                color: TacticalTheme.triageRed,
                fontSize: 16,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
        ],
      ),
      content: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: TacticalTheme.surfaceVariant,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: TacticalTheme.border),
              ),
              child: Text(
                flag['reason']?.toString() ?? flag['description']?.toString() ?? 'Concurrent Clinical Disagreement',
                style: const TextStyle(color: TacticalTheme.textPrimary, fontSize: 13),
              ),
            ),
            const SizedBox(height: 16),
            const Text(
              'Select Authoritative Triage Category:',
              style: TextStyle(color: TacticalTheme.textSecondary, fontSize: 12, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            Row(
              children: ['RED', 'YELLOW', 'GREEN', 'BLACK'].map((cat) {
                final isSelected = _selectedCategory == cat;
                return Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 2.0),
                    child: ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: isSelected
                            ? TacticalTheme.getTriageColor(cat)
                            : TacticalTheme.surfaceVariant,
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(vertical: 10),
                      ),
                      onPressed: () => setState(() => _selectedCategory = cat),
                      child: Text(cat, style: const TextStyle(fontWeight: FontWeight.bold)),
                    ),
                  ),
                );
              }).toList(),
            ),
            const SizedBox(height: 16),
            const Text(
              'Clinician Sign-off Note / Rationale:',
              style: TextStyle(color: TacticalTheme.textSecondary, fontSize: 12, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _noteController,
              maxLines: 2,
              style: const TextStyle(color: Colors.white, fontSize: 13),
              decoration: InputDecoration(
                filled: true,
                fillColor: TacticalTheme.surfaceVariant,
                border: const OutlineInputBorder(borderSide: BorderSide(color: TacticalTheme.border)),
                hintText: 'e.g. Confirmed RED due to acute respiratory distress',
                hintStyle: const TextStyle(color: TacticalTheme.textMuted),
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('CANCEL', style: TextStyle(color: TacticalTheme.textMuted)),
        ),
        ElevatedButton(
          style: ElevatedButton.styleFrom(
            backgroundColor: TacticalTheme.primary,
            foregroundColor: Colors.black,
          ),
          onPressed: _isSubmitting ? null : _submitResolution,
          child: const Text('SIGNOFF & RESOLVE', style: TextStyle(fontWeight: FontWeight.bold)),
        ),
      ],
    );
  }
}
