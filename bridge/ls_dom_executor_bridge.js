/**
 * Label Studio DOM Executor Bridge
 *
 * Injecté dans la page Label Studio via Bookmarklet (iframe + postMessage).
 * Communique avec le serveur local via XHR (compatible HTTPS → HTTP).
 * Ne PAS utiliser de coordonnées écran, ni pyautogui, ni marker.
 */
(function () {
  'use strict';

  const SERVER = 'http://127.0.0.1:17892';
  const VERSION = 'dom-executor-2.0.0';

  // --- Nettoyage d'une ancienne instance ---
  if (window.__LS_DOM_EXECUTOR_BRIDGE__) {
    const old = window.__LS_DOM_EXECUTOR_BRIDGE__;
    if (old.heartbeatTimer) clearInterval(old.heartbeatTimer);
    if (old.pollTimer) clearInterval(old.pollTimer);
    window.__LS_DOM_EXECUTOR_BRIDGE__ = null;
  }

  const bridge = {
    running: true,
    clientId: 'ls-dom-bridge-' + Math.random().toString(36).slice(2) + '-' + Date.now(),
    pollTimer: null,
    heartbeatTimer: null,
    executing: false,
    lastCommandId: null,
    version: VERSION,
  };
  window.__LS_DOM_EXECUTOR_BRIDGE__ = bridge;

  // ======================== Utilitaires ========================

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function log() { console.log('[LS DOM Bridge]', ...arguments); }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  // ======================== XHR (compatible HTTPS→HTTP) ========================

  function xhrJson(method, path, body) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open(method, SERVER + path + (method === 'GET' ? '&t=' + Date.now() : ''), true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.timeout = 5000;
      x.onload = function () {
        try { resolve(JSON.parse(x.responseText)); }
        catch (e) { reject(new Error('JSON parse error')); }
      };
      x.onerror = function () { reject(new Error('xhr error')); };
      x.ontimeout = function () { reject(new Error('timeout')); };
      x.send(body ? JSON.stringify(body) : null);
    });
  }

  function apiPost(path, payload) {
    return xhrJson('POST', path, payload);
  }

  function apiGet(path) {
    return xhrJson('GET', path + '&clientId=' + encodeURIComponent(bridge.clientId), null);
  }

  // ======================== Page Info ========================

  function getCurrentTaskId() {
    try {
      var url = new URL(window.location.href);
      for (var _i = 0, _arr = ['task', 'task_id', 'id', 'selected']; _i < _arr.length; _i++) {
        var val = url.searchParams.get(_arr[_i]);
        if (val && /^\d+$/.test(val)) return String(val);
      }
      if (url.hash) {
        var hp = new URLSearchParams(url.hash.split('?')[1] || '');
        val = hp.get('task');
        if (val && /^\d+$/.test(val)) return String(val);
      }
    } catch (_) {}

    var sels = ['div.lsf-current-task__task-id', '[class*="current-task"] [class*="task-id"]', '.lsf-task-id', '[data-testid="task-id"]'];
    for (var _i2 = 0; _i2 < sels.length; _i2++) {
      var el = document.querySelector(sels[_i2]);
      if (el) {
        var m = normalizeText(el.textContent).match(/\b(\d{5,})\b/);
        if (m) return m[1];
      }
    }
    return '';
  }

  function hasLabelingControls() {
    var controls = ['input[name="不符合"]', 'input[name="符合"]', 'textarea[name="remark"]', 'button[name="submit"]', '[data-testid="bottombar-submit-button"]'];
    for (var _i3 = 0; _i3 < controls.length; _i3++) {
      if (document.querySelector(controls[_i3])) return true;
    }
    return false;
  }

  function parsePageInfo() {
    var url = new URL(window.location.href);
    var projectMatch = url.pathname.match(/\/projects\/(\d+)/);
    var taskId = getCurrentTaskId();
    var hasControls = hasLabelingControls();
    return {
      url: window.location.href,
      title: document.title,
      projectId: projectMatch ? projectMatch[1] : '',
      tabId: url.searchParams.get('tab') || '',
      taskId: taskId,
      isLabelingPage: (!!projectMatch && !!taskId && (/\/projects\/\d+\/(data|labeling|label)/.test(url.pathname) || hasControls)) || hasControls,
    };
  }

  // ======================== Toast ========================

  function showToast(message, type) {
    type = type || 'info';
    var box = document.getElementById('ls-dom-bridge-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ls-dom-bridge-toast';
      box.style.cssText = 'position:fixed;right:16px;top:16px;z-index:2147483647;padding:10px 12px;border-radius:8px;font-size:13px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.18);background:#1f2937;color:#fff;max-width:360px;';
      document.body.appendChild(box);
    }
    box.textContent = message;
    box.style.background = type === 'error' ? '#991b1b' : type === 'success' ? '#166534' : '#1f2937';
    clearTimeout(box.__timer);
    box.__timer = setTimeout(function () { if (box && box.parentNode) box.parentNode.removeChild(box); }, 2600);
  }
  bridge.showToast = showToast;

  // ======================== DOM 操作 ========================

  function queryInputByName(name) {
    return document.querySelector('input[name="' + CSS.escape(name) + '"]');
  }

  function candidateClickableForInput(input) {
    if (!input) return null;
    return input.closest('label') || input.closest('.ant-checkbox-wrapper') || input.closest('.lsf-choice') || input.parentElement || input;
  }

  function humanClick(element) {
    if (!element) throw new Error('humanClick 收到空元素');
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    var rect = element.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var types = ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click'];
    for (var _i4 = 0; _i4 < types.length; _i4++) {
      element.dispatchEvent(new MouseEvent(types[_i4], { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }));
    }
  }

  async function ensureChoice(nameToSelect, namesToUnselect) {
    namesToUnselect = namesToUnselect || [];
    for (var _i5 = 0; _i5 < namesToUnselect.length; _i5++) {
      var inp = queryInputByName(namesToUnselect[_i5]);
      if (inp && inp.checked) { humanClick(candidateClickableForInput(inp)); await sleep(80); }
    }
    var target = queryInputByName(nameToSelect);
    if (!target) throw new Error("input[name='" + nameToSelect + "'] 未找到");
    if (!target.checked) { humanClick(candidateClickableForInput(target)); await sleep(100); }
    return { ok: true, name: nameToSelect, checked: queryInputByName(nameToSelect) && queryInputByName(nameToSelect).checked === true };
  }

  function getRemarkTextarea() {
    return document.querySelector('textarea[name="remark"]') || document.querySelector('[data-testid="textarea-input"]');
  }

  function setTextareaValue(textarea, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    setter = setter && setter.set;
    if (setter) setter.call(textarea, value); else textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function fillRemark(remark) {
    var textarea = getRemarkTextarea();
    if (!textarea) throw new Error("textarea[name='remark'] 未找到");
    textarea.scrollIntoView({ block: 'center', inline: 'nearest' });
    textarea.focus();
    setTextareaValue(textarea, '');
    await sleep(60);
    setTextareaValue(textarea, remark);
    await sleep(120);
    return { ok: true, length: String(remark || '').length };
  }

  function findButtonByExactText(text) {
    var buttons = Array.from(document.querySelectorAll('button'));
    for (var _i6 = 0; _i6 < buttons.length; _i6++) {
      if (normalizeText(buttons[_i6].textContent) === text) return buttons[_i6];
    }
    return null;
  }

  async function clickRemarkAdd() {
    var textarea = getRemarkTextarea();
    var addButton = document.querySelector('[data-testid="textarea-add-button"]') || findButtonByExactText('Add');
    if (addButton && !addButton.disabled && addButton.getAttribute('aria-disabled') !== 'true') {
      humanClick(addButton); await sleep(250); return { ok: true, method: 'button' };
    }
    if (!textarea) throw new Error('没有 Add 按钮');
    textarea.focus();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    await sleep(250);
    return { ok: true, method: 'shift_enter' };
  }

  async function clickSubmit() {
    var submit = document.querySelector('button[name="submit"]') || document.querySelector('[data-testid="bottombar-submit-button"]') || findButtonByExactText('Submit');
    if (!submit) throw new Error('Submit 按钮未找到');
    if (submit.disabled || submit.getAttribute('aria-disabled') === 'true') throw new Error('Submit 不可用');
    humanClick(submit);
    await sleep(200);
    return { ok: true };
  }

  // ======================== 任务行 ========================

  function isVisible(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  }

  function getRowCandidates() {
    var sels = ['div.lsf-table__row-wrapper', '[class*="table__row-wrapper"]', '[role="row"]', 'tr'];
    var seen = new Set();
    var out = [];
    for (var _i7 = 0; _i7 < sels.length; _i7++) {
      var els = Array.from(document.querySelectorAll(sels[_i7]));
      for (var _i8 = 0; _i8 < els.length; _i8++) {
        if (!seen.has(els[_i8])) { seen.add(els[_i8]); if (isVisible(els[_i8])) out.push(els[_i8]); }
      }
    }
    return out;
  }

  function cellTextsForRow(row) {
    var cells = Array.from(row.querySelectorAll('div.lsf-table__cell, [class*="table__cell"], [role="cell"], td'));
    if (cells.length) return cells.map(function (c) { return normalizeText(c.textContent); });
    var t = normalizeText(row.textContent);
    return t ? t.split(' ') : [];
  }

  function inferTaskId(texts) {
    for (var _i9 = 0; _i9 < texts.length; _i9++) {
      if (/^\d{5,}$/.test(texts[_i9])) return texts[_i9];
    }
    var m = texts.join(' ').match(/\b\d{5,}\b/);
    return m ? m[0] : '';
  }

  function inferCompletedFromCells(texts) {
    if (texts.length > 3 && /^[01]$/.test(texts[3])) return Number(texts[3]);
    var idIdx = texts.findIndex(function (t) { return /^\d{5,}$/.test(t); });
    var start = idIdx >= 0 ? idIdx + 1 : 0;
    for (var _i10 = start; _i10 < Math.min(texts.length, start + 5); _i10++) {
      if (/^[01]$/.test(texts[_i10])) return Number(texts[_i10]);
    }
    return 0;
  }

  function getTaskRows() {
    var rows = getRowCandidates().map(function (row, idx) {
      var rect = row.getBoundingClientRect();
      var texts = cellTextsForRow(row);
      return { row: row, index: idx, rectTop: rect.top, rectBottom: rect.bottom, texts: texts, taskId: inferTaskId(texts), completed: inferCompletedFromCells(texts) };
    }).filter(function (r) { return r.taskId; });
    rows.sort(function (a, b) { return a.rectTop - b.rectTop; });
    rows.forEach(function (r, idx) { r.index = idx; });
    return rows;
  }

  function findScrollContainer(element) {
    var node = element && element.parentElement;
    while (node && node !== document.body) {
      var style = window.getComputedStyle(node);
      if (['auto', 'scroll'].indexOf(style.overflowY) >= 0 && node.scrollHeight > node.clientHeight) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function median(values) {
    if (!values.length) return null;
    var s = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function computeRowPitch(rows) {
    var centers = rows.map(function (r) { return (r.rectTop + r.rectBottom) / 2; }).sort(function (a, b) { return a - b; });
    var diffs = [];
    for (var _i11 = 1; _i11 < centers.length; _i11++) {
      var d = centers[_i11] - centers[_i11 - 1];
      if (d >= 20 && d <= 140) diffs.push(d);
    }
    return median(diffs);
  }

  async function waitForTaskCompleted(taskId, timeoutMs) {
    var start = Date.now();
    while (Date.now() - start < timeoutMs) {
      var rows = getTaskRows();
      var row = rows.find(function (r) { return String(r.taskId) === String(taskId); });
      if (row && row.completed === 1) return row;
      await sleep(200);
    }
    throw new Error('task ' + taskId + ' 等待完成超时');
  }

  function findFirstUncompletedRow(rows) {
    for (var _i12 = 0; _i12 < rows.length; _i12++) {
      if (rows[_i12].completed === 0) return rows[_i12];
    }
    return null;
  }

  async function waitUntilReadyForFirstZeroNavigation(currentTaskId, timeoutMs) {
    var start = Date.now();
    var lastRows = [];
    while (Date.now() - start < timeoutMs) {
      var rows = getTaskRows();
      lastRows = rows;
      var current = rows.find(function (r) { return String(r.taskId) === String(currentTaskId); });
      var firstZero = findFirstUncompletedRow(rows);
      if (current && current.completed === 1) return { rows: rows, reason: 'current_completed' };
      if (firstZero && String(firstZero.taskId) !== String(currentTaskId)) return { rows: rows, reason: 'first_zero_moved' };
      await sleep(250);
    }
    return { rows: lastRows, reason: 'timeout_but_continue' };
  }

  async function clickFirstUncompletedTask(currentTaskId) {
    var waitMs = 12000;
    var waitResult = await waitUntilReadyForFirstZeroNavigation(currentTaskId, waitMs);
    var rows = waitResult.rows;
    if (!rows.length) throw new Error('未扫描到左侧任务行');
    var firstZero = findFirstUncompletedRow(rows);
    if (!firstZero) {
      var pitch = computeRowPitch(rows) || 50;
      var scroller = findScrollContainer(rows[rows.length - 1].row);
      scroller.scrollTop += pitch;
      await sleep(300);
      rows = getTaskRows();
      firstZero = findFirstUncompletedRow(rows);
    }
    if (!firstZero) throw new Error('未找到状态为 0 的下一任务行');
    if (String(firstZero.taskId) === String(currentTaskId)) throw new Error('当前任务状态未更新');
    firstZero.row.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(120);
    humanClick(firstZero.row);
    await sleep(300);
    return { ok: true, reason: waitResult.reason, nextTaskId: firstZero.taskId, nextIndex: firstZero.index, nextTexts: firstZero.texts };
  }

  // ======================== 命令执行 ========================

  async function executeTemplateCommand(command) {
    var settings = command.settings || {};
    var execution = settings.execution || {};
    var remark = String(command.remark || '');
    var autoSubmit = command.autoSubmit === true;
    var autoNext = command.autoNext === true;
    var currentTaskId = getCurrentTaskId();

    if (!parsePageInfo().isLabelingPage) throw new Error('当前页面不是标注页');
    if (!currentTaskId) throw new Error('未能读取 task_id');
    if (!remark) throw new Error('备注模板为空');

    await ensureChoice('不符合', ['符合']);
    await sleep(execution.delay_after_choice_ms || 120);
    await ensureChoice('是', ['不是']);
    await sleep(execution.delay_after_choice_ms || 120);
    await fillRemark(remark);
    await sleep(execution.delay_after_remark_ms || 150);
    var addResult = await clickRemarkAdd();
    await sleep(execution.delay_after_add_ms || 250);

    if (!autoSubmit) return { ok: true, mode: 'filled_only', taskId: currentTaskId, addResult: addResult, message: '已选择不符合+是并填写备注' };

    await clickSubmit();
    await sleep(execution.delay_after_submit_ms || 800);

    if (!autoNext) return { ok: true, mode: 'submitted_only', taskId: currentTaskId, message: '已提交' };

    var nextInfo = await clickFirstUncompletedTask(currentTaskId);
    return { ok: true, mode: 'submitted_and_next', taskId: currentTaskId, nextTaskId: nextInfo.nextTaskId, nextInfo: nextInfo, message: 'task ' + currentTaskId + ' 已完成，进入 ' + (nextInfo.nextTaskId || '下一') };
  }

  async function handleCommand(command) {
    if (!command || !command.type) return;
    if (bridge.executing) return;
    showToast('执行：' + (command.remark || command.type), 'info');
    bridge.executing = true;
    bridge.lastCommandId = command.commandId;
    try {
      var result = null;
      if (command.type === 'execute_template') result = await executeTemplateCommand(command);
      else if (command.type === 'collect_status') result = { ok: true, page: parsePageInfo(), rows: getTaskRows().map(function (r) { return { taskId: r.taskId, completed: r.completed, texts: r.texts }; }) };
      else throw new Error('未知命令: ' + command.type);
      await apiPost('/bridge/result', { commandId: command.commandId, ok: true, result: result, page: parsePageInfo(), version: VERSION });
      showToast(result.message || '完成', 'success');
    } catch (err) {
      var msg = err && err.message || String(err);
      await apiPost('/bridge/result', { commandId: command.commandId, ok: false, error: msg, page: parsePageInfo(), version: VERSION });
      showToast('执行失败：' + msg, 'error');
      console.error('[LS DOM Bridge] fail', err);
    } finally { bridge.executing = false; }
  }

  async function pollCommands() {
    if (bridge.executing) return;
    try {
      var res = await apiGet('/bridge/command');
      if (res && res.command) await handleCommand(res.command);
    } catch (e) { log('poll fail', e); }
  }

  // ======================== 启动 ========================

  async function start() {
    try {
      var page = parsePageInfo();
      var regResult = await apiPost('/bridge/register', { clientId: bridge.clientId, url: page.url, title: page.title, taskId: page.taskId, version: VERSION });
      if (!regResult.ok) { showToast('注册失败：' + (regResult.error || 'server error'), 'error'); return; }

      showToast('LS DOM Bridge 已连接桌面工具', 'success');
      log('registered', regResult, page);

      bridge.heartbeatTimer = setInterval(async function () {
        try {
          var p = parsePageInfo();
          await apiPost('/bridge/heartbeat', { clientId: bridge.clientId, url: p.url, title: p.title, taskId: p.taskId, version: VERSION });
        } catch (e) { log('hb fail', e); }
      }, 2000);

      bridge.pollTimer = setInterval(pollCommands, 350);
    } catch (e) {
      showToast('连接失败：请确认桌面工具已启动', 'error');
      console.error('[LS DOM Bridge] start fail', e);
    }
  }

  start();
})();
