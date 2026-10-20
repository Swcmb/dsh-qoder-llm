// SPDX-License-Identifier: GPL-3.0-or-later
// dsh-qoder-llm — Qoder models as a native DeepSeek Harness LLM provider
// Copyright (C) 2026  Swcmb
// See COPYING for the full license text.
// DSH 原生 LLM 适配器：把 DSH 的消息与工具定义交给 Qoder 模型，
// 再把模型输出的结构化工具调用翻译成 DSH 的流事件，由 DSH 执行工具。
// 同一对话复用常驻 Qoder 会话，只发送增量消息。
import { qodercliAuth, accessTokenFromEnv } from "@qoder-ai/qoder-agent-sdk";
import { QoderSession, SessionPool } from "./session.js";

const DEFAULT_MODELS = ["Qwen3.8-Flash", "DeepSeek-Flash"];

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text")
    .map((b) => b.text)
    .join("");
}

function renderMessages(messages) {
  const lines = [];
  for (const m of messages ?? []) {
    if (m.role === "system" || m.role === "developer") continue;
    if (m.role === "user") {
      const t = textOf(m.content);
      if (t) lines.push("User: " + t);
      continue;
    }
    if (m.role === "assistant") {
      const parts = [];
      const t = textOf(m.content);
      if (t) parts.push("Assistant: " + t);
      for (const b of m.content ?? []) {
        if (b && b.type === "tool-call") {
          parts.push("Assistant called tool " + b.name + " (id " + b.id + ") with arguments " + b.arguments);
        }
      }
      if (parts.length) lines.push(parts.join("\n"));
      continue;
    }
    if (m.role === "tool") {
      const t = textOf(m.content);
      lines.push("Tool result " + (m.toolCallId ?? "") + (m.isError ? " (error)" : "") + ": " + t);
    }
  }
  return lines;
}

function toolProtocol(tools) {
  const usable = (tools ?? []).filter((t) => !t.deferLoading);
  if (usable.length === 0) return { text: "", tools: [] };
  const schema = usable.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  return {
    text: [
      "## Tools",
      "You are the model backend of an agent harness. The harness executes tools for you.",
      "When you need a tool, reply with one line of exactly this form and nothing else after it:",
      '<tool_calls>[{"name":"<tool name>","arguments":{ ... }}]</tool_calls>',
      "You may put a short text answer before that line. Never invent tool results.",
      "Available tools (JSON Schema):",
      JSON.stringify(schema),
    ].join("\n"),
    tools: usable,
  };
}

function parseToolCalls(text, knownNames) {
  const m = text.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/i);
  let payload = m && m[1];
  if (!payload) {
    const fence = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/i);
    if (fence) payload = fence[1];
  }
  if (!payload) return { calls: [], text };
  let parsed;
  try {
    parsed = JSON.parse(payload.trim());
  } catch {
    return { calls: [], text };
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.tool_calls) ? parsed.tool_calls : [];
  const calls = [];
  for (const item of list) {
    if (!item || typeof item.name !== "string") continue;
    if (knownNames && knownNames.size > 0 && !knownNames.has(item.name)) continue;
    const rawArgs = item.arguments ?? item.args ?? {};
    calls.push({
      name: item.name,
      arguments: typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs),
    });
  }
  const before = m ? text.slice(0, m.index) : text;
  return { calls, text: before.trim() };
}

function createDeltaQueue() {
  const items = [];
  let resolve = null;
  let ended = false;
  return {
    push(value) {
      if (ended) return;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value, done: false });
      } else {
        items.push(value);
      }
    },
    end() {
      ended = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (items.length) return Promise.resolve({ value: items.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => {
            resolve = r;
          });
        },
      };
    },
  };
}

function lastUserImageRefs(messages) {
  for (let i = (messages ?? []).length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== "user") continue;
    return (m.content ?? [])
      .filter((b) => b && b.type === "image" && b.attachment)
      .map((b) => b.attachment);
  }
  return [];
}

function leadingSystem(messages) {
  const parts = [];
  for (const m of messages ?? []) {
    if (m.role !== "system" && m.role !== "developer") break;
    const t = textOf(m.content);
    if (t) parts.push(t);
  }
  return parts.join("\n\n");
}

export class QoderAdapter {
  constructor(config = {}) {
    this.config = config;
    this.models = config.models && config.models.length ? config.models : DEFAULT_MODELS;
    this.authMode = config.authMode ?? "cli";
    this.tokenEnv = config.tokenEnv ?? "QODER_PERSONAL_ACCESS_TOKEN";
    this.timeoutMs = config.timeoutMs ?? 600000;
    this.resolveImage = config.resolveImage;
    this.pool = new SessionPool({
      maxSessions: config.maxSessions ?? 4,
      maxIdleMs: config.maxIdleMs ?? 300000,
    });
  }

  providerInfo(provider) {
    return { id: provider, name: "Qoder" };
  }

  providerRetryPolicy(_provider) {
    return undefined;
  }

  imageRequestPricing(_provider, _model) {
    return undefined;
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes };
  }

  auth() {
    return this.authMode === "token" ? accessTokenFromEnv(this.tokenEnv) : qodercliAuth();
  }

  async listModels(provider) {
    return this.models.map((id) => ({ provider, id, name: id, inputModalities: this.resolveImage ? ["text", "image"] : ["text"] }));
  }

  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      inputModalities: this.resolveImage ? ["text", "image"] : ["text"],
      context: { contextWindow: 200000 },
    };
  }

  async prepareCall(provider, model) {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options) => this.stream({ ...options, provider, model }),
    };
  }

  sessionFor(model, system, lines) {
    const firstLine = lines[0] ?? "";
    const key = [model, system.length, system.slice(0, 200), firstLine.slice(0, 200)].join("\u0000");
    const existing = this.pool.sessions.get(key);
    if (existing && !existing.expired) {
      const sent = existing.sentLines ?? [];
      const prefixOk = sent.length <= lines.length && sent.every((line, i) => line === lines[i]);
      if (prefixOk) {
        return { session: existing, delta: lines.slice(sent.length).join("\n\n") };
      }
      existing.close();
      this.pool.sessions.delete(key);
    }
    const session = new QoderSession({
      auth: this.auth(),
      model,
      systemPrompt: system,
      maxIdleMs: this.pool.maxIdleMs,
    });
    session.sentLines = [];
    session.key = key;
    this.pool.sessions.set(key, session);
    this.pool.evict();
    return { session, delta: lines.join("\n\n") };
  }

  async *stream(options) {
    const model = options.model ?? this.models[0];
    const proto = toolProtocol(options.tools);
    const tools = proto.tools;
    const known = new Set(tools.map((t) => t.name));
    const system = [options.system, leadingSystem(options.messages), proto.text].filter(Boolean).join(String.fromCharCode(10, 10));
    const lines = renderMessages(options.messages);

    const events = createDeltaQueue();
    let picked;
    try {
      picked = this.sessionFor(model, system, lines);
      const images = [];
      if (this.resolveImage) {
        for (const ref of lastUserImageRefs(options.messages)) {
          try {
            const resolved = await this.resolveImage(ref);
            if (resolved && resolved.base64) images.push(resolved);
          } catch {}
        }
      }
      const pending = picked.session.ask(
        picked.delta || "(empty)",
        this.timeoutMs,
        {
          onDelta: (t) => events.push({ kind: "text", text: t }),
          onThinking: (t) => events.push({ kind: "reasoning", text: t }),
        },
        images,
      );
      pending.then(() => events.end(), () => events.end());

      let index = 0;
      let current = null;
      let acc = "";
      let textSeen = "";
      let suppressed = false;
      for await (const ev of events) {
        if (ev.kind === "text") {
          if (suppressed) continue;
          if (/<tool_calls>/i.test(textSeen + ev.text)) {
            suppressed = true;
            continue;
          }
          textSeen += ev.text;
        }
        if (current !== ev.kind) {
          if (current) {
            yield { type: "block-end", index, block: current === "reasoning" ? { type: "reasoning", text: acc } : { type: "text", text: acc } };
            index += 1;
            acc = "";
          }
          yield { type: "block-start", index, blockType: ev.kind === "reasoning" ? "reasoning" : "text" };
          current = ev.kind;
        }
        acc += ev.text;
        yield { type: ev.kind === "reasoning" ? "reasoning-delta" : "text-delta", index, text: ev.text };
      }
      if (current) {
        yield { type: "block-end", index, block: current === "reasoning" ? { type: "reasoning", text: acc } : { type: "text", text: acc } };
        index += 1;
      }

      const answer = await pending;
      picked.session.sentLines = lines;
      picked.session.lastUsed = Date.now();

      const parsed = parseToolCalls(answer, known);
      const calls = parsed.calls;
      if (index === 0 && parsed.text) {
        yield { type: "block-start", index, blockType: "text" };
        yield { type: "text-delta", index, text: parsed.text };
        yield { type: "block-end", index, block: { type: "text", text: parsed.text } };
        index += 1;
      }
      for (const call of calls) {
        const id = "call_" + Math.random().toString(36).slice(2, 12);
        yield { type: "block-start", index, blockType: "tool-call" };
        yield { type: "tool-call-delta", index, id, name: call.name, argumentsDelta: call.arguments };
        yield { type: "block-end", index, block: { type: "tool-call", id, name: call.name, arguments: call.arguments } };
        index += 1;
      }

      if (calls.length === 0 && !process.versions.electron) {
        const s = picked.session;
        const key = s.key;
        const timer = setTimeout(() => {
          s.close();
          this.pool.sessions.delete(key);
        }, 2000);
        timer.unref?.();
      }

      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      yield { type: "finish", reason: { kind: calls.length > 0 ? "tool-calls" : "stop" } };
    } catch (error) {
      if (picked && picked.session) {
        try {
          picked.session.close();
          this.pool.sessions.delete(picked.session.key);
        } catch {}
      }
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
      yield {
        type: "finish",
        reason: { kind: "error", failure: { message: error && error.message ? error.message : String(error), code: "QODER_ERROR" } },
      };
      return;
    }
  }

  reconfigure(next) {
    if (next.models && next.models.length) this.models = next.models;
    if (next.authMode) this.authMode = next.authMode;
    if (next.tokenEnv) this.tokenEnv = next.tokenEnv;
    if (next.timeoutMs) this.timeoutMs = next.timeoutMs;
    if (next.maxSessions) this.pool.maxSessions = next.maxSessions;
    if (next.maxIdleMs) this.pool.maxIdleMs = next.maxIdleMs;
    this.pool.clear();
  }

  dispose() {
    this.pool.clear();
  }
}
