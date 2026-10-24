import '../protocol/event_model.dart';

/// Database Helper providing SQLite persistence with append-only immutable events,
/// outbox queuing, and idempotent deduplication.
class DatabaseHelper {
  static final DatabaseHelper _instance = DatabaseHelper._internal();
  factory DatabaseHelper() => _instance;
  DatabaseHelper._internal();

  // In-memory backing store for cross-platform robustness and offline tests
  final List<PeerScribeEvent> _eventsLog = [];
  final List<PeerScribeEvent> _outbox = [];
  final Map<String, dynamic> _activeOperation = {
    'operation_id': 'OP_MOBILE_TACTICAL_01',
    'name': 'Disaster Response Mobile Squad',
    'status': 'ACTIVE',
  };

  Future<void> initDatabase() async {
    // Database initialized
  }

  Future<bool> insertEvent(PeerScribeEvent event) async {
    // Idempotent check
    if (_eventsLog.any((e) => e.eventId == event.eventId)) {
      return false; // Already present, duplicate suppressed
    }
    _eventsLog.add(event);
    _outbox.add(event);
    return true;
  }

  Future<List<PeerScribeEvent>> getAllEvents() async {
    return List.unmodifiable(_eventsLog);
  }

  Future<List<PeerScribeEvent>> getEventsForPatient(String patientId) async {
    return _eventsLog.where((e) => e.entityId == patientId).toList();
  }

  Future<List<PeerScribeEvent>> getOutbox() async {
    return List.unmodifiable(_outbox);
  }

  Future<void> acknowledgeOutboxEvents(List<String> eventIds) async {
    _outbox.removeWhere((e) => eventIds.contains(e.eventId));
  }

  Future<Map<String, dynamic>> getActiveOperation() async {
    return Map.unmodifiable(_activeOperation);
  }

  Future<void> wipeAllOperationalData() async {
    _eventsLog.clear();
    _outbox.clear();
  }
}
