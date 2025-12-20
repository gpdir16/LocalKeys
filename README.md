# LocalKeys

**English** | [한국어](README.ko.md)

LocalKeys is an Electron desktop app that encrypts secrets (env vars) locally, lets you manage them in a GUI, and fetch them safely from a CLI with explicit approval prompts.

**This is open source, but a paid license is required to use it.**
For $7.99 you can purchase a lifetime license that includes lifetime updates and lifetime use.
For more information, please refer to the Product Page.

- Product page: https://localkeys.privatestater.com

## Key Features

- Local-first encrypted vault (AES-256-GCM)
- Works completely offline
- Process approval system for access control
- Both GUI and CLI interfaces
- Seamless integration with existing dev workflows
- Mac and Windows support
- One-time purchase, lifetime updates

## CLI Usage

The CLI requires the app to be running and the Vault to be unlockable. You’ll see an approval popup in the app.

```bash
# List projects
localkeys list

# Set a secret (requires write approval)
localkeys set myapp API_KEY "sk-1234567890abcdef"

# Get a secret (requires read approval) - outputs `{ value, expiresAt }`
localkeys get myapp API_KEY

# Run a command with all project secrets injected as env vars (requires read approval)
localkeys run --project=myapp -- npm start
```

## Network Connections

Depending on settings/features, the app may contact:

- Update checks: `https://localkeys.privatestater.com/api/version`
- License check/activation: `https://id.privatestater.com/api/id/license/*`

You can disable automatic update checks in the settings, and license verification won't be called again after the initial setup.
After the first setup you can block all internet connections with a firewall.

## Build

```bash
npm run build
```

### Build per platform

```bash
npm run build:mac
npm run build:win
npm run build:linux # It can be built and used, but it is not yet officially supported.
```