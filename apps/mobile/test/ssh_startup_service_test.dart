import 'package:ccpocket/services/ssh_startup_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SshStartupService start preflight', () {
    test('checks npx before starting launchd service', () {
      final command = SshStartupService.startCommandForTest;

      expect(command, contains("/bin/zsh -li -c 'command -v npx"));
      expect(
        command,
        contains('npx is not available in the remote login shell'),
      );
      expect(command, contains('npx @ccpocket/bridge@latest setup'));
    });

    test('checks the npx command configured in the systemd service', () {
      final preflight = SshStartupService.startPreflightCommandForTest;

      expect(preflight, contains("grep -E '^ExecStart='"));
      expect(preflight, contains(r'[ ! -x "$NPX_COMMAND" ]'));
      expect(preflight, contains('command -v npx'));
      expect(preflight, contains('exit 127'));
    });

    test('update preflight can fail before stop command runs', () {
      final command = SshStartupService.updateCommandForTest;
      final preflight = SshStartupService.startPreflightCommandForTest;
      final preflightIndex = command.indexOf('command -v npx');
      final stopIndex = command.indexOf('systemctl --user stop');

      expect(preflightIndex, isNonNegative);
      expect(stopIndex, isNonNegative);
      expect(preflightIndex, lessThan(stopIndex));
      expect(preflight, isNot(contains('bootout')));
      expect(preflight, isNot(contains('systemctl --user stop')));
    });
  });
}
