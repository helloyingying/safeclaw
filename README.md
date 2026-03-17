# SecurityClaw Security Plugin

[中文文档](./README.zh-CN.md)

SecurityClaw is a runtime security plugin for [OpenClaw](https://github.com/openclaw/openclaw). It enforces policy decisions on tool calls, supports approval workflows, sanitizes sensitive outputs, and exposes audit-ready decision telemetry.

## Why SecurityClaw

LLM agents can execute powerful tools. SecurityClaw provides a policy guardrail layer so risky operations are either blocked, challenged for approval, or allowed with warning and traceability.

## Core Capabilities

- Runtime policy enforcement for OpenClaw hooks (`before_tool_call`, `after_tool_call`, etc.)
- Rule-first security model (`allow`, `warn`, `challenge`, `block`)
- Challenge approval workflow with command-based admin handling
- Dynamic sensitive-path registry that maps paths to asset labels before rule evaluation
- Sensitive data scanning and sanitization (DLP)
- Admin dashboard for strategy and account policy operations
- Decision events for audit and observability
- Built-in internationalization (`en` and `zh-CN`) for runtime/admin text

## Install

### Direct Use

Install the latest published release:

```bash
npx securityclaw install
```

Or install through the remote script:

```bash
curl -fsSL https://raw.githubusercontent.com/znary/securityclaw/main/install.sh | bash
```

Install a specific published version:

```bash
SECURITYCLAW_VERSION=0.0.3 curl -fsSL https://raw.githubusercontent.com/znary/securityclaw/main/install.sh | bash
```

After installation, if the admin dashboard did not open automatically, open `http://127.0.0.1:4780`.

### From Source

Clone the repository, then install dependencies:

```bash
npm install
```

Install the current workspace build into OpenClaw:

```bash
npm run openclaw:install
```

Run verification:

```bash
npm test
```

Start the standalone admin dashboard when needed:

```bash
npm run admin
```

## Uninstall

Remove the installed plugin from OpenClaw:

```bash
openclaw plugins uninstall securityclaw
```

Preview the removal first if needed:

```bash
openclaw plugins uninstall securityclaw --dry-run
```

## Documentation

- [Documentation Index](./docs/README.md)
- [OpenClaw Install Guide](./docs/OPENCLAW_INSTALL.md)
- [Admin Dashboard](./docs/ADMIN_DASHBOARD.md)
- [Runbook](./docs/RUNBOOK.md)
- [Integration Guide](./docs/INTEGRATION_GUIDE.md)

## License

MIT. See [LICENSE](./LICENSE).
