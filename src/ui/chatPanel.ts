/**
 * Presentation layer: the interactive AI chat in the side bar.
 *
 * A WebviewView provider hosting the assistant UI. The webview is dependency
 * free (inline JS) and acts as a thin client: the extension performs the real
 * work through the same {@link Router} pipeline as `aiio.routePrompt`, so chat
 * requests feed the ledger, the journal and the dashboard exactly like the
 * command does. Replies can be inserted at the cursor, replace the selection
 * in the active editor, or be copied to the clipboard.
 */

import * as vscode from 'vscode';
import type { ExtensionSettings } from '../config/settings';
import type { EditorContext } from '../routing/requestClassifier';
import type { Router } from '../routing/router';

export const CHAT_VIEW_TYPE = 'aiio.chat';

/** Endpoint test result as surfaced to the webview (includes keyless hint). */
export interface ChatConnectionStatus {
  ok: boolean;
  error?: string;
  /** Model ids advertised by the endpoint (best effort). */
  models: string[];
  /** True for local OpenAI-compatible endpoints that need no API key. */
  keyless: boolean;
  /** True when `aiio.cloudApiKey` is set. */
  hasKey: boolean;
  endpoint: string;
  model: string;
}

/** 路由模式：auto = 按复杂度分流；cloud = 全部走云端。 */
export type RouteMode = 'auto' | 'cloud';

/** 组装 Router 时的会话级覆盖（不改动全局设置）。 */
export interface ChatRouterOverride {
  routeMode?: RouteMode;
  /** undefined 表示用设置里的默认模型。 */
  model?: string;
}

export interface ChatServices {
  getRouter(override?: ChatRouterOverride): Router;
  getSettings(): ExtensionSettings;
  /** Probe the cloud endpoint (`GET /models`) and report reachability. */
  testCloudConnection(): Promise<ChatConnectionStatus>;
  /** Re-render the status bar / dashboard after a routed request. */
  refreshViews(): void;
  /** 一键启动本地后端（Ollama）；未安装时 needsInstall=true 供 UI 引导。 */
  startLocalBackend(): Promise<{
    ok: boolean;
    needsInstall: boolean;
    message: string;
  }>;
}

export type ActionKind = 'explain' | 'comment' | 'refactor';

/** Shared by the webview action buttons and the editor context-menu commands. */
export const ACTION_PROMPTS: Record<ActionKind, string> = {
  explain:
    'Explain the selected code: what it does, how it works, and any edge cases or pitfalls. Keep it concise and structured.',
  comment:
    'Add concise, accurate doc comments to the selected code. Return ONLY the commented code, no explanation.',
  refactor:
    'Refactor the selected code for readability and testability while preserving behaviour. Return the refactored code followed by a short list of the changes made.',
};

/** Collect the active editor's context for classification + prompt building. */
function collectEditorContext(editor: vscode.TextEditor | undefined): EditorContext {
  if (!editor) {
    return {};
  }
  const selection = editor.document.getText(editor.selection);
  return {
    fileName: vscode.workspace.asRelativePath(editor.document.uri),
    languageId: editor.document.languageId,
    selectedText: selection.trim().length > 0 ? selection : undefined,
  };
}

export class AiChatPanelProvider implements vscode.WebviewViewProvider {
  private webview: vscode.WebviewView | undefined;
  private busy = false;
  private nextId = 0;
  /** 会话级路由模式；auto = 按复杂度分流，cloud = 全部走云端。 */
  private routeMode: RouteMode = 'auto';
  /** 会话级模型覆盖；undefined = 用设置里的默认模型。 */
  private modelOverride: string | undefined;
  private readonly replies = new Map<number, { text: string }>();

  constructor(private readonly services: ChatServices) {}

  /** Register the view and the provider together (one subscription). */
  static register(context: vscode.ExtensionContext, services: ChatServices): void {
    const provider = new AiChatPanelProvider(services);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(CHAT_VIEW_TYPE, provider)
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.webview = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = renderChatHtml(view.webview.cspSource);
    view.webview.onDidReceiveMessage((message) => void this.handle(message));
    void this.postConnectionStatus();
  }

  /** Re-probe the cloud endpoint (used by the UI "测试" button and settings). */
  refreshConnectionStatus(): void {
    void this.postConnectionStatus();
  }

  /** 一键启动本地后端，并把结果回传给提示条。 */
  private async handleStartLocal(): Promise<void> {
    this.post({ type: 'local-starting' });
    try {
      const result = await this.services.startLocalBackend();
      this.post({
        type: 'local-started',
        ok: result.ok,
        needsInstall: result.needsInstall,
        message: result.message,
      });
      if (result.ok) {
        this.refreshConnectionStatus();
        this.services.refreshViews();
      }
    } catch (error) {
      this.post({
        type: 'local-started',
        ok: false,
        needsInstall: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private post(message: Record<string, unknown>): void {
    void this.webview?.webview.postMessage(message);
  }

  private async handle(message: unknown): Promise<void> {
    const msg = message as { type?: string; [key: string]: unknown } | null;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    switch (msg.type) {
      case 'send':
        await this.runPrompt(String(msg.prompt ?? ''));
        break;
      case 'action':
        await this.runAction(msg.action as ActionKind);
        break;
      case 'insert':
        await this.insertReply(Number(msg.id), 'insert');
        break;
      case 'replace':
        await this.insertReply(Number(msg.id), 'replace');
        break;
      case 'copy':
        await this.copyReply(Number(msg.id));
        break;
      case 'test':
        this.refreshConnectionStatus();
        break;
      case 'start-local':
        await this.handleStartLocal();
        break;
      case 'set-mode':
        this.routeMode = msg.mode === 'cloud' ? 'cloud' : 'auto';
        break;
      case 'set-model':
        this.modelOverride =
          typeof msg.model === 'string' && msg.model.length > 0 ? msg.model : undefined;
        break;
      case 'open-settings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'aiio.');
        break;
      default:
        break;
    }
  }

  private nextMessageId(): number {
    this.nextId += 1;
    return this.nextId;
  }

  /** Run one user prompt through the router and report the result back. */
  private async runPrompt(rawPrompt: string): Promise<void> {
    const id = this.nextMessageId();
    const prompt = rawPrompt.trim();
    if (prompt.length === 0) {
      this.post({ type: 'reply', id, error: '不能发送空消息。' });
      return;
    }
    if (this.busy) {
      this.post({ type: 'reply', id, error: '上一个请求还在处理中，请稍候再试。' });
      return;
    }

    this.busy = true;
    const context = collectEditorContext(vscode.window.activeTextEditor);
    // 会话级覆盖：路由模式 + 模型选择，仅影响本面板发起的请求。
    const override: ChatRouterOverride = {
      routeMode: this.routeMode,
      model: this.modelOverride,
    };
    const router = this.services.getRouter(override);
    try {
      const preview = router.preview(prompt, context);
      this.post({ type: 'preview', id, route: preview.decision.route });

      const outcome = await router.route(prompt, context);
      this.replies.set(id, { text: outcome.completion.text });
      this.services.refreshViews();
      this.post({
        type: 'reply',
        id,
        text: outcome.completion.text,
        route: outcome.route,
        fallback: outcome.fallbackUsed,
        complexity: outcome.features.complexity,
        threshold: outcome.decision.threshold,
        reason: outcome.decision.reason,
        latencyMs: outcome.latencyMs,
        model: outcome.completion.model,
      });
    } catch (error) {
      this.post({
        type: 'reply',
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.busy = false;
    }
  }

  /** Quick actions reuse the active selection through the same pipeline. */
  private async runAction(action: ActionKind): Promise<void> {
    const prompt = ACTION_PROMPTS[action];
    if (!prompt) {
      return;
    }
    const context = collectEditorContext(vscode.window.activeTextEditor);
    if (!context.selectedText) {
      const id = this.nextMessageId();
      this.post({ type: 'reply', id, error: '请先在编辑器中选中一段代码，再使用该动作。' });
      return;
    }
    await this.runPrompt(prompt);
  }

  /** Insert at the cursor, or replace the selection, with a previous reply. */
  private async insertReply(id: number, mode: 'insert' | 'replace'): Promise<void> {
    const record = this.replies.get(id);
    const editor = vscode.window.activeTextEditor;
    if (!record) {
      void vscode.window.showWarningMessage('AI I/O: 该回答已不可用，无法插入。');
      return;
    }
    if (!editor) {
      void vscode.window.showWarningMessage('AI I/O: 没有活动的编辑器，无法插入。');
      return;
    }
    const text = record.text;
    const willReplace = mode === 'replace' && !editor.selection.isEmpty;
    await editor.edit((editBuilder) => {
      if (willReplace) {
        editBuilder.replace(editor.selection, text);
      } else {
        editBuilder.insert(editor.selection.active, text);
      }
    });
    this.post({
      type: 'insert-result',
      ok: true,
      message: willReplace ? '已替换选区。' : '已插入到光标处。',
    });
  }

  private async copyReply(id: number): Promise<void> {
    const record = this.replies.get(id);
    if (!record) {
      void vscode.window.showWarningMessage('AI I/O: 该回答已不可用，无法复制。');
      return;
    }
    await vscode.env.clipboard.writeText(record.text);
    this.post({ type: 'insert-result', ok: true, message: '已复制到剪贴板。' });
  }

  private async postConnectionStatus(): Promise<void> {
    try {
      const status = await this.services.testCloudConnection();
      this.post({ type: 'status', status });
    } catch {
      // Status probing is best effort; the UI keeps its previous state.
    }
  }
}

function renderChatHtml(cspSource: string): string {
  // 内联脚本必须带 nonce 才能通过 webview 的 CSP；否则脚本被静默拦截，
  // 页面上的所有按钮（发送/插入/复制…）都会失效。
  const nonce = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  ).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-foreground, #1f2328);
    background: var(--vscode-editor-background, #ffffff);
    margin: 0; padding: 10px 12px 12px;
    font-size: 13px;
    display: flex; flex-direction: column; gap: 10px;
    height: 100vh;
  }
  .header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .title { font-size: 14px; font-weight: 600; }
  .pill {
    font-size: 11px; padding: 1px 8px; border-radius: 999px;
    border: 1px solid var(--vscode-panel-border, #d0d7de);
    opacity: 0.85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 50%;
  }
  .pill.ok { border-color: #2ea043; color: #2ea043; }
  .pill.err { border-color: #cf222e; color: #cf222e; }
  .head-btns { margin-left: auto; display: flex; gap: 4px; }
  .head-btns button {
    background: none; border: 1px solid var(--vscode-panel-border, #d0d7de);
    color: var(--vscode-foreground, #1f2328);
    border-radius: 6px; padding: 2px 7px; font-size: 11px; cursor: pointer;
  }
  .head-btns button:hover { background: var(--vscode-button-hoverBackground, rgba(0,0,0,0.06)); }
  .hint { font-size: 11px; opacity: 0.6; margin: 0; line-height: 1.4; }
  .selectors { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .selectors label { display: flex; gap: 5px; align-items: center; font-size: 12px; opacity: 0.85; }
  .selectors select {
    background: var(--vscode-dropdown-background, #ffffff);
    color: var(--vscode-dropdown-foreground, #1f2328);
    border: 1px solid var(--vscode-panel-border, #d0d7de);
    border-radius: 5px; padding: 2px 6px; font-size: 12px;
    max-width: 170px;
  }
  .actions-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .actions-row button {
    background: var(--vscode-button-secondaryBackground, #e5e7eb);
    color: var(--vscode-button-secondaryForeground, #1f2328);
    border: none; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  .actions-row button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, #d1d5db); }
  .actions-row button:disabled { opacity: 0.45; cursor: default; }
  .messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 2px; min-height: 60px; }
  .msg { display: flex; flex-direction: column; max-width: 95%; }
  .msg.user { align-self: flex-end; align-items: flex-end; }
  .msg.assistant { align-self: flex-start; align-items: flex-start; }
  .bubble {
    border-radius: 8px; padding: 7px 10px; white-space: pre-wrap;
    word-break: break-word; line-height: 1.45;
  }
  .msg.user .bubble { background: var(--vscode-button-background, #0a66c2); color: var(--vscode-button-foreground, #fff); }
  .msg.assistant .bubble {
    background: var(--vscode-editorWidget-background, #f6f8fa);
    border: 1px solid var(--vscode-panel-border, #d0d7de);
    font-family: var(--vscode-editor-font-family, monospace); font-size: 12.5px;
  }
  .bubble.error { border-color: #cf222e; color: #cf222e; }
  .meta { display: flex; gap: 6px; align-items: center; margin-top: 4px; font-size: 11px; opacity: 0.75; flex-wrap: wrap; }
  .badge { padding: 0 7px; border-radius: 999px; font-size: 10.5px; color: #fff; }
  .badge-local { background: #2ea043; }
  .badge-cloud { background: #8957e5; }
  .badge-thinking { background: #8c959f; }
  .reply-actions { display: flex; gap: 5px; margin-top: 5px; }
  .reply-actions button {
    background: none; border: 1px solid var(--vscode-panel-border, #d0d7de);
    color: var(--vscode-foreground, #1f2328);
    border-radius: 5px; padding: 1px 8px; font-size: 11px; cursor: pointer;
  }
  .reply-actions button:hover { background: var(--vscode-button-hoverBackground, rgba(0,0,0,0.06)); }
  .composer { display: flex; gap: 6px; align-items: flex-end; }
  .composer textarea {
    flex: 1; resize: none; min-height: 38px; max-height: 120px;
    border: 1px solid var(--vscode-panel-border, #d0d7de);
    border-radius: 7px; padding: 7px 9px;
    background: var(--vscode-input-background, #ffffff);
    color: var(--vscode-input-foreground, #1f2328);
    font-family: var(--vscode-font-family, sans-serif); font-size: 12.5px;
  }
  .composer textarea:focus { outline: 1px solid var(--vscode-focusBorder, #0a66c2); }
  .composer button {
    background: var(--vscode-button-background, #0a66c2);
    color: var(--vscode-button-foreground, #fff);
    border: none; border-radius: 7px; padding: 8px 14px; font-size: 12.5px; cursor: pointer;
  }
  .composer button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #0855a6); }
  .composer button:disabled { opacity: 0.5; cursor: default; }
  .toast { font-size: 11px; opacity: 0.7; min-height: 14px; margin: 0; }
  .local-note { font-size: 11px; margin: 0; line-height: 1.4; border-radius: 6px; padding: 4px 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .local-note.ok { color: #2ea043; background: rgba(46, 160, 67, 0.1); }
  .local-note.info { opacity: 0.85; background: var(--vscode-editorWidget-background, rgba(127,127,127,0.08)); }
  .local-start-btn {
    background: var(--vscode-button-background, #0a66c2);
    color: var(--vscode-button-foreground, #fff);
    border: none; border-radius: 5px; padding: 2px 10px; font-size: 11px; cursor: pointer;
  }
  .local-start-btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #0855a6); }
  .local-start-btn:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
  <div class="header">
    <span class="title">AI I/O 助手</span>
    <span id="status-pill" class="pill">检测中…</span>
    <span class="head-btns">
      <button id="btn-test" title="测试云端端点连接">测试</button>
      <button id="btn-settings" title="打开 AI I/O 设置">设置</button>
    </span>
  </div>
  <div class="selectors">
    <label>路由
      <select id="sel-mode" title="auto：简单请求走本地、复杂走云端；cloud：全部走云端">
        <option value="auto">自动分流</option>
        <option value="cloud">仅云端</option>
      </select>
    </label>
    <label>模型
      <select id="sel-model" title="选择回答所用的模型"></select>
    </label>
  </div>
  <p class="hint">简单请求走本地模型，复杂请求走云端。在编辑器选中文本后，可直接点快速动作。</p>
  <p id="local-note" class="local-note info">
    <span id="local-note-text">ℹ 正在检测本地模型…</span>
    <button id="btn-start-local" class="local-start-btn" style="display:none;">一键启动</button>
  </p>
  <div class="actions-row">
    <button data-action="explain">解释选区</button>
    <button data-action="comment">加注释</button>
    <button data-action="refactor">重构选区</button>
  </div>
  <div id="messages" class="messages"></div>
  <p id="toast" class="toast"></p>
  <div class="composer">
    <textarea id="input" rows="2" placeholder="问点什么…（Ctrl+Enter 发送；编辑器选中文本会作为上下文）"></textarea>
    <button id="btn-send">发送</button>
  </div>
<script nonce="${nonce}">
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var messagesEl = document.getElementById('messages');
  var inputEl = document.getElementById('input');
  var sendBtn = document.getElementById('btn-send');
  var pillEl = document.getElementById('status-pill');
  var toastEl = document.getElementById('toast');
  var actionBtns = Array.prototype.slice.call(document.querySelectorAll('.actions-row button'));
  var busy = false;

  function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function setBusy(state) {
    busy = state;
    sendBtn.disabled = state;
    actionBtns.forEach(function (b) { b.disabled = state; });
  }

  function toast(text) {
    toastEl.textContent = text;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { toastEl.textContent = ''; }, 2500);
  }

  function makeBadge(className, text) {
    var b = document.createElement('span');
    b.className = 'badge ' + className;
    b.textContent = text;
    return b;
  }

  function addUserMessage(text) {
    var wrap = document.createElement('div');
    wrap.className = 'msg user';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollBottom();
  }

  function addThinking(id, route) {
    var wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    wrap.setAttribute('data-id', String(id));

    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = '思考中…';

    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.appendChild(makeBadge('badge-thinking', route === 'local' ? 'local · 预测' : 'cloud · 预测'));

    wrap.appendChild(bubble);
    wrap.appendChild(meta);
    messagesEl.appendChild(wrap);
    scrollBottom();
  }

  function finalizeReply(id, payload) {
    var wrap = messagesEl.querySelector('.msg[data-id="' + id + '"]');
    if (!wrap) { return; }
    var bubble = wrap.querySelector('.bubble');
    var meta = wrap.querySelector('.meta');

    if (payload.error) {
      bubble.textContent = payload.error;
      bubble.classList.add('error');
      meta.innerHTML = '';
      return;
    }

    bubble.textContent = payload.text;
    meta.innerHTML = '';
    meta.appendChild(makeBadge(payload.route === 'local' ? 'badge-local' : 'badge-cloud', payload.route));
    var detail = document.createElement('span');
    detail.textContent =
      (payload.fallback ? '（本地失败，已转云端）' : '') +
      '复杂度 ' + Number(payload.complexity).toFixed(2) +
      ' / 阈值 ' + Number(payload.threshold).toFixed(2) +
      ' · ' + payload.latencyMs + ' ms · ' + payload.model;
    meta.appendChild(detail);
    var reason = document.createElement('span');
    reason.textContent = payload.reason;
    reason.style.opacity = '0.65';
    meta.appendChild(reason);

    var actions = document.createElement('div');
    actions.className = 'reply-actions';
    [['insert', '插入'], ['replace', '替换选区'], ['copy', '复制']].forEach(function (pair) {
      var btn = document.createElement('button');
      btn.textContent = pair[1];
      btn.addEventListener('click', function () {
        vscode.postMessage({ type: pair[0], id: id });
      });
      actions.appendChild(btn);
    });
    wrap.appendChild(actions);
    scrollBottom();
  }

  function applyStatus(status) {
    pillEl.classList.remove('ok', 'err');
    if (status.ok) {
      pillEl.classList.add('ok');
      pillEl.textContent = status.models.length > 0
        ? '已连接 · ' + status.models.slice(0, 3).join(', ')
        : '已连接';
      pillEl.title = '端点：' + status.endpoint;
    } else {
      pillEl.classList.add('err');
      var keyNote = status.keyless ? '' : (status.hasKey ? '' : '（未配置 API key）');
      pillEl.textContent = '未连接' + keyNote;
      pillEl.title = (status.error || '无法连接') + '\\n端点：' + status.endpoint;
    }
    updateModelOptions(status);
    renderLocalNote(Boolean(status.local && status.local.available));
  }

  function renderLocalNote(available) {
    // 本地 llama-server 是可选后端：不可达时请求自动走云端，不阻塞使用。
    var noteText = document.getElementById('local-note-text');
    var startBtn = document.getElementById('btn-start-local');
    if (!noteText || !startBtn) { return; }
    var noteEl = noteText.parentElement;
    if (available) {
      noteText.textContent = '✓ 本地模型已就绪（简单请求将优先走本地）。';
      noteEl.className = 'local-note ok';
      startBtn.style.display = 'none';
    } else {
      noteText.textContent = 'ℹ 本地模型未启动（可选）。所有请求将走云端。';
      noteEl.className = 'local-note info';
      startBtn.style.display = '';
      startBtn.disabled = false;
      startBtn.textContent = '一键启动';
    }
  }

  var currentDefaultModel = '';

  function updateModelOptions(status) {
    var sel = document.getElementById('sel-model');
    currentDefaultModel = status.model || currentDefaultModel;
    var models = (status.ok && status.models && status.models.length)
      ? status.models.slice()
      : [];
    if (models.indexOf(currentDefaultModel) === -1) {
      models.unshift(currentDefaultModel);
    }
    // 保留用户已选的自定义模型，避免刷新后丢失。
    var selected = sel.value;
    var names = [];
    for (var i = 0; i < models.length; i++) {
      if (models[i] && names.indexOf(models[i]) === -1) { names.push(models[i]); }
    }
    if (selected && names.indexOf(selected) === -1) { names.unshift(selected); }
    sel.innerHTML = '';
    names.forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name === currentDefaultModel ? name + '（默认）' : name;
      sel.appendChild(opt);
    });
    if (selected) { sel.value = selected; }
  }

  function send(prompt) {
    var trimmed = (prompt || '').trim();
    if (trimmed.length === 0 || busy) { return; }
    setBusy(true);
    addUserMessage(trimmed);
    vscode.postMessage({ type: 'send', prompt: trimmed });
    inputEl.value = '';
    inputEl.focus();
  }

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || !message.type) { return; }
    switch (message.type) {
      case 'preview':
        addThinking(message.id, message.route);
        break;
      case 'reply':
        finalizeReply(message.id, message);
        setBusy(false);
        break;
      case 'status':
        applyStatus(message.status);
        break;
      case 'local-starting': {
        var btn = document.getElementById('btn-start-local');
        if (btn) {
          btn.disabled = true;
          btn.textContent = '启动中…';
        }
        break;
      }
      case 'local-started': {
        if (message.ok) {
          // 成功后 refreshConnectionStatus 会把提示条刷成"已就绪"。
          toast(message.message);
        } else {
          renderLocalNote(false);
          var startBtn = document.getElementById('btn-start-local');
          if (startBtn) {
            startBtn.disabled = false;
            startBtn.textContent = '一键启动';
          }
          toast(message.message);
        }
        break;
      }
      case 'insert-result':
        toast(message.message);
        break;
      default:
        break;
    }
  });

  sendBtn.addEventListener('click', function () { send(inputEl.value); });
  inputEl.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send(inputEl.value);
    }
  });

  actionBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (busy) { return; }
      var action = btn.getAttribute('data-action');
      setBusy(true);
      addUserMessage({ explain: '解释选区', comment: '加注释', refactor: '重构选区' }[action]);
      vscode.postMessage({ type: 'action', action: action });
    });
  });

  document.getElementById('btn-test').addEventListener('click', function () {
    vscode.postMessage({ type: 'test' });
  });
  document.getElementById('btn-settings').addEventListener('click', function () {
    vscode.postMessage({ type: 'open-settings' });
  });
  document.getElementById('sel-mode').addEventListener('change', function (event) {
    vscode.postMessage({ type: 'set-mode', mode: event.target.value });
  });
  document.getElementById('sel-model').addEventListener('change', function (event) {
    vscode.postMessage({ type: 'set-model', model: event.target.value });
  });
  document.getElementById('btn-start-local').addEventListener('click', function () {
    vscode.postMessage({ type: 'start-local' });
  });

  inputEl.focus();
})();
</script>
</body>
</html>`;
}
