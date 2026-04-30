import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dartssh2/dartssh2.dart';
import 'package:flutter/foundation.dart';

import '../models/machine.dart';
import 'machine_manager_service.dart';

/// Result of an SSH operation
class SshResult {
  final bool success;
  final String? output;
  final String? error;

  const SshResult({required this.success, this.output, this.error});

  factory SshResult.success([String? output]) =>
      SshResult(success: true, output: output);

  factory SshResult.failure(String error) =>
      SshResult(success: false, error: error);
}

/// Handles SSH connections and remote Bridge Server startup.
class SshStartupService {
  final MachineManagerService _machineManager;

  /// Timeout for SSH connection
  static const _connectionTimeout = Duration(seconds: 10);

  /// Timeout for command execution
  static const _commandTimeout = Duration(seconds: 30);

  /// Verify that the Bridge service can be started before touching it.
  ///
  /// The auto-start service runs Bridge through npx, so report PATH problems
  /// directly instead of waiting for a generic start timeout.
  ///
  /// macOS setup installs a launchd LaunchAgent, while Linux setup installs a
  /// systemd user service. Detect the remote init system at runtime because the
  /// mobile app only knows how to reach the machine over SSH.
  static const _startPreflightCommand = r'''
if command -v launchctl >/dev/null 2>&1; then
  LABEL=com.ccpocket.bridge
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if [ ! -f "$PLIST" ]; then
    echo "Bridge auto-start setup is required. Run: npx @ccpocket/bridge@latest setup" >&2
    exit 1
  fi
  if ! /bin/zsh -li -c 'command -v npx >/dev/null 2>&1'; then
    echo "npx is not available in the remote login shell. Bridge auto-start uses npx. Fix Node.js/npm PATH on the machine, then run: npx @ccpocket/bridge@latest setup" >&2
    exit 127
  fi
elif command -v systemctl >/dev/null 2>&1; then
  SERVICE="$HOME/.config/systemd/user/ccpocket-bridge.service"
  if [ ! -f "$SERVICE" ]; then
    echo "Bridge auto-start setup is required. Run: npx @ccpocket/bridge@latest setup" >&2
    exit 1
  fi
  EXEC_START=$(grep -E '^ExecStart=' "$SERVICE" | head -n 1 | sed 's/^ExecStart=//')
  NPX_COMMAND=${EXEC_START%% *}
  if [ -z "$NPX_COMMAND" ]; then
    echo "Bridge auto-start setup is invalid. Run: npx @ccpocket/bridge@latest setup" >&2
    exit 1
  fi
  if [ "${NPX_COMMAND#/}" != "$NPX_COMMAND" ]; then
    if [ ! -x "$NPX_COMMAND" ]; then
      echo "npx configured in the Bridge service is not executable: $NPX_COMMAND. Fix Node.js/npm PATH on the machine, then run: npx @ccpocket/bridge@latest setup" >&2
      exit 127
    fi
  elif ! command -v "$NPX_COMMAND" >/dev/null 2>&1; then
    echo "npx is not available in the remote SSH PATH. Bridge auto-start uses npx. Fix Node.js/npm PATH on the machine, then run: npx @ccpocket/bridge@latest setup" >&2
    exit 127
  fi
else
  echo "Neither launchctl nor systemctl is available" >&2
  exit 127
fi
''';

  /// Start the Bridge service installed by
  /// `npx @ccpocket/bridge@latest setup`.
  ///
  /// macOS setup installs a launchd LaunchAgent, while Linux setup installs a
  /// systemd user service. Detect the remote init system at runtime because the
  /// mobile app only knows how to reach the machine over SSH.
  static const _startServiceCommand = r'''
if command -v launchctl >/dev/null 2>&1; then
  LABEL=com.ccpocket.bridge
  UID_VALUE=$(id -u)
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if [ ! -f "$PLIST" ]; then
    echo "Bridge auto-start setup is required. Run: npx @ccpocket/bridge@latest setup" >&2
    exit 1
  fi
  MIGRATED=0
  if /usr/libexec/PlistBuddy -c "Print :ProgramArguments:3" "$PLIST" 2>/dev/null | grep -qx "exec npx @ccpocket/bridge@latest"; then
    /usr/libexec/PlistBuddy -c "Set :ProgramArguments:3 exec npx --yes @ccpocket/bridge@latest" "$PLIST"
    MIGRATED=1
  fi
  if [ "$MIGRATED" = "1" ]; then
    launchctl bootout "gui/$UID_VALUE/$LABEL" 2>/dev/null || true
    launchctl bootout "user/$UID_VALUE/$LABEL" 2>/dev/null || true
    launchctl unload "$PLIST" 2>/dev/null || true
  fi
  launchctl kickstart -k "gui/$UID_VALUE/$LABEL" 2>/dev/null || \
    launchctl kickstart -k "user/$UID_VALUE/$LABEL" 2>/dev/null || \
    (launchctl bootstrap "gui/$UID_VALUE" "$PLIST" 2>/dev/null || true; launchctl kickstart -k "gui/$UID_VALUE/$LABEL" 2>/dev/null) || \
    (launchctl bootstrap "user/$UID_VALUE" "$PLIST" 2>/dev/null || true; launchctl kickstart -k "user/$UID_VALUE/$LABEL" 2>/dev/null) || \
    (launchctl load -w "$PLIST" 2>/dev/null || true; launchctl start "$LABEL")
elif command -v systemctl >/dev/null 2>&1; then
  SERVICE="$HOME/.config/systemd/user/ccpocket-bridge.service"
  if [ ! -f "$SERVICE" ]; then
    echo "Bridge auto-start setup is required. Run: npx @ccpocket/bridge@latest setup" >&2
    exit 1
  fi
  if [ -f "$SERVICE" ] && grep -q "^ExecStart=.*npx @ccpocket/bridge@latest$" "$SERVICE"; then
    perl -0pi.bak -e 's#^ExecStart=(.*npx) \@ccpocket/bridge\@latest$#ExecStart=$1 --yes \@ccpocket/bridge\@latest#m' "$SERVICE"
    systemctl --user daemon-reload
  fi
  systemctl --user restart ccpocket-bridge
else
  echo "Neither launchctl nor systemctl is available" >&2
  exit 127
fi
''';

  @visibleForTesting
  static String get startCommandForTest => _startCommand;

  @visibleForTesting
  static const startPreflightCommandForTest = _startPreflightCommand;

  @visibleForTesting
  static String get updateCommandForTest => _updateCommand;

  static String get _startCommand =>
      '${_startPreflightCommand.trim()}\n\n$_startServiceCommand';

  /// Stop the Bridge service without removing the setup installed by npx.
  static const _stopCommand = r'''
if command -v launchctl >/dev/null 2>&1; then
  LABEL=com.ccpocket.bridge
  UID_VALUE=$(id -u)
  launchctl bootout "gui/$UID_VALUE/$LABEL" 2>/dev/null || \
    launchctl bootout "user/$UID_VALUE/$LABEL" 2>/dev/null || \
    launchctl unload "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null || \
    launchctl stop "$LABEL"
elif command -v systemctl >/dev/null 2>&1; then
  systemctl --user stop ccpocket-bridge
else
  echo "Neither launchctl nor systemctl is available" >&2
  exit 127
fi
''';

  static String get _updateCommand =>
      '''
set -e
${_startPreflightCommand.trim()}
${_stopCommand.trim()} || true
sleep 1
${_startCommand.trim()}
''';

  SshStartupService(this._machineManager);

  /// Start Bridge Server on a remote machine.
  ///
  /// If [promptForPassword] is provided, it will be called when password is needed
  /// but not saved (returns the password to use).
  Future<SshResult> startBridgeServer(
    String machineId, {
    String? password,
    Future<String?> Function()? promptForPassword,
  }) async {
    final machine = _machineManager.getMachine(machineId);
    if (machine == null) {
      return SshResult.failure('Machine not found');
    }

    if (!machine.canStartRemotely) {
      return SshResult.failure('SSH not configured for this machine');
    }

    // Get credentials
    var sshPassword = password;
    String? sshPrivateKey;

    if (machine.sshAuthType == SshAuthType.password) {
      sshPassword ??= await _machineManager.getSshPassword(machineId);
      if (sshPassword == null || sshPassword.isEmpty) {
        if (promptForPassword != null) {
          sshPassword = await promptForPassword();
        }
        if (sshPassword == null || sshPassword.isEmpty) {
          return SshResult.failure('Password required');
        }
      }
    } else {
      sshPrivateKey = await _machineManager.getSshPrivateKey(machineId);
      if (sshPrivateKey == null || sshPrivateKey.isEmpty) {
        return SshResult.failure('Private key required');
      }
    }

    try {
      final result = await _executeCommand(
        machine,
        _startCommand,
        password: sshPassword,
        privateKey: sshPrivateKey,
      );
      return result;
    } catch (e) {
      return SshResult.failure(e.toString());
    }
  }

  /// Stop Bridge Server on a remote machine.
  Future<SshResult> stopBridgeServer(
    String machineId, {
    String? password,
  }) async {
    final machine = _machineManager.getMachine(machineId);
    if (machine == null) {
      return SshResult.failure('Machine not found');
    }

    if (!machine.canStartRemotely) {
      return SshResult.failure('SSH not configured for this machine');
    }

    // Get credentials
    var sshPassword = password;
    String? sshPrivateKey;

    if (machine.sshAuthType == SshAuthType.password) {
      sshPassword ??= await _machineManager.getSshPassword(machineId);
    } else {
      sshPrivateKey = await _machineManager.getSshPrivateKey(machineId);
    }

    try {
      return await _executeCommand(
        machine,
        _stopCommand,
        password: sshPassword,
        privateKey: sshPrivateKey,
      );
    } catch (e) {
      return SshResult.failure(e.toString());
    }
  }

  /// Test SSH connection without running commands.
  Future<SshResult> testConnection(
    String machineId, {
    String? password,
    String? privateKey,
  }) async {
    final machine = _machineManager.getMachine(machineId);
    if (machine == null) {
      return SshResult.failure('Machine not found');
    }

    if (machine.sshUsername == null) {
      return SshResult.failure('SSH username not configured');
    }

    try {
      final socket = await SSHSocket.connect(
        machine.host,
        machine.sshPort,
        timeout: _connectionTimeout,
      );

      final client = await _authenticate(
        socket,
        machine,
        password: password,
        privateKey: privateKey,
      );

      // Run a simple command to verify connection
      final result = await client.run('echo "Connection successful"');
      client.close();

      final output = utf8.decode(result);
      if (output.contains('Connection successful')) {
        return SshResult.success('SSH connection test passed');
      } else {
        return SshResult.failure('Unexpected response: $output');
      }
    } on SSHAuthFailError {
      return SshResult.failure('Authentication failed');
    } on SSHAuthAbortError {
      return SshResult.failure('Authentication aborted');
    } on TimeoutException {
      return SshResult.failure('Connection timeout');
    } catch (e) {
      return SshResult.failure('Connection failed: $e');
    }
  }

  /// Test SSH connection with inline credentials (for add/edit dialog)
  Future<SshResult> testConnectionWithCredentials({
    required String host,
    required int sshPort,
    required String username,
    required SshAuthType authType,
    String? password,
    String? privateKey,
  }) async {
    try {
      final socket = await SSHSocket.connect(
        host,
        sshPort,
        timeout: _connectionTimeout,
      );

      final SSHClient client;
      if (authType == SshAuthType.password) {
        if (password == null || password.isEmpty) {
          socket.close();
          return SshResult.failure('Password required');
        }
        client = SSHClient(
          socket,
          username: username,
          onPasswordRequest: () => password,
        );
      } else {
        if (privateKey == null || privateKey.isEmpty) {
          socket.close();
          return SshResult.failure('Private key required');
        }
        client = SSHClient(
          socket,
          username: username,
          identities: [...SSHKeyPair.fromPem(privateKey)],
        );
      }

      // Run a simple command to verify connection
      final result = await client.run('echo "Connection successful"');
      client.close();

      final output = utf8.decode(result);
      if (output.contains('Connection successful')) {
        return SshResult.success('SSH connection test passed');
      } else {
        return SshResult.failure('Unexpected response: $output');
      }
    } on SSHAuthFailError {
      return SshResult.failure('Authentication failed');
    } on SSHAuthAbortError {
      return SshResult.failure('Authentication aborted');
    } on TimeoutException {
      return SshResult.failure('Connection timeout');
    } catch (e) {
      return SshResult.failure('Connection failed: $e');
    }
  }

  /// Update Bridge Server on a remote machine via SSH.
  ///
  /// This only supports the auto-start service installed by
  /// `npx @ccpocket/bridge@latest setup`. Source checkouts are not
  /// updated from the app.
  Future<SshResult> updateBridgeServer(
    String machineId, {
    String? password,
    Future<String?> Function()? promptForPassword,
  }) async {
    final machine = _machineManager.getMachine(machineId);
    if (machine == null) {
      return SshResult.failure('Machine not found');
    }

    if (!machine.canStartRemotely) {
      return SshResult.failure('SSH not configured for this machine');
    }

    // Get credentials
    var sshPassword = password;
    String? sshPrivateKey;

    if (machine.sshAuthType == SshAuthType.password) {
      sshPassword ??= await _machineManager.getSshPassword(machineId);
      if (sshPassword == null || sshPassword.isEmpty) {
        if (promptForPassword != null) {
          sshPassword = await promptForPassword();
        }
        if (sshPassword == null || sshPassword.isEmpty) {
          return SshResult.failure('Password required');
        }
      }
    } else {
      sshPrivateKey = await _machineManager.getSshPrivateKey(machineId);
      if (sshPrivateKey == null || sshPrivateKey.isEmpty) {
        return SshResult.failure('Private key required');
      }
    }

    try {
      return await _executeCommand(
        machine,
        _updateCommand,
        password: sshPassword,
        privateKey: sshPrivateKey,
      );
    } catch (e) {
      return SshResult.failure(e.toString());
    }
  }

  /// Execute a command on the remote machine.
  ///
  Future<SshResult> _executeCommand(
    Machine machine,
    String command, {
    String? password,
    String? privateKey,
  }) async {
    try {
      final socket = await SSHSocket.connect(
        machine.host,
        machine.sshPort,
        timeout: _connectionTimeout,
      );

      final client = await _authenticate(
        socket,
        machine,
        password: password,
        privateKey: privateKey,
      );

      try {
        final result = await _runCommand(
          client,
          command,
        ).timeout(_commandTimeout);
        client.close();

        final output = result.output.trim();
        if (result.exitCode == 0 || result.exitCode == null) {
          return SshResult.success(
            output.isEmpty ? 'Command completed' : output,
          );
        }

        return SshResult.failure(
          output.isEmpty
              ? 'Command failed with exit code ${result.exitCode}'
              : output,
        );
      } finally {
        client.close();
      }
    } on SSHAuthFailError {
      return SshResult.failure('Authentication failed');
    } on SSHAuthAbortError {
      return SshResult.failure('Authentication aborted');
    } on TimeoutException {
      return SshResult.failure('Command timeout');
    } catch (e) {
      return SshResult.failure('SSH error: $e');
    }
  }

  Future<_RemoteCommandResult> _runCommand(
    SSHClient client,
    String command,
  ) async {
    final session = await client.execute(command);
    final output = BytesBuilder(copy: false);
    final stdoutDone = Completer<void>();
    final stderrDone = Completer<void>();

    session.stdout.listen(
      output.add,
      onDone: stdoutDone.complete,
      onError: stdoutDone.completeError,
    );
    session.stderr.listen(
      output.add,
      onDone: stderrDone.complete,
      onError: stderrDone.completeError,
    );

    await session.done;
    await stdoutDone.future;
    await stderrDone.future;

    return _RemoteCommandResult(
      exitCode: session.exitCode,
      output: utf8.decode(output.takeBytes()),
    );
  }

  /// Authenticate SSH connection
  Future<SSHClient> _authenticate(
    SSHSocket socket,
    Machine machine, {
    String? password,
    String? privateKey,
  }) async {
    if (machine.sshAuthType == SshAuthType.password) {
      if (password == null || password.isEmpty) {
        throw SSHAuthAbortError('Password required');
      }
      return SSHClient(
        socket,
        username: machine.sshUsername!,
        onPasswordRequest: () => password,
      );
    } else {
      if (privateKey == null || privateKey.isEmpty) {
        throw SSHAuthAbortError('Private key required');
      }
      return SSHClient(
        socket,
        username: machine.sshUsername!,
        identities: [...SSHKeyPair.fromPem(privateKey)],
      );
    }
  }
}

class _RemoteCommandResult {
  final int? exitCode;
  final String output;

  const _RemoteCommandResult({required this.exitCode, required this.output});
}
