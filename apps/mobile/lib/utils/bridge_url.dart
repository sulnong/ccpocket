/// Returns the port used to identify a Bridge/relay URL in saved machine data.
///
/// Bare `ws://host` is kept compatible with ccpocket's historical default
/// Bridge port. Public relay URLs commonly include a path and omit the port,
/// so those follow the standard WebSocket defaults.
int bridgePortForUri(Uri uri) {
  if (uri.hasPort) return uri.port;
  final scheme = uri.scheme.toLowerCase();
  final hasPath = uri.path.isNotEmpty && uri.path != '/';
  return switch (scheme) {
    'wss' || 'https' => 443,
    'ws' || 'http' when hasPath => 80,
    _ => 8765,
  };
}
