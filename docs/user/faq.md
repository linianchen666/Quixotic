# FAQ

## Where do agents run?

Agents run on the machine hosting Quixotic. The desktop app bundles a server.
You can also run the standalone CLI and open its bundled web interface.

## Which accounts can I use?

Configure the providers you already use, such as Codex, Claude Code, Cursor, or
OpenCode. Install and authenticate them on the host machine. Quixotic's source
is available under the [MIT License](../../LICENSE). Your providers handle
their own access and billing. See [Provider setup](./install.md#providers).

## Can I connect from my phone or another computer?

Keep the host running and pair from another device on your local network or
Tailscale. Build the mobile client from source, or use a web browser on a device
that can reach the host. See [Remote access](./remote-access.md).

## Where does my data go?

Quixotic stores app data on the host machine. Your chosen provider can receive
prompts and context needed to run agents. A default Quixotic installation runs
without a hosted account or product usage reporting. See the [project privacy
and telemetry notes](../../README.md#privacy--telemetry).

## Which desktop platforms can I use?

Quixotic supports Windows, macOS, and Linux. Check the
[installation guide](./install.md) for downloads and source builds.
