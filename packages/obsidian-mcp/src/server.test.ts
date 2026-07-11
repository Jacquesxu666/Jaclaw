import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createObsidianMcpServer } from "./server.js";
import { Vault } from "./vault.js";

let root = "";
let server: McpServer;
let client: Client;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-mcp-server-"));
  server = createObsidianMcpServer(new Vault(root));
  client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it("lists the vault tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).toSorted();
  expect(names).toEqual([
    "append_note",
    "create_note",
    "list_notes",
    "read_note",
    "save_conversation",
    "search_notes",
  ]);
});

it("saves a conversation and reads it back", async () => {
  const saved = await client.callTool({
    name: "save_conversation",
    arguments: { title: "Roundtrip", content: "## Q\nhello\n\n## A\nworld" },
  });
  expect(saved.isError).toBeFalsy();
  const savedPath = (saved.structuredContent as { path: string }).path;
  expect(savedPath).toMatch(/^Claude\/.*Roundtrip\.md$/);

  const read = await client.callTool({ name: "read_note", arguments: { path: savedPath } });
  const text = (read.content as Array<{ type: string; text: string }>)[0].text;
  expect(text).toContain("## A\nworld");
});

it("appends, lists, and searches notes", async () => {
  await client.callTool({
    name: "create_note",
    arguments: { path: "Inbox/todo", content: "- buy milk" },
  });
  await client.callTool({
    name: "append_note",
    arguments: { path: "Inbox/todo", content: "- ship MCP" },
  });

  const listed = await client.callTool({ name: "list_notes", arguments: {} });
  expect((listed.structuredContent as { notes: string[] }).notes).toEqual(["Inbox/todo.md"]);

  const found = await client.callTool({
    name: "search_notes",
    arguments: { query: "ship mcp" },
  });
  const matches = (found.structuredContent as { matches: Array<{ path: string }> }).matches;
  expect(matches).toHaveLength(1);
  expect(matches[0].path).toBe("Inbox/todo.md");
});

it("surfaces vault errors as tool errors", async () => {
  const result = await client.callTool({
    name: "read_note",
    arguments: { path: "../outside" },
  });
  expect(result.isError).toBe(true);
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  expect(text).toContain("invalid-path");
});
