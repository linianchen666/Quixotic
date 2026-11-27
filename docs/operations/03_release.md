# Quixotic local builds

Build the installer for your platform using the [installation guide](../user/install.md#desktop). Local desktop builds are intended for local installation and testing.

## Windows payload topology and update validation

For a Windows build that can bootstrap its matching Linux server in WSL without
a separate download, build a Quixotic Linux CLI archive first. Pass it as
`--wsl-runtime /path/to/quixotic-cli-<version>-linux-<arch>.tar.gz` when building the
Windows artifact. Use the matching version and architecture.

## Apple signing and notarization (macOS)

Signing a distributable macOS build requires your own Apple Developer identity.
For a build with passkeys, also configure the provisioning profile and team for
your app. See [self-hosted relay setup](./02_connect-setup.md#desktop-passkeys).

## Publication

Quixotic uses [its own GitHub Releases](https://github.com/linianchen666/Quixotic/releases)
as its distribution index. The inherited upstream npm, app store, and hosting
workflows remain restricted to the upstream repository. Publish only with
credentials and identifiers configured for Quixotic.
