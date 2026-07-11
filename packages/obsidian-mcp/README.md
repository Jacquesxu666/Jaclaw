# @openclaw/obsidian-mcp

MCP server that lets Claude clients save conversations and notes directly into an
Obsidian vault (a plain Markdown folder). Runs over stdio for local clients
(Claude Desktop, Claude Code) or over Streamable HTTP with bearer-token auth for
remote setups (vault on a VPS, connected from claude.ai as a custom connector).

## Tools

- `save_conversation` — save a chat transcript as a new dated note with YAML frontmatter (`title`, `date`, `source: claude`, `tags`); filenames dedupe instead of overwriting. Default folder: `Claude/`.
- `create_note` — create a note at a vault-relative path.
- `append_note` — append Markdown to a note (creates it when missing by default).
- `read_note` — read a note.
- `list_notes` — list notes, optionally under one folder.
- `search_notes` — case-insensitive full-text search with path/line/snippet results.

Path handling is vault-relative only: absolute paths, `..` traversal, and
dot-folders (`.obsidian`, `.git`) are rejected.

## Configuration

| Setting         | Env                   | Flag             | Notes                     |
| --------------- | --------------------- | ---------------- | ------------------------- |
| Vault directory | `OBSIDIAN_VAULT_PATH` | `--vault <path>` | Required; must exist      |
| Transport       | —                     | `--http`         | Default is stdio          |
| Bearer token    | `OBSIDIAN_MCP_TOKEN`  | —                | Required in `--http` mode |
| Host            | —                     | `--host <host>`  | Default `127.0.0.1`       |
| Port            | `OBSIDIAN_MCP_PORT`   | `--port <n>`     | Default `8823`            |

## Local (Claude Desktop on macOS, vault synced from the VPS)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "bun",
      "args": ["/path/to/repo/packages/obsidian-mcp/src/index.ts"],
      "env": { "OBSIDIAN_VAULT_PATH": "/path/to/YourVault" }
    }
  }
}
```

No Bun on the machine? `npx tsx` works too: `"command": "npx"`,
`"args": ["tsx", "/path/to/repo/packages/obsidian-mcp/src/index.ts"]`.

## Remote (server on the VPS, vault lives there)

```bash
OBSIDIAN_VAULT_PATH=/srv/obsidian/YourVault \
OBSIDIAN_MCP_TOKEN="$(openssl rand -hex 32)" \
bun packages/obsidian-mcp/src/index.ts --http --port 8823
```

The endpoint is `http://127.0.0.1:8823/mcp` (`/health` for probes). Put a
TLS-terminating reverse proxy (Caddy, nginx) in front before exposing it, then:

- claude.ai (web/mobile): Settings → Connectors → Add custom connector with
  `https://your-domain/mcp`; supply the token as the bearer credential.
- Claude Desktop / other stdio-only clients: bridge with
  `npx mcp-remote https://your-domain/mcp --header "Authorization: Bearer <token>"`.

Keep the token secret; every vault write goes through it.

## Development

```bash
pnpm test -- packages/obsidian-mcp
```
