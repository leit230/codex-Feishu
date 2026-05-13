require('dotenv').config({ path: `${__dirname}/.env` });

const express = require('express');
const { FeishuBridge } = require('./feishu_bridge');

const PORT = Number(process.env.FEISHU_BRIDGE_PORT || 8000);
const AUTO_START = String(process.env.FEISHU_AUTO_START || 'true').toLowerCase() !== 'false';

const app = express();
const bridge = new FeishuBridge();

app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json(bridge.status());
});

app.post('/start', async (_req, res) => {
  try {
    res.json(await bridge.start());
  } catch (error) {
    bridge.recordError(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/stop', (_req, res) => {
  res.json(bridge.stop());
});

app.post('/send', async (req, res) => {
  try {
    const { chat_id: chatId, text } = req.body || {};
    if (!chatId || !text) {
      return res.status(400).json({ error: 'chat_id and text are required' });
    }
    res.json(await bridge.sendTextToChat(chatId, text));
  } catch (error) {
    bridge.recordError(error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, async () => {
  console.log(`[server] listening on ${PORT}`);
  if (AUTO_START) {
    try {
      await bridge.start();
      console.log('[server] feishu long connection started');
    } catch (error) {
      bridge.recordError(error);
    }
  }
});

process.on('SIGTERM', () => {
  bridge.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  bridge.stop();
  process.exit(0);
});
