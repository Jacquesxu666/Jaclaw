import fs from "node:fs";
import path from "node:path";

export type VaultErrorCode = "invalid-path" | "not-found" | "already-exists";

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

export type SearchMatch = {
  path: string;
  line: number;
  snippet: string;
};

export type SaveConversationParams = {
  title: string;
  content: string;
  folder?: string;
  tags?: string[];
  /** Injected clock for tests; defaults to now. */
  date?: Date;
};

const DEFAULT_CONVERSATION_FOLDER = "Claude";
const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_TITLE_FILENAME_LENGTH = 80;

/** Characters Obsidian (and common filesystems) reject or mangle in note names. */
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|#^[\]]/g;

function toYamlString(value: string): string {
  // JSON string escaping is valid YAML for double-quoted scalars.
  return JSON.stringify(value);
}

function formatDateStamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Plain-folder Obsidian vault accessor with path traversal protection. */
export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /**
   * Resolve a vault-relative note path to an absolute path.
   * Appends `.md` when missing, rejects escapes and dot-directories
   * (`.obsidian`, `.git`, ...).
   */
  resolveNote(relPath: string): string {
    const withExtension = relPath.endsWith(".md") ? relPath : `${relPath}.md`;
    return this.resolveInside(withExtension);
  }

  resolveFolder(relPath: string): string {
    if (relPath === "" || relPath === ".") {
      return this.root;
    }
    return this.resolveInside(relPath);
  }

  private resolveInside(relPath: string): string {
    if (path.isAbsolute(relPath)) {
      throw new VaultError("invalid-path", `path must be vault-relative: ${relPath}`);
    }
    const normalized = path.normalize(relPath);
    const segments = normalized.split(path.sep);
    if (segments.some((segment) => segment === ".." || segment.startsWith("."))) {
      throw new VaultError(
        "invalid-path",
        `path may not escape the vault or touch dot-folders: ${relPath}`,
      );
    }
    return path.join(this.root, normalized);
  }

  private toVaultRelative(absPath: string): string {
    return path.relative(this.root, absPath).split(path.sep).join("/");
  }

  createNote(
    relPath: string,
    content: string,
    opts: { overwrite?: boolean } = {},
  ): {
    path: string;
  } {
    const abs = this.resolveNote(relPath);
    if (!opts.overwrite && fs.existsSync(abs)) {
      throw new VaultError("already-exists", `note already exists: ${this.toVaultRelative(abs)}`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    return { path: this.toVaultRelative(abs) };
  }

  appendNote(
    relPath: string,
    content: string,
    opts: { createIfMissing?: boolean } = {},
  ): { path: string; created: boolean } {
    const abs = this.resolveNote(relPath);
    const exists = fs.existsSync(abs);
    if (!exists && !(opts.createIfMissing ?? true)) {
      throw new VaultError("not-found", `note not found: ${this.toVaultRelative(abs)}`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!exists) {
      fs.writeFileSync(abs, content, "utf8");
      return { path: this.toVaultRelative(abs), created: true };
    }
    const existing = fs.readFileSync(abs, "utf8");
    const separator = existing === "" || existing.endsWith("\n") ? "\n" : "\n\n";
    fs.appendFileSync(abs, `${separator}${content}`, "utf8");
    return { path: this.toVaultRelative(abs), created: false };
  }

  readNote(relPath: string): string {
    const abs = this.resolveNote(relPath);
    if (!fs.existsSync(abs)) {
      throw new VaultError("not-found", `note not found: ${this.toVaultRelative(abs)}`);
    }
    return fs.readFileSync(abs, "utf8");
  }

  listNotes(folder = "", opts: { limit?: number } = {}): string[] {
    const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
    const base = this.resolveFolder(folder);
    if (!fs.existsSync(base)) {
      throw new VaultError("not-found", `folder not found: ${folder || "."}`);
    }
    const results: string[] = [];
    this.walkNotes(base, (abs) => {
      results.push(this.toVaultRelative(abs));
      return results.length < limit;
    });
    return results.toSorted();
  }

  searchNotes(query: string, opts: { folder?: string; limit?: number } = {}): SearchMatch[] {
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
    const base = this.resolveFolder(opts.folder ?? "");
    if (!fs.existsSync(base)) {
      throw new VaultError("not-found", `folder not found: ${opts.folder ?? "."}`);
    }
    const needle = query.toLowerCase();
    const matches: SearchMatch[] = [];
    this.walkNotes(base, (abs) => {
      const lines = fs.readFileSync(abs, "utf8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({
            path: this.toVaultRelative(abs),
            line: i + 1,
            snippet: lines[i].trim().slice(0, 200),
          });
          if (matches.length >= limit) {
            return false;
          }
        }
      }
      return true;
    });
    return matches;
  }

  /**
   * Save a conversation transcript as a new dated note with YAML frontmatter.
   * Filenames dedupe with a numeric suffix instead of overwriting.
   */
  saveConversation(params: SaveConversationParams): { path: string } {
    const date = params.date ?? new Date();
    const folder = params.folder ?? DEFAULT_CONVERSATION_FOLDER;
    const tags = params.tags && params.tags.length > 0 ? params.tags : ["claude", "chat"];
    const safeTitle =
      params.title
        .replace(UNSAFE_FILENAME_CHARS, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_TITLE_FILENAME_LENGTH) || "Untitled conversation";
    const stamp = formatDateStamp(date);

    let candidate = `${folder}/${stamp} ${safeTitle}`;
    let counter = 2;
    while (fs.existsSync(this.resolveNote(candidate))) {
      candidate = `${folder}/${stamp} ${safeTitle} ${counter}`;
      counter += 1;
    }

    const frontmatter = [
      "---",
      `title: ${toYamlString(params.title)}`,
      `date: ${date.toISOString()}`,
      "source: claude",
      `tags: [${tags.map(toYamlString).join(", ")}]`,
      "---",
      "",
    ].join("\n");
    const body = params.content.endsWith("\n") ? params.content : `${params.content}\n`;
    return this.createNote(candidate, `${frontmatter}\n${body}`);
  }

  /** Depth-first walk over `.md` files, skipping dot-directories. Callback returns false to stop. */
  private walkNotes(baseAbs: string, visit: (absPath: string) => boolean): void {
    const stack: string[] = [baseAbs];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) {
        return;
      }
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .toSorted((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(abs);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          if (!visit(abs)) {
            return;
          }
        }
      }
    }
  }
}
