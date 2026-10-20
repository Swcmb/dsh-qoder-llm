// SPDX-License-Identifier: GPL-3.0-or-later
// dsh-qoder-llm — Qoder models as a native DeepSeek Harness LLM provider
// Copyright (C) 2026  Swcmb
// See COPYING for the full license text.
// 查看当前 Qoder 登录状态与可用模型。
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const sdkEntry = require.resolve("@qoder-ai/qoder-agent-sdk");
const worker = join(dirname(sdkEntry), "_worker", "qoder-worker-runtime.obf.mjs");

const result = spawnSync(process.execPath, [worker, "--list-models"], { encoding: "utf8" });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
