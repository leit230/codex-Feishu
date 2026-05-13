# codex-Feishu

飞书长连接桥接插件：接收飞书消息，通过本地 Codex CLI 处理后，将结果回传到原消息线程。插件同时提供 MCP 服务，安装/启用后 Codex 可以直接查看状态、启动/停止监听器，并向指定 `chat_id` 发送文本。

## 功能
- 使用飞书官方 `@larksuiteoapi/node-sdk` 的 `WSClient` 长连接事件订阅
- 支持 MCP stdio 入口，可作为 Codex 插件启用
- 事件回调快速返回，后台异步执行 Codex 后回复，避免触发飞书 3 秒超时重推
- 将飞书消息转为 Codex 输入并回复结果

## 配置
复制 `.env.example` 为 `.env`，并填写：
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

可选项：
- `FEISHU_BRIDGE_PORT`
- `FEISHU_USE_WS`
- `FEISHU_MCP_AUTO_START`
- `FEISHU_TRIGGER_PREFIX`
- `FEISHU_DOWNLOAD_DIR`
- `FEISHU_MAX_INLINE_FILE_BYTES`
- `CODEX_COMMAND`
- `CODEX_ARGS`
- `CODEX_CWD`
- `CODEX_OUTPUT_DIRS`
- `CODEX_TIMEOUT_MS`

默认 `CODEX_ARGS`：
```bash
exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ignore-rules
```

默认 `FEISHU_REPLY_IN_THREAD=false`，会作为普通消息回复，不创建话题回复。

图片和常见文件会下载到 `FEISHU_DOWNLOAD_DIR`。图片会作为 `localImage` 传给 Codex；常见文本文件会在不超过 `FEISHU_MAX_INLINE_FILE_BYTES` 时内联到 prompt；其他文件会把本地路径交给 Codex。

Codex 回复中出现 `CODEX_OUTPUT_DIRS` 下的本地文件路径时，插件会自动上传并回复到飞书。图片会用飞书图片消息发送，其他文件会用飞书文件消息发送。

默认 `CODEX_MODE=app-server`，插件会启动一个常驻 `codex app-server` 后台会话，飞书消息直接进入同一个 thread。`CODEX_SESSION_TTL_MS=3600000` 表示 1 小时内没有新输入或回复后关闭后台会话，下一条消息会自动创建新会话。

飞书内可发送模型命令：
```text
/model
/model list
/model gpt-5.4
切换模型 gpt-5.4
```

切换模型会保留当前常驻会话，下一条普通消息会在原对话中使用新模型。可在 `.env` 里用 `CODEX_MODEL=` 设置启动默认模型。

如需回退到每条消息调用一次 CLI，可设置：
```bash
CODEX_MODE=exec
```

## 启动
```bash
npm start
```

MCP 模式：
```bash
npm run mcp
```

## 飞书控制台
1. 在飞书开放平台创建应用并开通机器人能力。
2. 配置事件订阅，按官方长连接文档开启长连接，并订阅 `im.message.receive_v1`。
3. 把应用安装到目标租户并完成权限授权。
4. 在群聊或私聊中给机器人发消息，即可触发 Codex 处理。

## 说明
- 默认会使用长连接模式。
- Codex 插件入口是 `.mcp.json` 中的 `feishu-bridge` MCP server。
- `bridge_server.py` 仅作为旧入口兼容占位。
