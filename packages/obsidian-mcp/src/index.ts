import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createObsidianMcpServer } from "./server.js";
import { Vault } from "./vault.js";

type CliOptions = {
  vaultPath: string;
  http: boolean;
  host: string;
  port: number;
  token: string | undefined;
};

const DEFAULT_PORT = 8823;
const USAGE = `Usage: obsidian-mcp [--vault <path>] [--http] [--host <host>] [--port <port>]

Environment:
  OBSIDIAN_VAULT_PATH  Vault directory (required unless --vault is passed)
  OBSIDIAN_MCP_TOKEN   Bearer token (required in --http mode)
  OBSIDIAN_MCP_PORT    Port for --http mode (default ${DEFAULT_PORT})`;

function parseArgs(argv: string[]): CliOptions {
  let vaultPath = process.env.OBSIDIAN_VAULT_PATH ?? "";
  let useHttp = false;
  let host = "127.0.0.1";
  let port = Number(process.env.OBSIDIAN_MCP_PORT ?? DEFAULT_PORT);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--vault") {
      vaultPath = argv[++i] ?? "";
    } else if (arg === "--http") {
      useHttp = true;
    } else if (arg === "--host") {
      host = argv[++i] ?? host;
    } else if (arg === "--port") {
      port = Number(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}\n\n${USAGE}`);
      process.exit(1);
    }
  }
  if (!vaultPath) {
    console.error(`missing vault path (set OBSIDIAN_VAULT_PATH or pass --vault)\n\n${USAGE}`);
    process.exit(1);
  }
  if (!fs.existsSync(vaultPath) || !fs.statSync(vaultPath).isDirectory()) {
    console.error(`vault directory not found: ${vaultPath}`);
    process.exit(1);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`invalid port: ${port}`);
    process.exit(1);
  }
  return { vaultPath, http: useHttp, host, port, token: process.env.OBSIDIAN_MCP_TOKEN };
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw === "" ? undefined : JSON.parse(raw);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function runStdio(vault: Vault): Promise<void> {
  const server = createObsidianMcpServer(vault);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`obsidian-mcp: serving vault ${vault.root} on stdio`);
}

async function runHttp(vault: Vault, opts: CliOptions): Promise<void> {
  if (!opts.token) {
    console.error("OBSIDIAN_MCP_TOKEN is required in --http mode");
    process.exit(1);
  }
  const token: string = opts.token;

  const httpServer = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      console.error("obsidian-mcp: request failed", err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal server error" },
          id: null,
        });
      }
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const auth = req.headers.authorization ?? "";
    const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (provided === "" || !tokenMatches(provided, token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method !== "POST") {
      // Stateless mode: no SSE stream or session teardown endpoints.
      res.setHeader("allow", "POST");
      sendJson(res, 405, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "method not allowed" },
        id: null,
      });
      return;
    }

    const body = await readJsonBody(req);
    // One server+transport pair per request keeps the endpoint stateless,
    // so restarts and multiple clients need no session bookkeeping.
    const server = createObsidianMcpServer(vault);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host, resolve);
  });
  console.error(
    `obsidian-mcp: serving vault ${vault.root} at http://${opts.host}:${opts.port}/mcp`,
  );
}

const opts = parseArgs(process.argv.slice(2));
const vault = new Vault(opts.vaultPath);
if (opts.http) {
  await runHttp(vault, opts);
} else {
  await runStdio(vault);
}
