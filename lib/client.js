// SPDX-License-Identifier: GPL-3.0-or-later
// dsh-qoder-llm — Qoder models as a native DeepSeek Harness LLM provider
// Copyright (C) 2026  Swcmb
// See COPYING for the full license text.
// Qoder 设置页（一级 section）：登录状态、终端登录、插件配置。
// DSH 客户端入口必须使用 __ModuleLoader__ 经典脚本格式，React 由模块表注入。
window.__ModuleLoader__.load({
  id: "dsh-qoder-llm",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const API = "/qoder-llm/api";

    const styles = {
      root: { display: "flex", flexDirection: "column", gap: 18, padding: "4px 2px" },
      row: { display: "flex", flexDirection: "column", gap: 6 },
      label: { fontSize: 12, opacity: 0.75 },
      input: {
        padding: "7px 10px",
        borderRadius: 8,
        border: "1px solid rgba(127,127,127,.35)",
        background: "transparent",
        color: "inherit",
        fontSize: 13,
      },
      actions: { display: "flex", gap: 10, alignItems: "center" },
      button: {
        padding: "7px 14px",
        borderRadius: 8,
        border: "1px solid rgba(127,127,127,.35)",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        fontSize: 13,
      },
      primary: {
        padding: "7px 14px",
        borderRadius: 8,
        border: "1px solid rgba(127,127,127,.35)",
        background: "rgba(77,134,255,.18)",
        color: "inherit",
        cursor: "pointer",
        fontSize: 13,
      },
      status: { fontSize: 13, whiteSpace: "pre-wrap" },
      hint: { fontSize: 12, opacity: 0.65, lineHeight: 1.6 },
      modelList: {
        display: "flex",
        flexDirection: "column",
        gap: 4,
        maxHeight: 220,
        overflowY: "auto",
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid rgba(127,127,127,.35)",
      },
      modelItem: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" },
    };

    function Field({ label, children }) {
      return h("label", { style: styles.row }, h("span", { style: styles.label }, label), children);
    }

    function QoderSection() {
      const [config, setConfig] = React.useState(null);
      const [status, setStatus] = React.useState("loading");
      const [statusText, setStatusText] = React.useState("正在检查登录状态…");
      const [available, setAvailable] = React.useState([]);
      const [selected, setSelected] = React.useState([]);
      const [notice, setNotice] = React.useState("");

      const loadConfig = React.useCallback(async () => {
        const res = await fetch(`${API}/config`);
        const data = await res.json();
        if (data.ok) {
          setConfig(data.config);
          setSelected(data.config.models ?? []);
        }
      }, []);

      const loadStatus = React.useCallback(async () => {
        setStatus("loading");
        setStatusText("正在检查登录状态…");
        try {
          const res = await fetch(`${API}/status`);
          const data = await res.json();
          if (data.ok) {
            setStatus("ok");
            setAvailable(data.models ?? []);
            setStatusText(`已登录。可用模型：${(data.models ?? []).join(", ")}`);
          } else {
            setStatus("error");
            setStatusText(`未登录：${data.error ?? "未知错误"}\n点击“终端登录”完成 OAuth。`);
          }
        } catch (error) {
          setStatus("error");
          setStatusText(`检查失败：${error.message}`);
        }
      }, []);

      React.useEffect(() => {
        loadConfig().catch((error) => setNotice(`读取配置失败：${error.message}`));
        loadStatus();
      }, [loadConfig, loadStatus]);

      const save = async () => {
        if (!config) return;
        if (!selected.length) {
          setNotice("请至少选择一个模型");
          return;
        }
        const patch = {
          authMode: config.authMode,
          tokenEnv: config.tokenEnv,
          models: selected,
          maxSessions: Number(config.maxSessions),
          maxIdleMs: Number(config.maxIdleMs),
          timeoutMs: Number(config.timeoutMs),
        };
        setNotice("正在保存…");
        try {
          const res = await fetch(`${API}/config`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          });
          const data = await res.json();
          setNotice(data.ok ? "已保存，配置即时生效" : `保存失败：${data.error}`);
          if (data.ok) await loadConfig();
        } catch (error) {
          setNotice(`保存失败：${error.message}`);
        }
      };

      const login = async () => {
        setNotice("正在打开终端…");
        try {
          const res = await fetch(`${API}/login`, { method: "POST" });
          const data = await res.json();
          setNotice(data.ok ? data.text : `打开终端失败：${data.error}`);
        } catch (error) {
          setNotice(`打开终端失败：${error.message}`);
        }
      };

      const update = (key) => (event) => setConfig({ ...config, [key]: event.target.value });
      const toggleModel = (name) => () =>
        setSelected((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
      const displayModels = [...new Set([...available, ...selected])];

      return h(
        "div",
        { style: styles.root },
        h("h2", { style: { margin: 0, fontSize: 18 } }, "Qoder"),
        h(
          "div",
          { style: styles.status },
          status === "loading" ? "⏳ " : status === "ok" ? "✅ " : "⚠️ ",
          statusText,
        ),
        h(
          "div",
          { style: styles.actions },
          h("button", { type: "button", style: styles.primary, onClick: login }, "终端登录"),
          h("button", { type: "button", style: styles.button, onClick: loadStatus }, "刷新状态"),
        ),
        config
          ? h(
              "div",
              { style: styles.root },
              h(
                Field,
                { label: "鉴权方式（cli / token）" },
                h(
                  "select",
                  { style: styles.input, value: config.authMode, onChange: update("authMode") },
                  h("option", { value: "cli" }, "cli — 复用本机登录态"),
                  h("option", { value: "token" }, "token — 读取环境变量"),
                ),
              ),
              h(
                Field,
                { label: "Token 环境变量名" },
                h("input", { style: styles.input, value: config.tokenEnv, onChange: update("tokenEnv") }),
              ),
              h(
                "div",
                { style: styles.row },
                h("span", { style: styles.label }, `模型列表（多选，已选 ${selected.length} 个）`),
                h(
                  "div",
                  { style: styles.modelList },
                  displayModels.length === 0
                    ? h("span", { style: styles.hint }, "尚未获取到模型列表，登录后点击“刷新状态”。")
                    : displayModels.map((name) =>
                        h(
                          "label",
                          { key: name, style: styles.modelItem },
                          h("input", {
                            type: "checkbox",
                            checked: selected.includes(name),
                            onChange: toggleModel(name),
                          }),
                          name,
                        ),
                      ),
                ),
              ),
              h(
                Field,
                { label: "最大常驻会话数" },
                h("input", { style: styles.input, type: "number", value: config.maxSessions, onChange: update("maxSessions") }),
              ),
              h(
                Field,
                { label: "空闲回收（毫秒）" },
                h("input", { style: styles.input, type: "number", value: config.maxIdleMs, onChange: update("maxIdleMs") }),
              ),
              h(
                Field,
                { label: "单次请求超时（毫秒）" },
                h("input", { style: styles.input, type: "number", value: config.timeoutMs, onChange: update("timeoutMs") }),
              ),
              h(
                "div",
                { style: styles.actions },
                h("button", { type: "button", style: styles.primary, onClick: save }, "保存"),
                notice ? h("span", { style: styles.hint }, notice) : null,
              ),
              h(
                "p",
                { style: styles.hint },
                "登录后模型出现在 DSH 模型选择器的 Qoder 分组；工具调用、流式输出、推理与图片均由 DSH 原生能力承载。",
              ),
            )
          : h("p", { style: styles.hint }, notice || "正在读取配置…"),
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "qoder",
            order: 20,
            label: () => "Qoder",
          },
          QoderSection,
        ),
      );
    }

    return { inject: ["slots"], apply };
  },
});
