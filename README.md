# SafeClaw Security Plugin

[中文文档](./README.zh-CN.md)

SafeClaw is a runtime security plugin for [OpenClaw](https://github.com/openclaw/openclaw). It enforces policy decisions on tool calls, supports approval workflows, sanitizes sensitive outputs, and exposes audit-ready decision telemetry.

## Why SafeClaw

LLM agents can execute powerful tools. SafeClaw provides a policy guardrail layer so risky operations are either blocked, challenged for approval, or allowed with warning and traceability.

## Core Capabilities

- Runtime policy enforcement for OpenClaw hooks (`before_tool_call`, `after_tool_call`, etc.)
- Rule-first security model (`allow`, `warn`, `challenge`, `block`)
- Challenge approval workflow with command-based admin handling
- Dynamic sensitive-path registry that maps paths to asset labels before rule evaluation
- Sensitive data scanning and sanitization (DLP)
- Admin dashboard for strategy and account policy operations
- Decision events for audit and observability
- Built-in internationalization (`en` and `zh-CN`) for runtime/admin text

## Architecture

SafeClaw follows a layered architecture:

- `domain`: policy, approval, context inference, formatting
- `domain/services/sensitive_path_registry.ts`: built-in + runtime-overridden sensitive path mappings
- `engine`: rule matching, decisioning, DLP scanning
- `config`: base YAML + SQLite runtime override
- `admin`: dashboard backend + frontend
- `monitoring`: runtime status and decision snapshots

See [Architecture](./docs/ARCHITECTURE.md) and [Technical Solution](./docs/TECHNICAL_SOLUTION.md).

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Run verification

```bash
npm test
```

### 3. Start admin dashboard (standalone)

```bash
npm run admin
```

Default dashboard URL: `http://127.0.0.1:4780`

## OpenClaw Integration

A minimal plugin entry in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "enabled": true,
    "allow": ["safeclaw"],
    "load": {
      "paths": ["/absolute/path/to/safeclaw"]
    },
    "entries": {
      "safeclaw": {
        "enabled": true,
        "config": {
          "configPath": "./config/policy.default.yaml",
          "dbPath": "./runtime/safeclaw.db",
          "statusPath": "./runtime/safeclaw-status.json",
          "adminAutoStart": true,
          "adminPort": 4780
        }
      }
    }
  }
}
```

## Approval Commands

After setting one account policy with `is_admin=true`, the admin can run:

- `/safeclaw-approve <approval_id>`
- `/safeclaw-approve <approval_id> long`
- `/safeclaw-reject <approval_id>`
- `/safeclaw-pending`

## Admin Dashboard

Dashboard supports English and Chinese UI switching and stores language preference in local storage.
By default, it follows the host system language.

Main panels:

- Overview: posture and trend signals
- Decisions: recent decision events and reasons
- Policies: grouped rule strategy controls plus sensitive-path registry management
- Accounts: admin approver account selection and mode settings

Sensitive path registry behavior:

- Built-in path patterns cover credentials, personal content, download staging, browser profiles, browser secret stores, and communication stores.
- Registry entries are persisted in SQLite runtime strategy overrides together with rule decisions.
- Built-in entries can be disabled from the dashboard, and custom path rules can be added without editing the base YAML.

## Documentation

- [Documentation Index](./docs/README.md)
- [OpenClaw Install Guide](./docs/OPENCLAW_INSTALL.md)
- [Admin Dashboard](./docs/ADMIN_DASHBOARD.md)
- [Runbook](./docs/RUNBOOK.md)
- [Integration Guide](./docs/INTEGRATION_GUIDE.md)

## Development

```bash
npm run typecheck
npm run test:unit
npm test
npm run admin:build
```

## Project Status

Current repository is configured as private (`"private": true` in `package.json`).

## License

Not declared yet.
