/**
 * lsp-client.ts — Minimal LSP client for typescript-language-server
 *
 * Communicates over stdin/stdout using JSON-RPC 2.0 with Content-Length
 * header framing. No external dependencies — built entirely on Node.js
 * child_process, stream, and Buffer.
 *
 * Lifecycle:
 *   client.start(rootDir)     → spawn server, initialize, wait for ready
 *   client.openDocument(uri, text)  → register file with server
 *   client.goToDefinition(uri, line, char) → textDocument/definition
 *   client.shutdown()         → graceful shutdown
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Writable } from "node:stream";

// ── LSP Protocol Types (minimal) ─────────────────────────

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

// ── JSON-RPC Message Framing ─────────────────────────────

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class LspClient {
  private process: ChildProcess | null = null;
  private writer: Writable | null = null;
  private requestId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private buffer = "";
  private ready = false;
  private rootDir = "";
  private timeout: number;
  private serverPath: string;

  constructor(options?: { timeout?: number; serverPath?: string }) {
    this.timeout = options?.timeout ?? 30000;
    this.serverPath = options?.serverPath ?? "typescript-language-server";
  }

  // ── Public API ─────────────────────────────────────────

  /** Start the LSP server. Resolves when initialized. */
  start(rootDir: string): Promise<void> {
    if (this.process) return Promise.resolve();

    this.rootDir = rootDir;
    const args = ["--stdio"];

    return new Promise((resolve, reject) => {
      const proc = spawn(this.serverPath, args, {
        cwd: rootDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      this.process = proc;
      this.writer = proc.stdin!;
      this.buffer = "";

      proc.on("error", (err) => {
        this.process = null;
        this.writer = null;
        this.ready = false;
        reject(err);
      });

      proc.on("exit", (code) => {
        this.rejectAll(new Error(`LSP server exited with code ${code}`));
        this.process = null;
        this.writer = null;
        this.ready = false;
      });

      proc.stderr!.on("data", (data: Buffer) => {
        // typescript-language-server logs to stderr — ignore in normal operation
      });

      // Raw byte reader for JSON-RPC Content-Length framing
      let buffer = Buffer.alloc(0);
      proc.stdout!.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const headerEnd = buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) break;
          const header = buffer.slice(0, headerEnd).toString("utf-8");
          const match = header.match(/Content-Length:\s*(\d+)/i);
          if (!match) break;
          const contentLength = parseInt(match[1], 10);
          const messageStart = headerEnd + 4;
          if (buffer.length < messageStart + contentLength) break;
          const body = buffer.slice(messageStart, messageStart + contentLength).toString("utf-8");
          buffer = buffer.slice(messageStart + contentLength);
          this.dispatchMessage(body);
        }
      });

      this.initialize().then(resolve).catch((err) => {
        proc.kill();
        this.process = null;
        this.writer = null;
        reject(err);
      });
    });
  }

  /** Register a document with the server so it can resolve definitions in it. */
  openDocument(uri: string, text: string, languageId = "typescript"): void {
    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text,
      },
    });
  }

  /** Request the definition location of a symbol at the given position. */
  async goToDefinition(uri: string, line: number, character: number): Promise<Location[]> {
    const result = await this.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });

    if (!result) return [];
    if (Array.isArray(result)) return result as Location[];
    // LSP spec allows a single Location
    return [result as Location];
  }

  /** Graceful shutdown. */
  async shutdown(): Promise<void> {
    if (!this.process) return;
    try {
      await this.sendRequest("shutdown", {});
    } catch {
      // Ignore shutdown errors
    }
    this.sendNotification("exit", {});
    this.process.kill();
    this.process = null;
    this.ready = false;
  }

  get isReady(): boolean {
    return this.ready;
  }

  // ── JSON-RPC Framing ───────────────────────────────────

  private dispatchMessage(raw: string): void {
    let msg: { id?: number | string; method?: string; result?: unknown; error?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Response to a request
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Notification or server→client request — ignore for now
  }

  private sendNotification(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.requestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request ${method} timed out after ${this.timeout}ms`));
      }, this.timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private write(message: Record<string, unknown>): void {
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n`;
    this.writer?.write(header + json);
  }

  private async initialize(): Promise<void> {
    const result = (await this.sendRequest("initialize", {
      processId: process.pid,
      rootUri: `file://${this.rootDir}`,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: true },
        },
      },
    })) as { capabilities: Record<string, unknown> } | undefined;

    if (!result) {
      throw new Error("LSP initialize returned no result");
    }

    this.sendNotification("initialized", {});
    this.ready = true;
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
