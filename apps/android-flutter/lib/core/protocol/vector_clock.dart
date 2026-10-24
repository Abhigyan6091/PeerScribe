/// Vector Clock comparison and merging for distributed causal tracking.
class VectorClock {
  final Map<String, int> clock;

  VectorClock([Map<String, int>? initial]) : clock = Map.from(initial ?? {});

  int get(String actorId) => clock[actorId] ?? 0;

  void increment(String actorId) {
    clock[actorId] = get(actorId) + 1;
  }

  void merge(Map<String, int> other) {
    other.forEach((actor, seq) {
      if ((clock[actor] ?? 0) < seq) {
        clock[actor] = seq;
      }
    });
  }

  /// Evaluates causal relation between this clock (v1) and another (v2):
  /// Returns:
  /// - 'EQUAL'
  /// - 'ANCESTOR' (this happened strictly before other)
  /// - 'DESCENDANT' (this happened strictly after other)
  /// - 'CONCURRENT' (independent, potential conflict)
  String compare(Map<String, int> other) {
    bool hasGreater = false;
    bool hasLesser = false;

    final allActors = {...clock.keys, ...other.keys};
    for (final actor in allActors) {
      final s1 = clock[actor] ?? 0;
      final s2 = other[actor] ?? 0;
      if (s1 > s2) hasGreater = true;
      if (s1 < s2) hasLesser = true;
    }

    if (!hasGreater && !hasLesser) return 'EQUAL';
    if (hasGreater && !hasLesser) return 'DESCENDANT';
    if (!hasGreater && hasLesser) return 'ANCESTOR';
    return 'CONCURRENT';
  }

  Map<String, int> toMap() => Map.unmodifiable(clock);
}
