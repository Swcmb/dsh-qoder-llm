// SPDX-License-Identifier: GPL-3.0-or-later
// dsh-qoder-llm — Qoder models as a native DeepSeek Harness LLM provider
// Copyright (C) 2026  Swcmb
// See COPYING for the full license text.
// 把 Qoder 模型注册为 DSH 的原生 LLM 提供方（provider: qoder）。
// 工具调用由适配器翻译成 DSH 的 tool-call 事件，交给 DSH 执行。
// 设置项由 Config schema 暴露；未登录时可用 /qoder-login 在终端完成登录。
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { QoderAdapter } from "./adapter.js";

export const name = "dsh-qoder-llm";
export const inject = ["llm", "commands", "webServer"];

export const Config = z.object({
  authMode: z.union([z.const("cli"), z.const("token")]).default("cli"),
  tokenEnv: z.string().default("QODER_PERSONAL_ACCESS_TOKEN"),
  models: z.array(z.string()).default(["Qwen3.8-Flash", "DeepSeek-Flash"]),
  maxSessions: z.number().default(4),
  maxIdleMs: z.number().default(300000),
  timeoutMs: z.number().default(600000),
}).volatile();

const require = createRequire(import.meta.url);

function workerPath() {
  const entry = require.resolve("@qoder-ai/qoder-agent-sdk");
  return join(dirname(entry), "_worker", "qoder-worker-runtime.obf.mjs");
}

function loginScript() {
  return fileURLToPath(new URL("../bin/login.mjs", import.meta.url));
}

function runModels(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [workerPath(), "--list-models"],
      { timeout: timeoutMs, windowsHide: true, encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
      (error, stdout, stderr) => {
        if (error) reject(new Error((stderr || error.message || "").trim()));
        else resolve(String(stdout).trim());
      },
    );
  });
}

function launchLoginTerminal() {
  const script = loginScript();
  if (process.platform === "win32") {
    const inner = `set ELECTRON_RUN_AS_NODE=1&&"${process.execPath}" "${script}"`;
    const child = spawn("cmd.exe", ["/c", "start", "", "cmd.exe", "/k", inner], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return `已打开终端窗口执行 Qoder 登录：${inner}`;
  }
  const child = spawn(process.execPath, [script], { detached: true, stdio: "ignore" });
  child.unref();
  return `已在终端启动 Qoder 登录：${process.execPath} ${script}`;
}

export function apply(ctx, config = {}) {
  const settings = {
    authMode: config.authMode ?? "cli",
    tokenEnv: config.tokenEnv ?? "QODER_PERSONAL_ACCESS_TOKEN",
    models: config.models && config.models.length ? config.models : ["Qwen3.8-Flash", "DeepSeek-Flash"],
    maxSessions: config.maxSessions ?? 4,
    maxIdleMs: config.maxIdleMs ?? 300000,
    timeoutMs: config.timeoutMs ?? 600000,
  };

  const attachments = typeof ctx.get === "function" ? ctx.get("attachments") : undefined;
  const resolveImage =
    attachments && typeof attachments.imageHostPath === "function"
      ? async (ref) => {
          const hostPath = attachments.imageHostPath(ref);
          if (hostPath === undefined) return undefined;
          const bytes = await readFile(hostPath);
          return { mediaType: ref.mediaType ?? "image/png", base64: bytes.toString("base64") };
        }
      : undefined;

  const liveSettings = { ...settings };
  const adapter = new QoderAdapter({ ...settings, resolveImage });
  ctx.llm.registerAdapter(["qoder"], adapter);
  console.log(`[dsh-qoder-llm] provider qoder registered (${adapter.models.join(", ")})`);

  ctx.commands.register({
    definitionId: "dsh-qoder-llm/login",
    name: "qoder-login",
    description: "Open a terminal window and sign in to Qoder",
    handler: () => ({ kind: "success", text: launchLoginTerminal() }),
  });

  ctx.commands.register({
    definitionId: "dsh-qoder-llm/status",
    name: "qoder-status",
    description: "Show Qoder login status and available models",
    handler: async () => {
      try {
        const text = await runModels();
        return { kind: "success", text: `Qoder 已登录。可用模型：\n${text}` };
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        return {
          kind: "error",
          text: `Qoder 未登录或无法读取模型：${message}\n在 DSH 输入 /qoder-login 打开终端登录，或运行：\nnode "${loginScript()}"`,
        };
      }
    },
  });

  const webServer = typeof ctx.get === "function" ? ctx.get("webServer") : undefined;
  if (webServer && typeof webServer.register === "function") {
    const readBody = (req) =>
      new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (c) => {
          size += c.length;
          if (size > 65536) {
            reject(new Error("body too large"));
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
      });
    const send = (res, code, value) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    ctx.effect(() =>
      webServer.register({
        kind: "prefix",
        path: "/qoder-llm/api",
        handler: async (req, res) => {
          const url = new URL(req.url, "http://localhost");
          const method = (url.pathname.replace(/^\/qoder-llm\/api\/?/, "") || "").replace(/\/+$/, "");
          try {
            if (method === "status" && req.method === "GET") {
              try {
                const text = await runModels();
                const models = text.split(String.fromCharCode(10)).filter((line) => line && !/^MODEL/i.test(line));
                send(res, 200, { ok: true, models });
              } catch (error) {
                send(res, 200, { ok: false, error: error && error.message ? error.message : String(error) });
              }
              return;
            }
            if (method === "login" && req.method === "POST") {
              send(res, 200, { ok: true, text: launchLoginTerminal() });
              return;
            }
            if (method === "config" && req.method === "GET") {
              send(res, 200, { ok: true, config: liveSettings });
              return;
            }
            if (method === "config" && req.method === "POST") {
              const raw = await readBody(req);
              const patch = JSON.parse(raw || "{}");
              const svc = typeof ctx.get === "function" ? ctx.get("settings") : undefined;
              if (!svc || typeof svc.describe !== "function") {
                send(res, 500, { ok: false, error: "settings service unavailable" });
                return;
              }
              const forms = await svc.describe({});
              const entry = (forms ?? []).find((f) => f.ns === "qoder-llm");
              const revision = entry ? entry.revision : undefined;
              Object.assign(liveSettings, patch);
              adapter.reconfigure(liveSettings);
              try {
                await svc.update("qoder-llm", patch, revision);
              } catch (persistError) {
                send(res, 200, { ok: true, warning: persistError && persistError.message ? persistError.message : String(persistError) });
                return;
              }
              send(res, 200, { ok: true });
              return;
            }
            send(res, 404, { ok: false, error: "no such route" });
          } catch (error) {
            send(res, 500, { ok: false, error: error && error.message ? error.message : String(error) });
          }
        },
      }),
    );
  }

  const settingsService = typeof ctx.get === "function" ? ctx.get("settings") : undefined;
  try {
    settingsService?.configure?.({ auto: false });
  } catch {}
  if (settingsService && typeof settingsService.describe === "function") {
    setTimeout(async () => {
      try {
        const forms = await settingsService.describe({});
        const names = (forms ?? []).map((f) => f.ns);
        console.log("[dsh-qoder-llm] settings entries include qoder-llm:", names.includes("qoder-llm"), "count:", names.length);
        console.log("[dsh-qoder-llm] fiber state:", ctx.fiber?.state, "runtime.Config:", typeof ctx.fiber?.runtime?.Config);
      } catch (error) {
        console.log("[dsh-qoder-llm] settings probe failed:", error && error.message ? error.message : String(error));
      }
    }, 8000);
  }

  runModels()
    .then((text) => console.log(`[dsh-qoder-llm] 已登录，可用模型：${text.replace(/\s+/g, " ").trim()}`))
    .catch((error) => {
      console.log(
        `[dsh-qoder-llm] 未登录（${error && error.message ? error.message.split(String.fromCharCode(10))[0] : "auth check failed"}）。在 DSH 输入 /qoder-login 打开终端登录，或运行 node "${loginScript()}"`,
      );
    });
}

export default { name, inject, Config, apply };
