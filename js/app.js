/**
 * 页面交互入口：渲染、表单、每秒计时巡检。
 * 业务规则见 rotation.js / archive.js，存档见 store.js。
 */

import {
  RUN_LIMIT_MS,
  GAP_LIMIT_MS,
  PUMP_STATE,
  elapsedMs,
  remainingMs,
  isDue,
  hasBackup,
  formatClock,
} from './rotation.js';
import {
  createInitialState,
  recordWaterLevel,
  setSafetyLine,
  startPump,
  stopPump,
  switchPump,
  toggleMaintenance,
  handover,
  evaluateTick,
  currentGapMs,
  describeEvent,
  eventCategory,
  eventTypeLabel,
} from './archive.js';
import { loadState, saveState, clearSaved, exportToFile, parseImport } from './store.js';

let state;
try {
  state = loadState();
} catch (err) {
  state = createInitialState();
  alert(err.message + '，已重置为初始档案。');
}

let ledgerFilter = 'all';
let renderedHandoverKey = '';

/* ---------------- 通用 ---------------- */

const $ = (sel) => document.querySelector(sel);

function persist() {
  const r = saveState(state);
  if (!r.ok) toast(r.error, true);
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function ok(result, successMsg) {
  if (!result.ok) {
    toast(result.error, true);
    return false;
  }
  persist();
  renderPumps();
  renderLedger();
  renderHandover();
  if (successMsg) toast(successMsg);
  return true;
}

/* ---------------- 告警条 ---------------- */

function renderAlerts(now) {
  const box = $('#alerts');
  const items = [];
  const unsafe = state.waterLevel != null && state.waterLevel >= state.safetyLine;
  const running = state.pumps.filter((p) => p.state === PUMP_STATE.RUNNING);

  // 空档：无水可抽且全部停泵
  const gapMs = currentGapMs(state, now);
  if (gapMs != null && unsafe) {
    if (gapMs > GAP_LIMIT_MS) {
      items.push({ cls: 'danger', html: `<span class="blink">●</span> 违规：水位高于安全线但全部停泵，空档已 ${formatClock(gapMs)}（超过 2 分钟），请立即起泵` });
    } else {
      items.push({ cls: 'warn', html: `空档 ${formatClock(gapMs)}（超过 2 分钟将记违规），请尽快起泵` });
    }
  }

  // 到点换泵 / 缺备用泵
  if (running.length > 0 && !hasBackup(state.pumps)) {
    items.push({ cls: 'danger', html: `<span class="blink">●</span> 缺备用泵：四台泵均在运行或检修，在运泵标记超时并继续运行，恢复备用后解除` });
  } else {
    const dues = running.filter((p) => isDue(p, now));
    if (dues.length) {
      items.push({ cls: 'warn', html: `<span class="blink">●</span> ${dues.map((p) => p.name).join('、')}连续运行已满 45 分钟，请执行换泵（先起备用泵，再停旧泵）` });
    }
  }

  // 水位本身
  if (state.waterLevel != null) {
    items.push({
      cls: unsafe ? 'warn' : 'safe-note',
      html: unsafe
        ? `水位 ${state.waterLevel.toFixed(2)} 米，高于安全线 ${state.safetyLine.toFixed(2)} 米，水位回到安全线下才能停泵`
        : `水位 ${state.waterLevel.toFixed(2)} 米，已在安全线 ${state.safetyLine.toFixed(2)} 米以下`,
    });
  }

  box.innerHTML = items.map((it) => `<div class="alert ${it.cls}">${it.html}</div>`).join('');
}

/* ---------------- 泵组卡片 ---------------- */

function pumpCardClass(p) {
  if (p.state === PUMP_STATE.MAINTENANCE) return 'maintenance';
  if (p.overtimeMarked) return 'overtime';
  if (p.state === PUMP_STATE.RUNNING) return 'running';
  return 'standby';
}

function renderPumps(now = Date.now()) {
  $('#pumps').innerHTML = state.pumps.map((p) => {
    const cls = pumpCardClass(p);
    let badge = '';
    let metrics = '';
    let actions = '';

    if (p.state === PUMP_STATE.RUNNING) {
      const el = elapsedMs(p, now);
      const rem = remainingMs(p, now);
      const due = isDue(p, now);
      badge = p.overtimeMarked
        ? '<span class="pump-state state-overtime">超时·缺备用</span>'
        : '<span class="pump-state state-running">运行中</span>';
      metrics = `
        <div class="row"><span>本轮已运行</span><span class="${p.overtimeMarked || due ? 'over' : ''}">${formatClock(el)}</span></div>
        <div class="row"><span>本轮剩余</span><span class="${due || p.overtimeMarked ? 'due' : ''}">${p.overtimeMarked ? '超时 ' + formatClock(el - RUN_LIMIT_MS) : formatClock(rem)}</span></div>
        <div class="row"><span>累计运行</span><span>${(p.totalMinutes + el / 60000).toFixed(1)} 分钟</span></div>`;
      const noBackup = !hasBackup(state.pumps);
      actions = `
        <button data-action="switch" data-id="${p.id}" ${(!due || noBackup) ? 'disabled' : ''}
          title="${noBackup ? '缺备用泵，无法换泵' : due ? '先起备用泵，再停旧泵' : '连续运行满 45 分钟才能换泵'}">换泵</button>
        <button data-action="stop" data-id="${p.id}">停泵</button>
        <button data-action="maint" data-id="${p.id}" class="ghost-danger">送修</button>`;
    } else if (p.state === PUMP_STATE.MAINTENANCE) {
      badge = '<span class="pump-state state-maintenance">检修中</span>';
      metrics = `<div class="row"><span>累计运行</span><span>${p.totalMinutes.toFixed(1)} 分钟</span></div>`;
      actions = `<button data-action="maint" data-id="${p.id}">恢复备用</button>`;
    } else {
      badge = '<span class="pump-state state-standby">备用</span>';
      metrics = `<div class="row"><span>累计运行</span><span>${p.totalMinutes.toFixed(1)} 分钟</span></div>`;
      actions = `
        <button data-action="start" data-id="${p.id}" class="primary">启动</button>
        <button data-action="maint" data-id="${p.id}" class="ghost-danger">设检修</button>`;
    }

    return `
      <div class="pump-card ${cls}">
        <div class="pump-head"><span class="pump-name">${p.name}</span>${badge}</div>
        <div class="pump-metrics">${metrics}</div>
        <div class="pump-actions">${actions}</div>
      </div>`;
  }).join('');
}

/* ---------------- 交接班表单 ---------------- */

function renderHandover(now = Date.now()) {
  const box = $('#handover-pumps');
  const running = state.pumps.filter((p) => p.state === PUMP_STATE.RUNNING);
  const key = running.map((p) => p.id).join(',');

  // 运行泵组合变化时才重建输入框，避免刷新时打断输入
  if (key !== renderedHandoverKey) {
    renderedHandoverKey = key;
    if (running.length === 0) {
      box.innerHTML = '<p class="hint">当前无泵在运行，可直接交接班次。</p>';
    } else {
      box.innerHTML = running.map((p) => {
        const remMin = Math.max(0, Math.ceil(remainingMs(p, now) / 60000));
        return `
          <label>${p.name} 本轮剩余分钟
            <input type="number" min="0" max="45" step="1" value="${remMin}"
              data-remaining="${p.id}" required />
          </label>`;
      }).join('');
    }
  }
}

/* ---------------- 台账 ---------------- */

function renderLedger() {
  const body = $('#ledger-body');
  const rows = state.events
    .filter((ev) => ledgerFilter === 'all' || eventCategory(ev) === ledgerFilter)
    .slice(-300)
    .reverse();

  body.innerHTML = rows.map((ev) => {
    const cat = eventCategory(ev);
    const rowCls = ev.type === 'gap-violation' || (ev.type === 'pump-start' && ev.violation)
      ? 'violation'
      : ev.type === 'overtime' ? 'overtime' : '';
    const tagCls = rowCls === 'violation' ? 'bad' : rowCls === 'overtime' ? 'ot' : '';
    return `
      <tr class="${rowCls}">
        <td>${fmtTime(ev.at)}</td>
        <td><span class="tag ${tagCls}">${eventTypeLabel(ev)}</span></td>
        <td>${describeEvent(state, ev)}</td>
      </tr>`;
  }).join('');
}

/* ---------------- 每秒巡检 ---------------- */

function tick() {
  const now = Date.now();
  const produced = evaluateTick(state, now);
  if (produced.length) {
    persist();
    for (const ev of produced) toast(describeEvent(state, ev), true);
    renderLedger();
  }
  renderAlerts(now);
  renderPumps(now);
}

/* ---------------- 事件绑定 ---------------- */

$('#operator').value = state.currentOperator || '';
$('#operator').addEventListener('change', (e) => {
  state.currentOperator = e.target.value.trim();
  persist();
});

$('#water-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#water-level');
  const r = recordWaterLevel(state, input.value);
  if (ok(r, `水位已登记：${state.waterLevel.toFixed(2)} 米`)) input.value = '';
});

$('#safety-line').value = state.safetyLine.toFixed(2);
$('#safety-line').addEventListener('change', (e) => {
  const r = setSafetyLine(state, e.target.value);
  if (ok(r, '安全线已更新')) e.target.value = state.safetyLine.toFixed(2);
});

$('#pumps').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn || btn.disabled) return;
  const { action, id } = btn.dataset;
  const pump = state.pumps.find((p) => p.id === id);

  if (action === 'start') {
    const r = startPump(state, id);
    if (r.ok && r.violation) toast(`已启动${pump.name}，但空档超过 2 分钟，已记违规`, true);
    else ok(r, `${pump.name}已启动`);
    if (r.ok) renderAlerts(Date.now());
  } else if (action === 'stop') {
    ok(stopPump(state, id), `${pump.name}已停止`);
  } else if (action === 'switch') {
    const r = switchPump(state, id);
    ok(r, r.ok ? `换泵完成：${r.backup.name}已先行启动，${pump.name}随后停止` : null);
  } else if (action === 'maint') {
    const r = toggleMaintenance(state, id);
    if (r.ok) {
      persist();
      renderPumps();
      renderLedger();
      renderHandover();
      toast(r.maintenance === false ? `${pump.name}恢复备用` : `${pump.name}已转为检修`);
    } else toast(r.error, true);
  }
});

$('#handover-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const remainingByPump = {};
  document.querySelectorAll('[data-remaining]').forEach((inp) => {
    remainingByPump[inp.dataset.remaining] = inp.value;
  });
  const r = handover(state, {
    from: $('#handover-from').value,
    to: $('#handover-to').value,
    remainingByPump,
  });
  if (ok(r, `交接完成：下一班由 ${$('#handover-to').value} 接手计时`)) {
    $('#handover-from').value = '';
    $('#handover-to').value = '';
    $('#operator').value = state.currentOperator;
  }
});

$('#ledger-filter').addEventListener('change', (e) => {
  ledgerFilter = e.target.value;
  renderLedger();
});

$('#btn-export').addEventListener('click', () => {
  exportToFile(state);
  toast('存档已导出为 JSON 文件');
});

$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state = parseImport(String(reader.result));
      persist();
      $('#operator').value = state.currentOperator || '';
      $('#safety-line').value = state.safetyLine.toFixed(2);
      renderedHandoverKey = '';
      renderPumps();
      renderLedger();
      renderHandover();
      toast('存档导入成功');
    } catch (err) {
      toast(err.message, true);
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
});

$('#btn-clear').addEventListener('click', () => {
  if (window.confirm('确定清空本机全部台账数据？此操作不可恢复，建议先导出存档。')) {
    state = clearSaved();
    $('#operator').value = '';
    renderedHandoverKey = '';
    renderPumps();
    renderLedger();
    renderHandover();
    toast('存档已清空');
  }
});

/* ---------------- 初始渲染 ---------------- */

renderPumps();
renderLedger();
renderHandover();
tick();
setInterval(tick, 1000);
