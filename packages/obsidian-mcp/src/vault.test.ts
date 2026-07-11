import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault, VaultError } from "./vault.js";

let root = "";
let vault: Vault;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-mcp-vault-"));
  vault = new Vault(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("path safety", () => {
  it("rejects absolute paths", () => {
    expect(() => vault.readNote("/etc/passwd")).toThrowError(VaultError);
  });

  it("rejects traversal outside the vault", () => {
    expect(() => vault.createNote("../escape", "x")).toThrowError(VaultError);
    expect(() => vault.createNote("a/../../escape", "x")).toThrowError(VaultError);
  });

  it("rejects dot-folders like .obsidian", () => {
    expect(() => vault.createNote(".obsidian/config", "x")).toThrowError(VaultError);
    expect(() => vault.createNote("notes/.git/hook", "x")).toThrowError(VaultError);
  });

  it("appends .md when missing", () => {
    const { path: notePath } = vault.createNote("Inbox/idea", "hello");
    expect(notePath).toBe("Inbox/idea.md");
    expect(fs.readFileSync(path.join(root, "Inbox/idea.md"), "utf8")).toBe("hello");
  });
});

describe("create/append/read", () => {
  it("refuses to overwrite unless asked", () => {
    vault.createNote("note", "one");
    expect(() => vault.createNote("note", "two")).toThrowError(VaultError);
    vault.createNote("note", "two", { overwrite: true });
    expect(vault.readNote("note")).toBe("two");
  });

  it("appends with a separating newline", () => {
    vault.createNote("log", "first line");
    const result = vault.appendNote("log", "second line");
    expect(result.created).toBe(false);
    expect(vault.readNote("log")).toBe("first line\n\nsecond line");
  });

  it("creates on append when missing by default", () => {
    const result = vault.appendNote("fresh", "content");
    expect(result.created).toBe(true);
    expect(vault.readNote("fresh")).toBe("content");
  });

  it("errors on append to missing note when createIfMissing is false", () => {
    expect(() => vault.appendNote("missing", "x", { createIfMissing: false })).toThrowError(
      VaultError,
    );
  });

  it("errors when reading a missing note", () => {
    expect(() => vault.readNote("nope")).toThrowError(VaultError);
  });
});

describe("list and search", () => {
  beforeEach(() => {
    vault.createNote("a", "alpha content");
    vault.createNote("sub/b", "bravo ALPHA content");
    fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
    fs.writeFileSync(path.join(root, ".obsidian/hidden.md"), "alpha", "utf8");
  });

  it("lists notes recursively, skipping dot-folders", () => {
    expect(vault.listNotes()).toEqual(["a.md", "sub/b.md"]);
  });

  it("lists notes under one folder", () => {
    expect(vault.listNotes("sub")).toEqual(["sub/b.md"]);
  });

  it("searches case-insensitively with line info", () => {
    const matches = vault.searchNotes("alpha");
    expect(matches.map((m) => m.path).toSorted()).toEqual(["a.md", "sub/b.md"]);
    expect(matches[0].line).toBe(1);
  });

  it("respects the search limit", () => {
    expect(vault.searchNotes("content", { limit: 1 })).toHaveLength(1);
  });
});

describe("saveConversation", () => {
  const date = new Date("2026-07-11T08:30:00Z");

  it("writes frontmatter and a dated filename", () => {
    const { path: notePath } = vault.saveConversation({
      title: "Obsidian MCP plan",
      content: "## Chat\ndetails",
      date,
    });
    expect(notePath).toMatch(/^Claude\/\d{4}-\d{2}-\d{2} Obsidian MCP plan\.md$/);
    const text = vault.readNote(notePath);
    expect(text).toContain('title: "Obsidian MCP plan"');
    expect(text).toContain("source: claude");
    expect(text).toContain('tags: ["claude", "chat"]');
    expect(text).toContain("## Chat\ndetails");
  });

  it("keeps unicode titles and strips unsafe filename characters", () => {
    const { path: notePath } = vault.saveConversation({
      title: "聊天记录: MCP/Obsidian?",
      content: "x",
      date,
    });
    expect(notePath).toMatch(/聊天记录 MCP Obsidian\.md$/);
  });

  it("dedupes filenames instead of overwriting", () => {
    const first = vault.saveConversation({ title: "Same", content: "1", date });
    const second = vault.saveConversation({ title: "Same", content: "2", date });
    expect(second.path).not.toBe(first.path);
    expect(second.path).toMatch(/ 2\.md$/);
    expect(vault.readNote(first.path)).toContain("1");
    expect(vault.readNote(second.path)).toContain("2");
  });

  it("honors custom folder and tags", () => {
    const { path: notePath } = vault.saveConversation({
      title: "Tagged",
      content: "x",
      folder: "Inbox/Chats",
      tags: ["work"],
      date,
    });
    expect(notePath.startsWith("Inbox/Chats/")).toBe(true);
    expect(vault.readNote(notePath)).toContain('tags: ["work"]');
  });
});
