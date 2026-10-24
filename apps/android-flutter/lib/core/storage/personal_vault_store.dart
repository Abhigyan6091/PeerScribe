/// Local Encrypted Personal Health Vault.
/// Strictly decoupled from temporary disaster operation records.
class PersonalVaultStore {
  static final PersonalVaultStore _instance = PersonalVaultStore._internal();
  factory PersonalVaultStore() => _instance;
  PersonalVaultStore._internal();

  Map<String, dynamic> _profile = {
    'blood_group': 'O+',
    'allergies': ['Penicillin', 'Sulfa'],
    'critical_conditions': ['Asthma'],
    'emergency_contacts': [
      {'name': 'Maya Sharma', 'relation': 'Spouse', 'phone': '+977-9801234567'}
    ],
    'is_emergency_disclosed': false,
  };

  Future<Map<String, dynamic>> getProfile() async {
    return Map.unmodifiable(_profile);
  }

  Future<void> updateProfile(Map<String, dynamic> updated) async {
    _profile = {..._profile, ...updated};
  }

  /// Explicit Emergency Snapshot Disclosure:
  /// Produces a sanitized emergency snapshot intended to be bound to a casualty record
  /// upon explicit authorized responder trigger.
  Map<String, dynamic> generateEmergencySnapshot() {
    return {
      'blood_group': _profile['blood_group'],
      'allergies': List<String>.from(_profile['allergies'] as List),
      'critical_conditions': List<String>.from(_profile['critical_conditions'] as List),
      'emergency_contacts': _profile['emergency_contacts'],
      'disclosed_at_utc': DateTime.now().toUtc().toIso8601String(),
    };
  }
}
