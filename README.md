<p align="center">
  <a href="https://github.com/linianchen666/Quixotic">
    <img src="./assets/prod/quixotic-web-icon-192x192.png" width="80" height="80" alt="Quixotic logo" />
  </a>
</p>

<h1 align="center">Quixotic</h1>

<p align="center"><strong>异想天开的想法要在这里实现</strong> — An open-source control plane for coding agents.</p>

Quixotic runs coding agents on your machine and gives them one fast interface across desktop, web, and mobile. It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent.

## Privacy & Telemetry

- **Product analytics removed.** Quixotic removes upstream product usage reports, Axiom exports, and automatic crash reports.
- **Local-only diagnostics & opt-in OTLP.** Host/process resource diagnostics remain strictly local, and optional OpenTelemetry export only runs if you explicitly configure `T3CODE_OTLP_*` / `OTEL_EXPORTER_OTLP_*` in Settings.
- **Local app data.** Fresh installs use `~/.quixotic`. The desktop app opens an existing T3 Code database in `~/.t3` when there is no Quixotic database.

## Replacing an existing T3 Code desktop installation

Exit T3 Code before upgrading. On Windows, run the matching Quixotic NSIS installer. On Debian or Ubuntu, install the Quixotic `.deb` with `sudo apt install ./<downloaded-file>.deb`. For a portable AppImage, replace the existing executable at the same path and keep its executable permission. Reusing that path keeps existing launchers pointed at the replacement.

Quixotic opens your existing desktop data in place. If both desktop databases already exist, it opens Quixotic's database. An explicit `T3CODE_HOME` takes priority.

## Local Development

```bash
vp i
vp dev           # web + server dev environment
vp dev:desktop   # Electron desktop dev environment
```

For full build and architecture details, see the [development runbook](./docs/operations/00_development.md#first-checkout) and [architecture overview](./docs/internals/01_architecture.md).

## License

The source code in this repository is licensed under the [MIT License](./LICENSE).

## Unofficial Fork & Trademark Notice

Quixotic is an **unofficial community fork** derived from [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) (MIT License), developed independently under separate branding and icons in compliance with [TRADEMARK.md](./TRADEMARK.md).

Quixotic is **not affiliated with, sponsored by, or endorsed by T3 Tools, Inc.**, and does not claim official T3 Code status or trademark rights.
