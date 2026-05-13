---
name: feishu-bridge
description: Use the local Feishu long-connection bridge from Codex. Starts a Feishu event listener, checks runtime status, and sends text messages to Feishu chats through the configured app.
---

# Feishu Bridge

Use the MCP tools exposed by this plugin:

- `feishu_bridge_status`: inspect connection state, counters, and last error.
- `feishu_bridge_start`: start the Feishu long-connection listener.
- `feishu_bridge_stop`: stop the listener.
- `feishu_send_text`: send text to a Feishu `chat_id`.

The listener uses the app credentials from `.env` and receives `im.message.receive_v1` events through the official Feishu/Lark Node SDK `WSClient`.
