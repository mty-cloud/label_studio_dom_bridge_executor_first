/*
 * Label Studio DOM Executor Bridge
 *
 * Runs inside the user's existing Label Studio page. It does NOT use screen
 * coordinates and does NOT call Label Studio API. It operates real DOM controls
 * in the page, equivalent to user clicks/typing in the browser.
 */
(function () {
  'use strict';

  const SERVER = 'http://127.0.0.1:17892';
  const VERSION = 'dom-executor-1.1.0-first0';

  if (window.__LS_DOM_EXECUTOR_BRIDGE__ && window.__LS_DOM_EXECUTOR_BRIDGE__.running) {
    window.__LS_DOM_EXECUTOR_BRIDGE__.showToast('LS DOM Bridge 已在运行');
    return;
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

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function log(...args) {
    console.log('[LS DOM Bridge]', ...args);
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function getCurrentTaskId() {
    try {
      const url = new URL(window.location.href);
      const task = url.searchParams.get('task');
      if (task) return String(task);
    } catch (_) {}

    const taskIdEl = document.querySelector('div.lsf-current-task__task-id');
    const text = normalizeText(taskIdEl && taskIdEl.textContent);
    const m = text.match(/\d{5,}/);
    return m ? m[0] : '';
  }

  function parsePageInfo() {
    const url = new URL(window.location.href);
    const projectMatch = url.pathname.match(/\/projects\/(\d+)/);
    return {
      url: window.location.href,
      title: document.title,
      projectId: projectMatch ? projectMatch[1] : '',
      tabId: url.searchParams.get('tab') || '',
      taskId: getCurrentTaskId(),
      isLabelingPage: /\/projects\/\d+\/data/.test(url.pathname) && !!url.searchParams.get('task'),
    };
  }

  function showToast(message, type = 'info') {
    let box = document.getElementById('ls-dom-bridge-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ls-dom-bridge-toast';
      box.style.cssText = [
        'position:fixed',
        'right:16px',
        'top:16px',
        'z-index:2147483647',
        'padding:10px 12px',
        'border-radius:8px',
        'font-size:13px',
        'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
        'box-shadow:0 4px 16px rgba(0,0,0,.18)',
        'background:#1f2937',
        'color:#fff',
        'max-width:360px',
      ].join(';');
      document.body.appendChild(box);
    }
    box.textContent = message;
    box.style.background = type === 'error' ? '#991b1b' : type === 'success' ? '#166534' : '#1f2937';
    clearTimeout(box.__timer);
    box.__timer = setTimeout(() => {
      if (box && box.parentNode) box.parentNode.removeChild(box);
    }, 2600);
  }
  bridge.showToast = showToast;

  async function post(path, payload) {
    const res = await fetch(SERVER + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      mode: 'cors',
    });
    return res.json();
  }

  async function get(path) {
    const res = await fetch(SERVER + path, { method: 'GET', mode: 'cors', cache: 'no-store' });
    return res.json();
  }

  async function register() {
    const page = parsePageInfo();
    const payload = {
      clientId: bridge.clientId,
      url: page.url,
      title: page.title,
      taskId: page.taskId,
      version: VERSION,
    };
    const result = await post('/bridge/register', payload);
    showToast('LS Bridge 已连接桌面工具', 'success');
    log('registered', result, page);
  }

  async function heartbeat() {
    try {
      const page = parsePageInfo();
      await post('/bridge/heartbeat', {
        clientId: bridge.clientId,
        url: page.url,
        title: page.title,
        taskId: page.taskId,
        version: VERSION,
      });
    } catch (e) {
      log('heartbeat failed', e);
    }
  }

  function queryInputByName(name) {
    return document.querySelector(`input[name="${CSS.escape(name)}"]`);
  }

  function candidateClickableForInput(input) {
    if (!input) return null;
    return (
      input.closest('label') ||
      input.closest('.ant-checkbox-wrapper') ||
      input.closest('.lsf-choice') ||
      input.parentElement ||
      input
    );
  }

  function humanClick(element) {
    if (!element) throw new Error('humanClick 收到空元素');
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    for (const type of ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click']) {
      element.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        button: 0,
      }));
    }
  }

  async function ensureChoice(nameToSelect, namesToUnselect) {
    namesToUnselect = namesToUnselect || [];

    for (const name of namesToUnselect) {
      const input = queryInputByName(name);
      if (input && input.checked) {
        const clickable = candidateClickableForInput(input);
        humanClick(clickable);
        await sleep(80);
      }
    }

    const target = queryInputByName(nameToSelect);
    if (!target) {
      throw new Error(`未找到选项 input[name='${nameToSelect}']`);
    }
    if (!target.checked) {
      const clickable = candidateClickableForInput(target);
      humanClick(clickable);
      await sleep(100);
    }

    return { ok: true, name: nameToSelect, checked: queryInputByName(nameToSelect)?.checked === true };
  }

  function getRemarkTextarea() {
    return document.querySelector('textarea[name="remark"]') || document.querySelector('[data-testid="textarea-input"]');
  }

  function setTextareaValue(textarea, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(textarea, value);
    } else {
      textarea.value = value;
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function fillRemark(remark) {
    const textarea = getRemarkTextarea();
    if (!textarea) throw new Error("未找到备注框 textarea[name='remark']");
    textarea.scrollIntoView({ block: 'center', inline: 'nearest' });
    textarea.focus();
    setTextareaValue(textarea, '');
    await sleep(60);
    setTextareaValue(textarea, remark);
    await sleep(120);
    return { ok: true, length: String(remark || '').length };
  }

  function findButtonByExactText(text) {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.find((btn) => normalizeText(btn.textContent) === text) || null;
  }

  async function clickRemarkAdd() {
    const textarea = getRemarkTextarea();
    const addButton =
      document.querySelector('[data-testid="textarea-add-button"]') ||
      findButtonByExactText('Add');

    if (addButton && !addButton.disabled && addButton.getAttribute('aria-disabled') !== 'true') {
      humanClick(addButton);
      await sleep(250);
      return { ok: true, method: 'button' };
    }

    if (!textarea) throw new Error('未找到 Add 按钮，且无法找到备注框模拟 Shift+Enter');
    textarea.focus();
    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    textarea.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    await sleep(250);
    return { ok: true, method: 'shift_enter' };
  }

  async function clickSubmit() {
    const submit =
      document.querySelector('button[name="submit"]') ||
      document.querySelector('[data-testid="bottombar-submit-button"]') ||
      findButtonByExactText('Submit');

    if (!submit) throw new Error('未找到 Submit 按钮');
    if (submit.disabled || submit.getAttribute('aria-disabled') === 'true') {
      throw new Error('Submit 按钮不可用');
    }
    humanClick(submit);
    await sleep(200);
    return { ok: true };
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  }

  function getRowCandidates() {
    const selectors = [
      'div.lsf-table__row-wrapper',
      '[class*="table__row-wrapper"]',
      '[role="row"]',
      'tr',
    ];
    const seen = new Set();
    const out = [];
    for (const sel of selectors) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (isVisible(el)) out.push(el);
      }
    }
    return out;
  }

  function cellTextsForRow(row) {
    const cells = Array.from(row.querySelectorAll('div.lsf-table__cell, [class*="table__cell"], [role="cell"], td'));
    if (cells.length) return cells.map((c) => normalizeText(c.textContent));
    const text = normalizeText(row.textContent);
    return text ? text.split(' ') : [];
  }

  function inferTaskId(texts) {
    // Task ids in this project are 6-digit numbers, but keep it flexible.
    for (const t of texts) {
      if (/^\d{5,}$/.test(t)) return t;
    }
    const joined = texts.join(' ');
    const m = joined.match(/\b\d{5,}\b/);
    return m ? m[0] : '';
  }

  function inferCompletedFromCells(texts) {
    // Known table layout from user's Label Studio data page:
    // 0 checkbox, 1 id, 2 completed_at, 3 annotations_count, 4 cancelled_count, 5 predictions_count.
    // Prefer cell index 3 when it is exactly 0/1.
    if (texts.length > 3 && /^[01]$/.test(texts[3])) return Number(texts[3]);

    // Fallback: after task id cell, find early standalone 0/1 count cell.
    const idIdx = texts.findIndex((t) => /^\d{5,}$/.test(t));
    const start = idIdx >= 0 ? idIdx + 1 : 0;
    for (let i = start; i < Math.min(texts.length, start + 5); i++) {
      if (/^[01]$/.test(texts[i])) return Number(texts[i]);
    }

    return 0;
  }

  function getTaskRows() {
    const rows = getRowCandidates()
      .map((row, index) => {
        const rect = row.getBoundingClientRect();
        const texts = cellTextsForRow(row);
        const taskId = inferTaskId(texts);
        const completed = inferCompletedFromCells(texts);
        return { row, index, rectTop: rect.top, rectBottom: rect.bottom, texts, taskId, completed };
      })
      .filter((r) => r.taskId);

    rows.sort((a, b) => a.rectTop - b.rectTop);
    rows.forEach((r, idx) => { r.index = idx; });
    return rows;
  }

  function findScrollContainer(element) {
    let node = element && element.parentElement;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      const canScroll = ['auto', 'scroll'].includes(style.overflowY) && node.scrollHeight > node.clientHeight;
      if (canScroll) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function median(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function computeRowPitch(rows) {
    const centers = rows.map((r) => (r.rectTop + r.rectBottom) / 2).sort((a, b) => a - b);
    const diffs = [];
    for (let i = 1; i < centers.length; i++) {
      const d = centers[i] - centers[i - 1];
      if (d >= 20 && d <= 140) diffs.push(d);
    }
    return median(diffs);
  }

  async function waitForTaskCompleted(taskId, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const rows = getTaskRows();
      const row = rows.find((r) => String(r.taskId) === String(taskId));
      if (row && row.completed === 1) return row;
      await sleep(200);
    }
    throw new Error(`等待 task ${taskId} 的状态变为 1 超时`);
  }

  function findFirstUncompletedRow(rows) {
    return rows.find((r) => r.completed === 0) || null;
  }

  async function waitUntilReadyForFirstZeroNavigation(currentTaskId, timeoutMs) {
    const start = Date.now();
    let lastRows = [];

    while (Date.now() - start < timeoutMs) {
      const rows = getTaskRows();
      lastRows = rows;
      const current = rows.find((r) => String(r.taskId) === String(currentTaskId));
      const firstZero = findFirstUncompletedRow(rows);

      // Ideal: current task has become completed=1.
      if (current && current.completed === 1) return { rows, reason: 'current_completed' };

      // Also acceptable: first uncompleted row is no longer the just-submitted task.
      if (firstZero && String(firstZero.taskId) !== String(currentTaskId)) {
        return { rows, reason: 'first_zero_moved' };
      }

      await sleep(250);
    }

    return { rows: lastRows, reason: 'timeout_but_continue' };
  }

  async function clickFirstUncompletedTask(currentTaskId) {
    const waitMs = 12000;
    let waitResult = await waitUntilReadyForFirstZeroNavigation(currentTaskId, waitMs);
    let rows = waitResult.rows;
    if (!rows.length) throw new Error('未扫描到左侧任务行');

    let firstZero = findFirstUncompletedRow(rows);

    // If no 0 is visible, scroll down by one row pitch and scan again.
    if (!firstZero) {
      const pitch = computeRowPitch(rows) || 50;
      const scroller = findScrollContainer(rows[rows.length - 1].row);
      scroller.scrollTop += pitch;
      await sleep(300);
      rows = getTaskRows();
      firstZero = findFirstUncompletedRow(rows);
    }

    if (!firstZero) {
      throw new Error('从上往下未找到状态为 0 的下一任务行');
    }

    if (String(firstZero.taskId) === String(currentTaskId)) {
      throw new Error('提交后第一个状态为 0 的任务仍是当前任务，疑似 Submit 未成功或列表未更新');
    }

    firstZero.row.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(120);
    humanClick(firstZero.row);
    await sleep(300);

    return {
      ok: true,
      strategy: 'first_completed_0_from_top',
      waitReason: waitResult.reason,
      nextTaskId: firstZero.taskId,
      nextIndex: firstZero.index,
      nextTexts: firstZero.texts,
    };
  }

  async function executeTemplateCommand(command) {
    const settings = command.settings || {};
    const execution = settings.execution || {};
    const remark = String(command.remark || '');
    const autoSubmit = command.autoSubmit === true;
    const autoNext = command.autoNext === true;
    const currentTaskId = getCurrentTaskId();

    if (!parsePageInfo().isLabelingPage) {
      throw new Error('当前页面不是 Label Studio 具体 task 标注页');
    }
    if (!currentTaskId) {
      throw new Error('未能读取当前 task_id');
    }
    if (!remark) {
      throw new Error('备注模板为空');
    }

    await ensureChoice('不符合', ['符合']);
    await sleep(execution.delay_after_choice_ms ?? 120);

    await ensureChoice('是', ['不是']);
    await sleep(execution.delay_after_choice_ms ?? 120);

    await fillRemark(remark);
    await sleep(execution.delay_after_remark_ms ?? 150);

    const addResult = await clickRemarkAdd();
    await sleep(execution.delay_after_add_ms ?? 250);

    if (!autoSubmit) {
      return {
        ok: true,
        mode: 'filled_only',
        taskId: currentTaskId,
        addResult,
        message: '已选择不符合、是，并填写备注；未提交。',
      };
    }

    await clickSubmit();
    await sleep(execution.delay_after_submit_ms ?? 800);

    if (!autoNext) {
      return {
        ok: true,
        mode: 'submitted_only',
        taskId: currentTaskId,
        message: '已提交；未点击下一任务。',
      };
    }

    const nextInfo = await clickFirstUncompletedTask(currentTaskId);

    return {
      ok: true,
      mode: 'submitted_and_next',
      taskId: currentTaskId,
      nextTaskId: nextInfo.nextTaskId,
      nextInfo,
      message: `已提交 task ${currentTaskId}，并按从上往下第一个状态为0逻辑点击下一任务 ${nextInfo.nextTaskId || ''}`,
    };
  }

  async function handleCommand(command) {
    if (!command || !command.type) return;
    if (bridge.executing) return;
    showToast('收到模板执行命令：' + (command.remark || ''), 'info');
    bridge.executing = true;
    bridge.lastCommandId = command.commandId;
    try {
      let result;
      if (command.type === 'execute_template') {
        result = await executeTemplateCommand(command);
      } else if (command.type === 'collect_status') {
        result = { ok: true, page: parsePageInfo(), rows: getTaskRows().map((r) => ({ taskId: r.taskId, completed: r.completed, texts: r.texts })) };
      } else {
        throw new Error(`未知命令类型：${command.type}`);
      }
      await post('/bridge/result', {
        commandId: command.commandId,
        ok: true,
        result,
        page: parsePageInfo(),
        version: VERSION,
      });
      showToast(result.message || '模板执行完成', 'success');
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      await post('/bridge/result', {
        commandId: command.commandId,
        ok: false,
        error: message,
        stack: err && err.stack ? String(err.stack) : '',
        page: parsePageInfo(),
        version: VERSION,
      });
      showToast('执行失败：' + message, 'error');
      console.error('[LS DOM Bridge] command failed', err);
    } finally {
      bridge.executing = false;
    }
  }

  async function pollCommands() {
    if (bridge.executing) return;
    try {
      const res = await get('/bridge/command?clientId=' + encodeURIComponent(bridge.clientId) + '&t=' + Date.now());
      if (res && res.command) {
        await handleCommand(res.command);
      }
    } catch (e) {
      log('poll failed', e);
    }
  }

  async function start() {
    try {
      await register();
      await heartbeat();
      bridge.heartbeatTimer = setInterval(heartbeat, 2000);
      bridge.pollTimer = setInterval(pollCommands, 350);
      showToast('LS DOM Bridge 已启动', 'success');
    } catch (e) {
      showToast('LS DOM Bridge 连接失败：请确认桌面工具已启动', 'error');
      console.error('[LS DOM Bridge] start failed', e);
    }
  }

  start();
})();
