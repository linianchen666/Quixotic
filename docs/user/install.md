# Install Quixotic

Quixotic runs coding agents on your own machine. Set up the host first, then
connect from its desktop or web interface or from a mobile client.

## Desktop

Check [Quixotic Releases](https://github.com/linianchen666/Quixotic/releases)
for a build for your platform and processor. On Debian or Ubuntu, install the
downloaded package with `sudo apt install ./<filename>.deb`. On Linux, an
AppImage needs executable permission before you can run it.

To build a desktop installer from source, install Vite+ as described in the
[development runbook](../operations/00_development.md#first-checkout). Clone the
repository and install dependencies:

```sh
git clone https://github.com/linianchen666/Quixotic.git
cd Quixotic
vp i
```

Run the command for your platform from the checkout:

| Platform | Command |
| --- | --- |
| macOS | `vp run dist:desktop:dmg` |
| Linux (x86-64) | `vp run dist:desktop:linux` |
| Windows (x86-64) | `vp run dist:desktop:win` |
| Windows (ARM64) | `vp run dist:desktop:win:arm64` |

The installer is placed in `release/`. To run the desktop app in development
without building an installer, use `vp run dev:desktop`.

## Command line

The desktop app can install the `quixotic-cli` command from **Settings → About**.
Use it to start the server, open the desktop app in your current project with
`quixotic-cli app`, or view commands with `quixotic-cli --help`.

To run the CLI from a source checkout with Vite+, build the web app and CLI:

```sh
vp run --filter @t3tools/web build
vp run --filter quixotic-cli build
vp run start
```

Run `node apps/server/dist/bin.mjs serve` to start without opening a browser
or `node apps/server/dist/bin.mjs --help` for more commands. Update a source
installation by pulling the latest source and rebuilding. The legacy `t3`
alias remains available in the CLI package for scripts that use it.

See [remote access](./remote-access.md) to connect another device and
[background service](./background-service.md) for native CLI service commands.

### Intel Macs

Build the CLI from source on an Intel Mac. The checkout commands above use
the bundled server and web app without requiring a standalone CLI archive.

## Mobile

Build a development client with the
[mobile setup instructions](../../apps/mobile/README.md), then pair it with
the machine running Quixotic. Use a pairing link over your local network or
[Tailscale](./remote-access.md). Mobile discovery and push services require
their own configuration for a self-hosted relay.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider            | Install and authenticate                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex               | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude              | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor              | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build          | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Kiro                | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode            | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity         | Install and sign in with Google from Quixotic's provider settings.                                                                                         |
| Pi                  | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code           | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx                  | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |
| ACP Registry agents | Add GitHub Copilot and other [ACP agents](./providers-acp.md#add-an-agent) from **Settings → Providers → Add provider → Show more**.                      |

Provider CLIs must be on the server's `PATH`. If Quixotic cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

Quixotic warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or
the CLI's own update command when Quixotic cannot tell. Claude, Codex, and
OpenCode installs Quixotic cannot identify stay manual: update them through the
installer you used. Quixotic runs `mise upgrade`
only for a tool your mise config requests as `latest` when the provider's binary
path is a mise shim or under the tool's `installs/<tool>/latest` link; update a
pinned version, or a path into one version's directory, through mise yourself.
Update a CLI installed with Nix through Nix.
Cursor and Antigravity update with Quixotic. Homebrew and Chocolatey installs
compare against the version their package manager offers, which can trail the
npm release; update Claude installed with Chocolatey through Chocolatey.

The managed runtimes for Antigravity and for Codex connected through ChatGPT
first install the release Quixotic tested. When Quixotic finds a newer compatible
release, their setup in **Settings → Providers** offers an update.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Quixotic does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), [fx](./providers-fx.md), and
[ACP Registry agents](./providers-acp.md).

### Provider check timeouts

If a provider works in its CLI but Quixotic reports a timeout while checking it,
allow more time in the Quixotic server's environment. For example, give Codex and
Claude readiness checks 60 seconds:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 quixotic-cli serve
```

For a remote environment, set these on the machine running the Quixotic server.
Keep them in your launcher or service configuration to retain them across
updates, then restart the server. For systemd, add
`Environment=T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` under `[Service]` in a service
override, reload systemd, and restart the service. Provider instances can also
set their own overrides in Settings → Providers.

Each variable extends that provider's readiness-probe deadlines; a phase whose
default is already longer keeps its default. Providers with several phases can
take longer than one deadline in total. Values must be whole milliseconds no
greater than 2147483647; unset or invalid values keep the defaults.

| Provider            | Environment variable                   |
| ------------------- | -------------------------------------- |
| Codex               | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude              | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor              | `T3CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity         | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok                | `T3CODE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro                | `T3CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx                  | `T3CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi                  | `T3CODE_PI_PROBE_TIMEOUT_MS`           |
| Muse Code           | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode            | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry agents | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

Longer deadlines also take longer to report a stalled check. These overrides
cover readiness and discovery, including OpenCode server startup. Usage and
config enrichment retain their own shorter limits. Turn execution, package
installation, update checks, and shutdown limits keep their existing behavior.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a host available.
- [Updating Quixotic](./updating.md): update the app and connected servers.
- [Managed policy](./managed-policy.md): configure Quixotic for everyone on a machine.
