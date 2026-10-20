# dsh-qoder-llm

把 Qoder 的模型接入 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai)，注册为原生 LLM provider `qoder`。
插件通过 `@qoder-ai/qoder-agent-sdk` 调用模型，SDK 自带 `qodercli` 运行时，**无需安装 Qoder 桌面端**。

## 功能

- Qoder 模型出现在 DSH 模型选择器的 Qoder 分组。
- 工具调用：把 DSH 工具 schema 注入提示词，模型返回的结构化调用翻译成 DSH 原生 `tool-call` 事件，由 DSH 执行工具并回填结果。
- 流式文本与 reasoning 增量。
- 图片输入：读取最近一条用户消息的图片附件，以 base64 交给 SDK。
- 常驻会话：同一对话复用 Qoder worker；DSH 桌面端空闲 5 分钟回收，CLI/headless 在最终回答后关闭。
- 设置页：终端登录、登录状态刷新、从账号可用模型多选需要暴露的模型。

## 要求

- DSH `0.2.1-rc.2` 或兼容版本
- Node.js >= 18
- Qoder 账号（OAuth 登录），或 `QODER_PERSONAL_ACCESS_TOKEN`

## 安装

在 DSH profile（例如 `~/.dsh/profiles/desktop`）中：

1. 依赖加入 `dsh-qoder-llm`：

   ```json
   "dependencies": {
     "dsh-qoder-llm": "^0.1.0"
   }
   ```

2. `dsh.profile.bundles` 加入 `dsh-qoder-llm`。
3. 在 profile 目录安装依赖，重启 DSH。

插件包自带 `cordis.patch.yml`，bundle 会自动插入 `qoder-llm` 插件行，无需手写 provider 配置。

## 登录

- 设置 → **Qoder** → 「终端登录」，在打开的终端完成 OAuth。
- 或在 DSH 输入 `/qoder-login`。
- `/qoder-status` 或设置页「刷新状态」读取登录状态与可用模型。

登录信息保存在 `~/.qoder/.auth`，与 Qoder CLI 共用。
token 模式：设置环境变量（默认 `QODER_PERSONAL_ACCESS_TOKEN`），并把设置页鉴权方式改为 `token`。

## 设置

DSH 设置中的一级「Qoder」页：

| 字段 | 默认 | 说明 |
|---|---|---|
| 鉴权方式 | `cli` | `cli` 复用本机登录态；`token` 读取环境变量 |
| Token 环境变量名 | `QODER_PERSONAL_ACCESS_TOKEN` | token 模式下使用 |
| 模型列表 | 账号可用模型 | 从 Qoder 拉取，复选框多选 |
| 最大常驻会话数 | `4` | 会话池上限 |
| 空闲回收（毫秒） | `300000` | 超时回收 worker |
| 单次请求超时（毫秒） | `600000` | 单次请求超时 |

保存后适配器热重建，无需重启 DSH。

## 工作原理

- `ctx.llm.registerAdapter(["qoder"], adapter)` 注册原生适配器。
- `prepareCall` 注入工具协议；模型按
  `<tool_calls>[{"name":"...","arguments":{...}}]</tool_calls>` 回复，
  适配器转换为 DSH 的 `tool-call-delta` / `block-end` 事件。
- 同一对话按模型与系统提示复用 `QoderSession`，只向 worker 追加增量消息。
- 设置页通过宿主路由 `/qoder-llm/api/{status,config,login}` 访问登录状态与配置。

## 目录

```
lib/index.js      Cordis 插件入口：provider 注册、设置路由、命令
lib/adapter.js    DSH LLM 适配器：流、工具调用、图片
lib/session.js    Qoder 会话池
lib/client.js     设置页（__ModuleLoader__ 经典脚本）
bin/login.mjs     OAuth 登录
bin/status.mjs    登录状态与模型列表
cordis.patch.yml  bundle 补丁
```

## 限制

- Qoder SDK 不暴露裸模型 API，首字延迟高于原生提供方；常驻会话已消除重复进程启动。
- 工具调用依赖文本协议，模型未按格式输出时该轮按普通文本处理。

## 开发验证

```bash
node bin/status.mjs   # 登录状态与可用模型
```

## License

GPL-3.0-or-later，见 [COPYING](COPYING)。
