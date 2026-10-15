// Einstiegspunkt. Konfiguration über Umgebungsvariablen:
//   PORT (3847) · HOST (127.0.0.1) · MDT_DATA_DIR (./data) · TRUST_PROXY=1 (hinter nginx/Caddy)
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`MDT benötigt Node.js ≥ 22.13 (gefunden: ${process.versions.node}). Siehe deploy/ubuntu/README-UBUNTU.md.`);
  process.exit(1);
}

const { buildApp } = await import('./app.js');
const port = Number(process.env.PORT) || 3847;
const host = process.env.HOST || '127.0.0.1';
const server = buildApp();
server.listen(port, host, () => console.log(`MDT läuft auf http://${host}:${port}`));

// Sauberes Beenden (systemd stop/restart): offene Verbindungen schließen, Datenbank-Checkpoint durch Prozessende
const shutdown = (signal) => {
  console.log(`${signal} empfangen – beende …`);
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
