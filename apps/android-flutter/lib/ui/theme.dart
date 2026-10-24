import 'package:flutter/material.dart';

class TacticalTheme {
  static const Color background = Color(0xFF05070A);
  static const Color surface = Color(0xFF0D121D);
  static const Color surfaceVariant = Color(0xFF161E2E);
  static const Color border = Color(0xFF26334A);

  static const Color primary = Color(0xFF00E5FF);
  static const Color primaryDark = Color(0xFF0091EA);

  static const Color triageRed = Color(0xFFEF4444);
  static const Color triageYellow = Color(0xFFF59E0B);
  static const Color triageGreen = Color(0xFF10B981);
  static const Color triageBlack = Color(0xFF4B5563);
  static const Color triageUnassessed = Color(0xFF64748B);

  static const Color textPrimary = Color(0xFFF8FAFC);
  static const Color textSecondary = Color(0xFF94A3B8);
  static const Color textMuted = Color(0xFF64748B);

  static ThemeData get themeData {
    return ThemeData(
      brightness: Brightness.dark,
      scaffoldBackgroundColor: background,
      primaryColor: primary,
      colorScheme: const ColorScheme.dark(
        primary: primary,
        secondary: primaryDark,
        surface: surface,
        error: triageRed,
      ),
      cardTheme: const CardTheme(
        color: surface,
        elevation: 0,
        shape: RoundedRectangleBorder(
          side: BorderSide(color: border, width: 1),
          borderRadius: BorderRadius.all(Radius.circular(8)),
        ),
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: surface,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          color: textPrimary,
          fontSize: 18,
          fontWeight: FontWeight.bold,
          letterSpacing: 1.2,
        ),
      ),
    );
  }

  static Color getTriageColor(String category) {
    switch (category.toUpperCase()) {
      case 'RED':
        return triageRed;
      case 'YELLOW':
        return triageYellow;
      case 'GREEN':
        return triageGreen;
      case 'BLACK':
        return triageBlack;
      default:
        return triageUnassessed;
    }
  }
}
