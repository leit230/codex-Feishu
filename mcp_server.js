require('dotenv').config({ path: `${__dirname}/.env` });

const { FeishuBridge } = require('./feishu_bridge');

const AUTO_START = String(process.env.FEISHU_MCP_AUTO_START || 'true').toLowerCase() !== 'false';
const bridge = new FeishuBridge();

let inputBuffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolText(payload) {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function callTool(name, args = {}) {
  if (name === 'feishu_bridge_start') {
    return toolText(await bridge.start());
  }
  if (name === 'feishu_bridge_stop') {
    return toolText(bridge.stop());
  }
  if (name === 'feishu_bridge_status') {
    return toolText(bridge.status());
  }
  if (name === 'feishu_send_text') {
    if (!args.chat_id || !args.text) {
      throw new Error('chat_id and text are required');
    }
    return toolText(await bridge.sendTextToChat(args.chat_id, args.text));
  }
  throw new Error(`Unknown tool: ${name}`);
}

function tools() {
  return [
    {
      name: 'feishu_bridge_start',
      description: 'Start the Feishu long-connection event listener.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'feishu_bridge_stop',
      description: 'Stop the Feishu long-connection event listener.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'feishu_bridge_status',
      description: 'Return Feishu bridge runtime status and counters.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'feishu_send_text',
      description: 'Send a plain text message to a Feishu chat_id.',
      inputSchema: {
        type: 'object',
        required: ['chat_id', 'text'],
        properties: {
          chat_id: { type: 'string' },
          text: { type: 'string' },
        },
      },
    },
  ];
}

async function handleRequest(message) {
  const { id, method, params } = message;
  try {
    if (method === 'initialize') {
      result(id, {
        protocolVersion: params && params.protocolVersion ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'feishu-bridge', version: '1.0.0' },
      });
      if (AUTO_START) {
        bridge.start().catch((err) => bridge.recordError(err));
      }
      return;
    }
    if (method === 'tools/list') {
      result(id, { tools: tools() });
      return;
    }
    if (method === 'tools/call') {
      result(id, await callTool(params.name, params.arguments || {}));
      return;
    }
    if (method && method.startsWith('notifications/')) {
      return;
    }
    error(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    error(id, -32000, err.message);
  }
}

function processFrames() {
  while (true) {
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      return;
    }
    const header = inputBuffer.slice(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      inputBuffer = inputBuffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (inputBuffer.length < bodyEnd) {
      return;
    }
    const body = inputBuffer.slice(bodyStart, bodyEnd).toString('utf8');
    inputBuffer = inputBuffer.slice(bodyEnd);
    handleRequest(JSON.parse(body)).catch((err) => {
      console.error('[mcp]', err.message);
    });
  }
}

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  processFrames();
});
process.stdin.on('end', () => {
  bridge.stop();
  process.exit(0);
});
process.stdin.resume();
setInterval(() => {}, 2147483647);

process.on('SIGTERM', () => {
  bridge.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  bridge.stop();
  process.exit(0);
});
