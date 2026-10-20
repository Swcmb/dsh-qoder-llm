// SPDX-License-Identifier: GPL-3.0-or-later
// dsh-qoder-llm — Qoder models as a native DeepSeek Harness LLM provider
// Copyright (C) 2026  Swcmb
// See COPYING for the full license text.
// 常驻 Qoder 会话：同一对话只启动一次 worker，后续轮次发送增量消息。
import { query } from "@qoder-ai/qoder-agent-sdk";

function createChannel() {
  const queue = [];
  let resolve = null;
  let done = false;
  return {
    push(msg) {
      if (done) return;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },
    end() {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => {
            resolve = r;
          });
        },
      };
    },
  };
}

export class QoderSession {
  constructor({ auth, model, systemPrompt, maxIdleMs = 300000 }) {
    this.model = model;
    this.channel = createChannel();
    this.text = "";
    this.pending = null;
    this.dead = false;
    this.lastUsed = Date.now();
    this.maxIdleMs = maxIdleMs;

    this.query = query({
      prompt: this.channel,
      options: {
        auth,
        model,
        systemPrompt: systemPrompt || undefined,
        maxTurns: 1000,
        allowedTools: [],
        tools: [],
        permissionMode: "acceptEdits",
        includePartialMessages: true,
        settingSources: [],
        skills: [],
        extensions: [],
      },
    });

    this.consumer = (async () => {
      try {
        for await (const msg of this.query) {
          if (msg.type === "stream_event") {
            const ev = msg.event;
            if (ev && ev.type === "content_block_delta" && ev.delta) {
              try {
                if (ev.delta.type === "text_delta" && ev.delta.text) {
                  this.pending && this.pending.onDelta && this.pending.onDelta(ev.delta.text);
                } else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
                  this.pending && this.pending.onThinking && this.pending.onThinking(ev.delta.thinking);
                }
              } catch {}
            }
            continue;
          }
          if (msg.type === "assistant") {
            for (const b of msg.message?.content ?? []) {
              if (b?.type === "text") this.text += b.text;
            }
          } else if (msg.type === "result") {
            const text = this.text;
            this.text = "";
            const p = this.pending;
            this.pending = null;
            if (p) {
              if (msg.subtype === "success") p.resolve(text);
              else p.reject(new Error(Array.isArray(msg.errors) ? msg.errors.join("; ") : msg.subtype));
            }
          }
        }
        this.dead = true;
        this.failPending(new Error("qoder session ended"));
      } catch (error) {
        this.dead = true;
        this.failPending(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  }

  failPending(error) {
    const p = this.pending;
    this.pending = null;
    if (p) p.reject(error);
  }

  get expired() {
    return this.dead || Date.now() - this.lastUsed > this.maxIdleMs;
  }

  async ask(text, timeoutMs = 600000, callbacks = {}, images = []) {
    if (this.dead) throw new Error("qoder session is closed");
    if (this.pending) throw new Error("qoder session is busy");
    this.lastUsed = Date.now();
    const answer = new Promise((resolve, reject) => {
      this.pending = { resolve, reject, onDelta: callbacks.onDelta, onThinking: callbacks.onThinking };
      const timer = setTimeout(() => {
        this.failPending(new Error("qoder session timed out"));
        this.close();
      }, timeoutMs);
      timer.unref?.();
      const wrap = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.resolve = wrap(resolve);
      this.pending.reject = wrap(reject);
    });
    const content = [{ type: "text", text }];
    for (const img of images) {
      if (!img || !img.base64) continue;
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType || "image/png", data: img.base64 },
      });
    }
    this.channel.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
    return answer;
  }

  close() {
    this.dead = true;
    try {
      this.channel.end();
    } catch {}
    try {
      this.query.close();
    } catch {}
  }
}

export class SessionPool {
  constructor({ maxSessions = 4, maxIdleMs = 300000 } = {}) {
    this.maxSessions = maxSessions;
    this.maxIdleMs = maxIdleMs;
    this.sessions = new Map();
  }

  acquire(key, factory) {
    const existing = this.sessions.get(key);
    if (existing && !existing.expired) return existing;
    if (existing) {
      existing.close();
      this.sessions.delete(key);
    }
    const session = factory();
    session.maxIdleMs = this.maxIdleMs;
    this.sessions.set(key, session);
    this.evict();
    return session;
  }

  evict() {
    if (this.sessions.size <= this.maxSessions) return;
    const oldest = [...this.sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, session] of oldest.slice(0, this.sessions.size - this.maxSessions)) {
      session.close();
      this.sessions.delete(key);
    }
  }

  clear() {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
