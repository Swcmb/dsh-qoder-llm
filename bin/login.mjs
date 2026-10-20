// SPDX-License-Identifier: GPL-3.0-or-later
// dsh-qoder-llm — Qoder models as a native DeepSeek Harness LLM provider
// Copyright (C) 2026  Swcmb
// See COPYING for the full license text.
// 运行 Qoder 自带 qodercli 的登录流程（OAuth）。无需安装 Qoder 桌面端。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const sdkEntry = require.resolve("@qoder-ai/qoder-agent-sdk");
const worker = join(dirname(sdkEntry), "_worker", "qoder-worker-runtime.obf.mjs");

const child = spawn(process.execPath, [worker, "login"], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
