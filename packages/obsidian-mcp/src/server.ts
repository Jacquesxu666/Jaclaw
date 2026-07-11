import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Vault, VaultError } from "./vault.js";

const SERVER_NAME = "obsidian-vault";
const SERVER_VERSION = "0.1.0";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function fail(err: unknown): ToolResult {
  const message =
    err instanceof VaultError
      ? `${err.code}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Build the Obsidian vault MCP server with all tools registered. */
export function createObsidianMcpServer(vault: Vault): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.tool(
    "save_conversation",
    "Save a chat conversation transcript into the Obsidian vault as a new dated Markdown note with frontmatter (title, date, tags). Pass the full transcript as Markdown in `content`.",
    {
      title: z.string().min(1).describe("Short human-readable topic of the conversation"),
      content: z.string().min(1).describe("Full conversation transcript as Markdown"),
      tags: z.array(z.string()).optional().describe("Frontmatter tags; defaults to [claude, chat]"),
      folder: z
        .string()
        .optional()
        .describe("Vault-relative folder to save into; defaults to 'Claude'"),
    },
    async ({ title, content, tags, folder }) => {
      try {
        const { path } = vault.saveConversation({ title, content, tags, folder });
        return ok(`saved conversation to ${path}`, { path });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "create_note",
    "Create a new Markdown note in the Obsidian vault at a vault-relative path (the .md extension is optional).",
    {
      path: z.string().min(1).describe("Vault-relative note path, e.g. 'Projects/Idea'"),
      content: z.string().describe("Note body as Markdown"),
      overwrite: z.boolean().optional().describe("Replace the note if it already exists"),
    },
    async ({ path, content, overwrite }) => {
      try {
        const result = vault.createNote(path, content, { overwrite });
        return ok(`created note ${result.path}`, { path: result.path });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "append_note",
    "Append Markdown to an existing note in the Obsidian vault (creates the note when missing unless create_if_missing is false).",
    {
      path: z.string().min(1).describe("Vault-relative note path"),
      content: z.string().min(1).describe("Markdown to append"),
      create_if_missing: z
        .boolean()
        .optional()
        .describe("Create the note when missing (default true)"),
    },
    async ({ path, content, create_if_missing }) => {
      try {
        const result = vault.appendNote(path, content, { createIfMissing: create_if_missing });
        return ok(result.created ? `created note ${result.path}` : `appended to ${result.path}`, {
          path: result.path,
          created: result.created,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "read_note",
    "Read a Markdown note from the Obsidian vault.",
    { path: z.string().min(1).describe("Vault-relative note path") },
    async ({ path }) => {
      try {
        return ok(vault.readNote(path));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "list_notes",
    "List Markdown notes in the Obsidian vault, optionally under one folder.",
    {
      folder: z.string().optional().describe("Vault-relative folder; defaults to the vault root"),
      limit: z.number().int().min(1).max(1000).optional().describe("Maximum notes to return"),
    },
    async ({ folder, limit }) => {
      try {
        const notes = vault.listNotes(folder ?? "", { limit });
        return ok(`${notes.length} notes\n${notes.join("\n")}`, { notes });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "search_notes",
    "Case-insensitive full-text search across Markdown notes in the Obsidian vault; returns path, line, and snippet per match.",
    {
      query: z.string().min(1).describe("Text to search for"),
      folder: z.string().optional().describe("Restrict the search to one vault-relative folder"),
      limit: z.number().int().min(1).max(200).optional().describe("Maximum matches to return"),
    },
    async ({ query, folder, limit }) => {
      try {
        const matches = vault.searchNotes(query, { folder, limit });
        const text =
          matches.length === 0
            ? "no matches"
            : matches.map((m) => `${m.path}:${m.line}: ${m.snippet}`).join("\n");
        return ok(text, { matches });
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
