import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'ui/theme.dart';
import 'ui/home_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.light,
      systemNavigationBarColor: TacticalTheme.surface,
      systemNavigationBarIconBrightness: Brightness.light,
    ),
  );
  runApp(const PeerScribeApp());
}

class PeerScribeApp extends StatelessWidget {
  const PeerScribeApp({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'PeerScribe Tactical Mesh',
      debugShowCheckedModeBanner: false,
      theme: TacticalTheme.themeData,
      home: const HomeScreen(),
    );
  }
}
