const { spawn } = require('child_process');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const Lark = require('@larksuiteoapi/node-sdk');

const DEFAULT_CODEX_ARGS = [
  'exec',
  '--json',
  '--dangerously-bypass-approvals-and-sandbox',
  '--skip-git-repo-check',
  '--ignore-rules',
];
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_APP_SERVER_ARGS = ['app-server', '--listen', 'stdio://'];
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico']);
const TEXT_FILE_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.php', '.html', '.css', '.scss',
  '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env', '.sh', '.bash',
  '.zsh', '.fish', '.sql', '.Dockerfile',
]);

function readConfig() {
  return {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    useWs: String(process.env.FEISHU_USE_WS || 'true').toLowerCase() !== 'false',
    codexCommand: process.env.CODEX_COMMAND || 'codex',
    codexMode: process.env.CODEX_MODE || 'app-server',
    codexModel: process.env.CODEX_MODEL || '',
    codexArgs: splitArgs(process.env.CODEX_ARGS, DEFAULT_CODEX_ARGS),
    codexAppServerArgs: splitArgs(process.env.CODEX_APP_SERVER_ARGS, DEFAULT_APP_SERVER_ARGS),
    codexCwd: process.env.CODEX_CWD || process.env.HOME || process.cwd(),
    codexTimeoutMs: Number(process.env.CODEX_TIMEOUT_MS || 300000),
    codexUseSession: String(process.env.CODEX_USE_SESSION || 'true').toLowerCase() !== 'false',
    codexSessionTtlMs: Number(process.env.CODEX_SESSION_TTL_MS || DEFAULT_SESSION_TTL_MS),
    downloadDir: process.env.FEISHU_DOWNLOAD_DIR || path.join(__dirname, 'downloads'),
    maxInlineFileBytes: Number(process.env.FEISHU_MAX_INLINE_FILE_BYTES || 1024 * 1024),
    outputDirs: splitArgs(process.env.CODEX_OUTPUT_DIRS || `${process.env.HOME || '/home/leitao'} ${path.join(__dirname, 'outputs')}`, []),
    triggerPrefix: process.env.FEISHU_TRIGGER_PREFIX || '',
    replyInThread: String(process.env.FEISHU_REPLY_IN_THREAD || 'false').toLowerCase() === 'true',
    maxReplyChars: Number(process.env.FEISHU_MAX_REPLY_CHARS || 12000),
  };
}

function splitArgs(value, fallback) {
  if (!value || !value.trim()) {
    return fallback;
  }
  return value.trim().split(/\s+/).filter(Boolean);
}

function parseMessageText(message) {
  if (!message || !['text', 'image', 'file'].includes(message.message_type)) {
    return '';
  }
  try {
    const content = JSON.parse(message.content || '{}');
    return String(content.text || '');
  } catch {
    return '';
  }
}

function parseMessageContent(message) {
  try {
    return JSON.parse((message && message.content) || '{}');
  } catch {
    return {};
  }
}

function stripMentionKeys(text, mentions = []) {
  let next = text;
  for (const mention of mentions) {
    if (mention && mention.key) {
      next = next.replaceAll(mention.key, '');
    }
  }
  return next.trim();
}

function truncateForFeishu(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 24)}\n\n[已截断过长回复]`;
}

class FeishuBridge {
  constructor(config = {}) {
    this.config = { ...readConfig(), ...config };
    this.client = null;
    this.wsClient = null;
    this.state = 'stopped';
    this.lastError = '';
    this.lastEventAt = '';
    this.startedAt = '';
    this.codexThreadId = '';
    this.codexSessionLastActiveAt = 0;
    this.codexSessionExpiresAt = 0;
    this.codexSessionTimer = null;
    this.codexQueue = Promise.resolve();
    this.codexAppSession = null;
    this.currentModel = this.config.codexModel;
    this.stats = {
      received: 0,
      ignored: 0,
      codexRuns: 0,
      replies: 0,
      errors: 0,
    };
  }

  requireConfig() {
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error('Missing FEISHU_APP_ID or FEISHU_APP_SECRET');
    }
  }

  createClient() {
    this.requireConfig();
    if (!this.client) {
      this.client = new Lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
      });
    }
    return this.client;
  }

  async start() {
    if (this.state === 'running' || this.state === 'starting') {
      return this.status();
    }
    this.requireConfig();
    this.createClient();
    this.state = 'starting';
    this.lastError = '';

    if (!this.config.useWs) {
      this.state = 'running';
      this.startedAt = new Date().toISOString();
      return this.status();
    }

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => {
        this.handleMessageEvent(data).catch((error) => this.recordError(error));
      },
    });

    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
      autoReconnect: true,
      source: 'codex-feishu-bridge',
      onReady: () => {
        this.state = 'running';
        this.startedAt = this.startedAt || new Date().toISOString();
      },
      onReconnecting: () => {
        this.state = 'reconnecting';
      },
      onReconnected: () => {
        this.state = 'running';
      },
      onError: (error) => {
        this.recordError(error);
        this.state = 'error';
      },
    });

    await this.wsClient.start({ eventDispatcher });
    this.state = 'running';
    this.startedAt = this.startedAt || new Date().toISOString();
    return this.status();
  }

  stop() {
    if (this.wsClient) {
      this.wsClient.close({ force: true });
      this.wsClient = null;
    }
    this.state = 'stopped';
    return this.status();
  }

  status() {
    return {
      state: this.state,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      useWs: this.config.useWs,
      hasConfig: Boolean(this.config.appId && this.config.appSecret),
      codexSession: {
        mode: this.config.codexMode,
        enabled: this.config.codexUseSession,
        threadId: this.codexThreadId,
        model: this.currentModel || 'default',
        lastActiveAt: this.codexSessionLastActiveAt ? new Date(this.codexSessionLastActiveAt).toISOString() : '',
        expiresAt: this.codexSessionExpiresAt ? new Date(this.codexSessionExpiresAt).toISOString() : '',
      },
      reconnect: this.wsClient ? this.wsClient.getReconnectInfo() : null,
      stats: { ...this.stats },
    };
  }

  async handleMessageEvent(data) {
    this.stats.received += 1;
    this.lastEventAt = new Date().toISOString();

    const message = data && data.message;
    const messageId = message && message.message_id;
    let text = stripMentionKeys(parseMessageText(message), message && message.mentions);
    if (!messageId) {
      this.stats.ignored += 1;
      return;
    }
    if (data.sender && data.sender.sender_type === 'app') {
      this.stats.ignored += 1;
      return;
    }
    if (this.config.triggerPrefix) {
      if (!text.startsWith(this.config.triggerPrefix)) {
        this.stats.ignored += 1;
        return;
      }
      text = text.slice(this.config.triggerPrefix.length).trim();
    }

    const attachments = await this.downloadMessageAttachments(message);
    if (!text && !attachments.length) {
      this.stats.ignored += 1;
      return;
    }

    const commandOutput = text ? await this.handleBridgeCommand(text) : '';
    if (commandOutput) {
      await this.replyText(messageId, commandOutput);
      return;
    }

    const output = await this.runCodex(this.buildCodexPrompt(text, attachments), attachments);
    await this.replyCodexOutput(messageId, output || 'Codex 没有返回内容。');
  }

  async downloadMessageAttachments(message) {
    const content = parseMessageContent(message);
    const messageType = message && message.message_type;
    if (!['image', 'file'].includes(messageType)) {
      return [];
    }

    const fileKey = content.file_key || content.image_key;
    if (!fileKey) {
      return [];
    }

    const filename = safeFilename(content.file_name || `${fileKey}${messageType === 'image' ? '.png' : ''}`);
    const targetDir = path.join(this.config.downloadDir, message.message_id || 'unknown');
    await fs.mkdir(targetDir, { recursive: true });
    const filePath = path.join(targetDir, filename);
    const response = await this.createClient().im.v1.messageResource.get({
      params: { type: messageType },
      path: {
        message_id: message.message_id,
        file_key: fileKey,
      },
    });
    await response.writeFile(filePath);
    const stat = await fs.stat(filePath);
    return [{
      messageType,
      fileKey,
      fileName: filename,
      path: filePath,
      size: stat.size,
      inlineText: await this.readInlineFileText(filePath, stat.size),
    }];
  }

  async readInlineFileText(filePath, size) {
    if (size > this.config.maxInlineFileBytes || !isTextFile(filePath)) {
      return '';
    }
    return fs.readFile(filePath, 'utf8');
  }

  buildCodexPrompt(text, attachments) {
    const parts = [text || '请处理用户发送的附件。'];
    for (const attachment of attachments) {
      parts.push(`附件：${attachment.fileName}`);
      parts.push(`本地路径：${attachment.path}`);
      parts.push(`大小：${attachment.size} bytes`);
      if (attachment.inlineText) {
        parts.push(`文件内容：\n${attachment.inlineText}`);
      }
    }
    return parts.join('\n\n');
  }

  async handleBridgeCommand(text) {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    if (lower === '/model' || lower === '/model current' || lower === '模型') {
      return `当前模型：${this.currentModel || '默认配置模型'}`;
    }
    if (lower === '/model list' || lower === '模型列表') {
      const models = await this.listCodexModels();
      if (!models.length) {
        return '未能获取模型列表。可直接发送 /model <模型名> 尝试切换。';
      }
      return `可用模型：\n${models.slice(0, 30).join('\n')}`;
    }
    const match = trimmed.match(/^\/model\s+(.+)$/i) || trimmed.match(/^切换模型\s+(.+)$/);
    if (!match) {
      return '';
    }
    const model = match[1].trim();
    if (!model) {
      return '用法：/model <模型名>';
    }
    this.setCodexModel(model);
    return `已切换模型：${model}\n当前常驻会话会继续保留，下一条消息会在原对话中使用新模型。`;
  }

  async listCodexModels() {
    if (this.config.codexMode !== 'app-server') {
      return [];
    }
    const session = this.codexAppSession || new CodexAppSession({
      ...this.config,
      getModel: () => this.currentModel || null,
    });
    const shouldClose = !this.codexAppSession;
    try {
      if (shouldClose) {
        await session.start({ createThread: false });
      }
      const response = await session.request('model/list', { limit: 100, includeHidden: false });
      return (response.data || []).map((model) => model.id || model.name).filter(Boolean);
    } finally {
      if (shouldClose) {
        session.close();
      }
    }
  }

  setCodexModel(model) {
    this.currentModel = model;
  }

  async replyText(messageId, text) {
    const content = truncateForFeishu(String(text), this.config.maxReplyChars);
    const response = await this.createClient().im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text: content || '无内容' }),
        reply_in_thread: this.config.replyInThread,
      },
    });
    if (response.code && response.code !== 0) {
      throw new Error(`Feishu reply failed: ${response.code} ${response.msg || ''}`.trim());
    }
    this.stats.replies += 1;
    return response.data;
  }

  async replyCodexOutput(messageId, text) {
    const files = await this.findExistingOutputFiles(text);
    const cleanedText = stripUploadedFileReferences(text, files);
    if (cleanedText.trim()) {
      await this.replyText(messageId, cleanedText.trim());
    }
    for (const filePath of files) {
      await this.replyFile(messageId, filePath);
    }
    if (!cleanedText.trim() && !files.length) {
      await this.replyText(messageId, text);
    }
  }

  async findExistingOutputFiles(text) {
    const candidates = extractLocalPaths(text);
    const existing = [];
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      if (!this.isAllowedOutputPath(resolved)) {
        continue;
      }
      try {
        const stat = await fs.stat(resolved);
        if (stat.isFile() && stat.size > 0) {
          existing.push(resolved);
        }
      } catch {
        // Ignore paths that no longer exist or cannot be read.
      }
    }
    return [...new Set(existing)];
  }

  isAllowedOutputPath(filePath) {
    return this.config.outputDirs.some((dir) => {
      const root = path.resolve(dir);
      return filePath === root || filePath.startsWith(`${root}${path.sep}`);
    });
  }

  async replyFile(messageId, filePath) {
    if (isImageFile(filePath)) {
      const uploaded = await this.createClient().im.v1.image.create({
        data: {
          image_type: 'message',
          image: fsSync.createReadStream(filePath),
        },
      });
      await this.replyRawMessage(messageId, 'image', { image_key: uploaded && uploaded.image_key });
      return;
    }
    const uploaded = await this.createClient().im.v1.file.create({
      data: {
        file_type: feishuFileType(filePath),
        file_name: path.basename(filePath),
        file: fsSync.createReadStream(filePath),
      },
    });
    await this.replyRawMessage(messageId, 'file', { file_key: uploaded && uploaded.file_key });
  }

  async replyRawMessage(messageId, msgType, content) {
    const response = await this.createClient().im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: msgType,
        content: JSON.stringify(content),
        reply_in_thread: this.config.replyInThread,
      },
    });
    if (response.code && response.code !== 0) {
      throw new Error(`Feishu reply failed: ${response.code} ${response.msg || ''}`.trim());
    }
    this.stats.replies += 1;
    return response.data;
  }

  async sendTextToChat(chatId, text) {
    const response = await this.createClient().im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: String(text) }),
      },
    });
    if (response.code && response.code !== 0) {
      throw new Error(`Feishu send failed: ${response.code} ${response.msg || ''}`.trim());
    }
    return response.data;
  }

  runCodex(prompt, attachments = []) {
    this.codexQueue = this.codexQueue
      .catch(() => {})
      .then(() => {
        if (this.config.codexMode === 'app-server') {
          return this.runCodexAppServer(prompt, attachments);
        }
        return this.runCodexOnce(prompt);
      });
    return this.codexQueue;
  }

  async runCodexAppServer(prompt, attachments = []) {
    this.stats.codexRuns += 1;
    if (!this.config.codexUseSession) {
      this.clearCodexSession();
    }
    if (!this.codexAppSession || this.isCodexSessionExpired()) {
      this.closeCodexAppSession();
      this.codexAppSession = new CodexAppSession({
        ...this.config,
        getModel: () => this.currentModel || null,
      });
      await this.codexAppSession.start();
      this.codexThreadId = this.codexAppSession.threadId;
    }
    const output = await this.codexAppSession.send(prompt, attachments);
    this.refreshCodexSession(this.codexAppSession.threadId);
    return output;
  }

  runCodexOnce(prompt) {
    this.stats.codexRuns += 1;
    return new Promise((resolve) => {
      const args = this.buildCodexArgs(prompt);
      const child = spawn(this.config.codexCommand, args, {
        cwd: this.config.codexCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish('Codex 执行超时，请缩短输入或稍后重试。');
      }, this.config.codexTimeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        finish(`无法启动 Codex: ${error.message}`);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const parsed = this.parseCodexOutput(stdout);
        if (parsed.threadId) {
          this.refreshCodexSession(parsed.threadId);
        } else if (this.codexThreadId) {
          this.refreshCodexSession(this.codexThreadId);
        }
        const output = parsed.text || stdout.trim();
        const errorOutput = stderr.trim();
        if (output) {
          finish(output);
        } else if (errorOutput) {
          finish(errorOutput);
        } else {
          finish(code === 0 ? '' : `Codex 执行失败，退出码 ${code}`);
        }
      });
    });
  }

  buildCodexArgs(prompt) {
    const baseArgs = normalizeCodexJsonArgs(this.config.codexArgs);
    const modelArgs = this.currentModel ? ['-m', this.currentModel] : [];
    if (this.config.codexUseSession && this.codexThreadId && !this.isCodexSessionExpired()) {
      return ['exec', 'resume', ...baseArgs.slice(1), ...modelArgs, this.codexThreadId, prompt];
    }
    if (this.codexThreadId && this.isCodexSessionExpired()) {
      this.clearCodexSession();
    }
    return [...baseArgs, ...modelArgs, prompt];
  }

  parseCodexOutput(stdout) {
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    let threadId = '';
    let text = '';
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'thread.started' && event.thread_id) {
        threadId = event.thread_id;
      }
      if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message') {
        text = event.item.text || text;
      }
    }
    return { threadId, text };
  }

  refreshCodexSession(threadId) {
    if (!this.config.codexUseSession || !threadId) {
      return;
    }
    this.codexThreadId = threadId;
    this.codexSessionLastActiveAt = Date.now();
    this.codexSessionExpiresAt = this.codexSessionLastActiveAt + this.config.codexSessionTtlMs;
    if (this.codexSessionTimer) {
      clearTimeout(this.codexSessionTimer);
    }
    this.codexSessionTimer = setTimeout(() => {
      this.closeCodexAppSession();
      this.clearCodexSession();
    }, Math.max(this.config.codexSessionTtlMs, 1000));
    if (this.codexSessionTimer.unref) {
      this.codexSessionTimer.unref();
    }
  }

  isCodexSessionExpired() {
    return Boolean(this.codexSessionExpiresAt && Date.now() >= this.codexSessionExpiresAt);
  }

  clearCodexSession() {
    this.codexThreadId = '';
    this.codexSessionLastActiveAt = 0;
    this.codexSessionExpiresAt = 0;
    if (this.codexSessionTimer) {
      clearTimeout(this.codexSessionTimer);
      this.codexSessionTimer = null;
    }
  }

  closeCodexAppSession() {
    if (this.codexAppSession) {
      this.codexAppSession.close();
      this.codexAppSession = null;
    }
  }

  recordError(error) {
    this.stats.errors += 1;
    this.lastError = error && error.message ? error.message : String(error);
    console.error('[feishu-bridge]', this.lastError);
  }
}

class CodexAppSession {
  constructor(config) {
    this.config = config;
    this.child = null;
    this.buffer = '';
    this.nextRequestId = 1;
    this.pending = new Map();
    this.threadId = '';
    this.activeTurn = null;
  }

  async start(options = {}) {
    const createThread = options.createThread !== false;
    this.child = spawn(this.config.codexCommand, this.config.codexAppServerArgs, {
      cwd: this.config.codexCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: { ...process.env },
    });
    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error('[codex-app-server]', text);
      }
    });
    this.child.on('close', () => {
      this.rejectPending(new Error('Codex app-server exited'));
    });

    await this.request('initialize', {
      clientInfo: { name: 'feishu-bridge', version: '1.0.0' },
      capabilities: null,
    });
    if (!createThread) {
      return;
    }
    const response = await this.request('thread/start', {
      cwd: this.config.codexCwd,
      model: this.config.getModel ? this.config.getModel() : this.config.codexModel || null,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: false,
      baseInstructions: '你正在通过飞书和用户对话。回复要直接、简洁，除非用户明确要求详细说明。',
    });
    this.threadId = response.thread.id;
  }

  send(prompt, attachments = []) {
    if (!this.threadId) {
      throw new Error('Codex app-server thread is not ready');
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeTurn = null;
        reject(new Error('Codex app-server turn timed out'));
      }, this.config.codexTimeoutMs);
      this.activeTurn = {
        text: '',
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const input = [{ type: 'text', text: prompt, text_elements: [] }];
      for (const attachment of attachments) {
        if (attachment.messageType === 'image') {
          input.push({ type: 'localImage', path: attachment.path });
        }
      }
      this.request('turn/start', {
        threadId: this.threadId,
        model: this.config.getModel ? this.config.getModel() : this.config.codexModel || null,
        input,
      }).catch((error) => {
        const turn = this.activeTurn;
        this.activeTurn = null;
        if (turn) {
          turn.reject(error);
        }
      });
    });
  }

  request(method, params) {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }
    const id = this.nextRequestId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  handleStdout(chunk) {
    this.buffer += chunk.toString();
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        this.handleMessage(JSON.parse(line));
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  handleMessage(message) {
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === 'item/agentMessage/delta' && this.activeTurn) {
      this.activeTurn.text += message.params.delta || '';
      return;
    }
    if (message.method === 'turn/completed' && this.activeTurn) {
      const turn = this.activeTurn;
      this.activeTurn = null;
      turn.resolve(turn.text.trim());
      return;
    }
    if (message.method === 'error' && this.activeTurn) {
      const turn = this.activeTurn;
      this.activeTurn = null;
      turn.reject(new Error(message.params.message || 'Codex app-server error'));
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    if (this.activeTurn) {
      this.activeTurn.reject(error);
      this.activeTurn = null;
    }
  }

  close() {
    this.rejectPending(new Error('Codex app-server closed'));
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }
}

module.exports = {
  FeishuBridge,
  parseMessageText,
  stripMentionKeys,
  truncateForFeishu,
  parseMessageContent,
};

function normalizeCodexJsonArgs(args) {
  const next = [...args];
  if (next[0] !== 'exec') {
    next.unshift('exec');
  }
  const withoutEphemeral = next.filter((arg) => arg !== '--ephemeral');
  if (!withoutEphemeral.includes('--json')) {
    withoutEphemeral.splice(1, 0, '--json');
  }
  return withoutEphemeral;
}

function safeFilename(value) {
  const basename = path.basename(String(value || 'attachment')).replace(/[^\w.\-()\u4e00-\u9fa5]/g, '_');
  return basename || 'attachment';
}

function isTextFile(filePath) {
  const basename = path.basename(filePath);
  if (basename === 'Dockerfile') {
    return true;
  }
  return TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isImageFile(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function feishuFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4') return 'mp4';
  if (ext === '.pdf') return 'pdf';
  if (['.doc', '.docx'].includes(ext)) return 'doc';
  if (['.xls', '.xlsx', '.csv'].includes(ext)) return 'xls';
  if (['.ppt', '.pptx'].includes(ext)) return 'ppt';
  if (['.opus', '.ogg', '.mp3', '.wav', '.m4a'].includes(ext)) return 'opus';
  return 'stream';
}

function extractLocalPaths(text) {
  const candidates = new Set();
  const patterns = [
    /!\[[^\]]*]\((\/[^)\s]+)\)/g,
    /\[[^\]]+]\((\/[^)\s]+)\)/g,
    /(?:^|[\s'"`(（])((?:~|\/)[^\s'"`，。；;：:）)>\]}]+(?:\.[A-Za-z0-9]{1,12}))/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      candidates.add(expandHome(match[1]));
      match = pattern.exec(text);
    }
  }
  return [...candidates];
}

function stripUploadedFileReferences(text, filePaths) {
  let next = text;
  for (const filePath of filePaths) {
    const escaped = escapeRegExp(filePath);
    next = next.replace(new RegExp(`!\\[[^\\]]*]\\(${escaped}\\)`, 'g'), '');
    next = next.replace(new RegExp(`\\[[^\\]]+]\\(${escaped}\\)`, 'g'), '');
    next = next.replaceAll(filePath, '');
  }
  return next
    .replace(/这是生成的[^：:\n]*[:：]\s*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function expandHome(filePath) {
  if (filePath === '~') {
    return process.env.HOME || filePath;
  }
  if (filePath.startsWith('~/')) {
    return path.join(process.env.HOME || '', filePath.slice(2));
  }
  return filePath;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
