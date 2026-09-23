/**
 * 泵组档案（业务文件 2/3）
 * 预置四台泵组，登记水位、启停、累计运行分钟、换泵、检修、交接与违规。
 * 所有操作在此校验并追加台账事件；本文件不碰 DOM，存档读写交给 store.js。
 */

import {
  PUMP_STATE,
  RUN_LIMIT_MS,
  GAP_LIMIT_MS,
  elapsedMs,
  isDue,
  pickBackup,
  hasBackup,
  noBackupCapacity,
  canStopPump,
  carriedStartAt,
} from './rotation.js';

export const STATE_VERSION = 1;
export const PUMP_COUNT = 4;

/** 初始档案：四台泵组，全部备用。 */
export function createInitialState(safetyLine = 5.0) {
  return {
    version: STATE_VERSION,
    safetyLine,
    waterLevel: null,
    currentOperator: '',
    pumps: Array.from({ length: PUMP_COUNT }, (_, i) => ({
      id: `P${i + 1}`,
      name: `${i + 1}#泵组`,
      state: PUMP_STATE.STANDBY,
      runStartedAt: null, // 本轮（45 分钟周期）连续运行的起算时间
      totalMinutes: 0,    // 累计运行分钟
      overtimeMarked: false,
    })),
    events: [],
    seq: 0,
    zeroRunningAt: null, // 最近一次“全部停泵、空档开始”的时间
    gapViolationMarked: false,
  };
}

/** 读取旧档后补齐字段，保证四台泵结构完整。 */
export function normalizeState(raw) {
  const base = createInitialState();
  if (!raw || typeof raw !== 'object') throw new Error('存档格式不正确');
  const s = { ...base, ...raw };
  s.pumps = Array.isArray(raw.pumps) ? raw.pumps.slice(0, PUMP_COUNT) : [];
  for (let i = 0; i < PUMP_COUNT; i++) {
    const loaded = s.pumps[i] || {};
    s.pumps[i] = { ...base.pumps[i], ...loaded };
  }
  s.events = Array.isArray(raw.events) ? raw.events : [];
  s.seq = Number(raw.seq) || s.events.length;
  return s;
}

export function runningPumps(state) {
  return state.pumps.filter((p) => p.state === PUMP_STATE.RUNNING);
}

function addEvent(state, type, payload = {}) {
  state.seq += 1;
  const event = { id: `E${String(state.seq).padStart(5, '0')}`, at: Date.now(), type, ...payload };
  state.events.push(event);
  return event;
}

function accumulate(pump, now) {
  if (pump.runStartedAt == null) return 0;
  const minutes = Math.round(((now - pump.runStartedAt) / 60000) * 100) / 100;
  pump.totalMinutes = Math.round((pump.totalMinutes + Math.max(0, minutes)) * 100) / 100;
  return minutes;
}

/** 登记水位。 */
export function recordWaterLevel(state, level) {
  const value = Number(level);
  if (!Number.isFinite(value) || value < 0) return { ok: false, error: '请输入有效的水位数值' };
  state.waterLevel = Math.round(value * 100) / 100;
  addEvent(state, 'water-level', {
    level: state.waterLevel,
    safetyLine: state.safetyLine,
    aboveSafety: state.waterLevel >= state.safetyLine,
  });
  return { ok: true };
}

export function setSafetyLine(state, value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) return { ok: false, error: '安全线数值无效' };
  state.safetyLine = Math.round(v * 100) / 100;
  return { ok: true };
}

/** 手动起泵（备用 → 运行），自动判定空档违规。 */
export function startPump(state, pumpId, now = Date.now()) {
  const pump = state.pumps.find((p) => p.id === pumpId);
  if (!pump) return { ok: false, error: '泵组不存在' };
  if (pump.state === PUMP_STATE.RUNNING) return { ok: false, error: `${pump.name}已在运行` };
  if (pump.state === PUMP_STATE.MAINTENANCE) return { ok: false, error: `${pump.name}正在检修，先恢复备用` };

  let gapMs = null;
  let violation = false;
  if (runningPumps(state).length === 0 && state.zeroRunningAt != null) {
    gapMs = now - state.zeroRunningAt;
    // 起泵时水位仍在安全线以上、空档超过 2 分钟且此前未记过本次空档违规
    violation = gapMs > GAP_LIMIT_MS
      && state.waterLevel != null && state.waterLevel >= state.safetyLine
      && !state.gapViolationMarked;
  }

  pump.state = PUMP_STATE.RUNNING;
  pump.runStartedAt = now;
  pump.overtimeMarked = false;
  state.zeroRunningAt = null;
  state.gapViolationMarked = false;

  const event = addEvent(state, 'pump-start', { pumpId, gapMs, violation });
  return { ok: true, event, violation, gapMs };
}

/** 停泵；最后一台运行泵须水位回到安全线以下。 */
export function stopPump(state, pumpId, now = Date.now()) {
  const pump = state.pumps.find((p) => p.id === pumpId);
  if (!pump || pump.state !== PUMP_STATE.RUNNING) return { ok: false, error: '该泵当前不在运行' };

  const guard = canStopPump(state.pumps, state.waterLevel, state.safetyLine);
  if (!guard.allowed) return { ok: false, error: guard.reason };

  const minutes = accumulate(pump, now);
  pump.state = PUMP_STATE.STANDBY;
  pump.runStartedAt = null;
  pump.overtimeMarked = false;
  if (runningPumps(state).length === 0) {
    state.zeroRunningAt = now;
    state.gapViolationMarked = false;
  }
  addEvent(state, 'pump-stop', { pumpId, minutes, reason: 'manual' });
  return { ok: true, minutes };
}

/**
 * 换泵：先起备用泵，再停旧泵（同一刻完成，保证无空档、顺序正确）。
 * 无备用泵时不停机，交由 evaluateTick 标记超时并提示缺备用泵。
 */
export function switchPump(state, oldId, now = Date.now()) {
  const old = state.pumps.find((p) => p.id === oldId);
  if (!old || old.state !== PUMP_STATE.RUNNING) return { ok: false, error: '该泵当前不在运行' };
  if (!isDue(old, now)) {
    const remainMin = Math.ceil((RUN_LIMIT_MS - elapsedMs(old, now)) / 60000);
    return { ok: false, error: `连续运行未满 45 分钟，还剩约 ${remainMin} 分钟才能换泵` };
  }

  const backup = pickBackup(state.pumps, oldId);
  if (!backup) {
    return { ok: false, error: '缺备用泵：其余泵均在运行或检修，旧泵继续运行并标记超时' };
  }

  // 1. 先起备用泵
  backup.state = PUMP_STATE.RUNNING;
  backup.runStartedAt = now;
  backup.overtimeMarked = false;
  state.zeroRunningAt = null;
  state.gapViolationMarked = false;
  addEvent(state, 'pump-start', { pumpId: backup.id, gapMs: 0, violation: false });

  // 2. 再停旧泵，累计其运行分钟
  const minutes = accumulate(old, now);
  old.state = PUMP_STATE.STANDBY;
  old.runStartedAt = null;
  old.overtimeMarked = false;
  addEvent(state, 'pump-stop', { pumpId: old.id, minutes, reason: 'switch', replacedBy: backup.id });

  return { ok: true, backup, minutes };
}

/** 检修投退；运行中送修按停泵累计分钟，并可能形成空档。 */
export function toggleMaintenance(state, pumpId, now = Date.now()) {
  const pump = state.pumps.find((p) => p.id === pumpId);
  if (!pump) return { ok: false, error: '泵组不存在' };

  if (pump.state === PUMP_STATE.MAINTENANCE) {
    pump.state = PUMP_STATE.STANDBY;
    addEvent(state, 'pump-maintenance', { pumpId, maintenance: false });
    return { ok: true };
  }

  let minutes = null;
  const wasLastRunning = pump.state === PUMP_STATE.RUNNING && runningPumps(state).length === 1;
  if (pump.state === PUMP_STATE.RUNNING) {
    minutes = accumulate(pump, now);
    pump.runStartedAt = null;
    pump.overtimeMarked = false;
    if (wasLastRunning) {
      state.zeroRunningAt = now;
      state.gapViolationMarked = false;
    }
  }
  pump.state = PUMP_STATE.MAINTENANCE;
  addEvent(state, 'pump-maintenance', { pumpId, maintenance: true, minutes });
  return { ok: true, minutes, gapRisk: wasLastRunning };
}

/**
 * 交接班：仍在运行的泵逐台带“本轮剩余分钟”交给下一班，
 * 下一班按折算后的起算时间继续计时。
 */
export function handover(state, { from, to, remainingByPump = {} }, now = Date.now()) {
  const fromName = String(from || '').trim();
  const toName = String(to || '').trim();
  if (!fromName || !toName) return { ok: false, error: '请填写交班人和接班人' };

  const running = runningPumps(state);
  const carry = [];
  for (const pump of running) {
    const raw = remainingByPump[pump.id];
    const remaining = Number(raw);
    if (!Number.isFinite(remaining) || remaining < 0 || remaining > RUN_LIMIT_MS / 60000) {
      return { ok: false, error: `${pump.name}剩余分钟需在 0 ~ 45 之间` };
    }
    pump.runStartedAt = carriedStartAt(remaining, now);
    carry.push({ pumpId: pump.id, remainingMinutes: remaining });
  }

  state.currentOperator = toName;
  addEvent(state, 'handover', { from: fromName, to: toName, at: now, running: carry });
  return { ok: true };
}

/**
 * 每秒巡检（由界面定时调用）：
 * 1) 四台泵均在运行或检修（无备用）时，运行泵标记超时并各记一次，不停机；
 * 2) 全部停泵且水位仍在安全线以上、空档超过 2 分钟，记一次违规。
 * 返回新产生的事件，供界面即时提示。
 */
export function evaluateTick(state, now = Date.now()) {
  const produced = [];

  // 缺备用泵 → 超时标记
  const noBackup = noBackupCapacity(state.pumps);
  for (const pump of state.pumps) {
    if (pump.state === PUMP_STATE.RUNNING && noBackup && !pump.overtimeMarked) {
      pump.overtimeMarked = true;
      produced.push(addEvent(state, 'overtime', { pumpId: pump.id, reason: 'no-backup' }));
    }
    if (pump.state === PUMP_STATE.RUNNING && !noBackup && pump.overtimeMarked) {
      pump.overtimeMarked = false; // 备用能力恢复，解除超时
    }
  }

  // 空档违规（无水可抽且超过 2 分钟未起泵）
  const unsafe = state.waterLevel != null && state.waterLevel >= state.safetyLine;
  if (runningPumps(state).length === 0 && unsafe && state.zeroRunningAt != null) {
    const gapMs = now - state.zeroRunningAt;
    if (gapMs > GAP_LIMIT_MS && !state.gapViolationMarked) {
      state.gapViolationMarked = true;
      produced.push(addEvent(state, 'gap-violation', { gapMs, level: state.waterLevel }));
    }
  }

  return produced;
}

/** 当前空档持续毫秒（无泵运行时），用于界面倒计时提示。 */
export function currentGapMs(state, now = Date.now()) {
  if (runningPumps(state).length > 0 || state.zeroRunningAt == null) return null;
  return now - state.zeroRunningAt;
}

/* ---------------- 台账文案 ---------------- */

function pumpNameOf(state, id) {
  return state.pumps.find((p) => p.id === id)?.name || id;
}

function clockOf(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m >= 1 ? `${m}分${s}秒` : `${s}秒`;
}

/** 生成台账事件的中文内容。 */
export function describeEvent(state, ev) {
  switch (ev.type) {
    case 'water-level':
      return `登记水位 ${ev.level.toFixed(2)} 米（安全线 ${ev.safetyLine.toFixed(2)} 米，${ev.aboveSafety ? '高于安全线，需抽排' : '已回到安全线以下'}）`;
    case 'pump-start': {
      let text = `${pumpNameOf(state, ev.pumpId)}启动`;
      if (ev.gapMs === 0) text += '（换泵：先起备用）';
      else if (ev.violation) text += `（空档 ${clockOf(ev.gapMs)}，违规）`;
      else if (ev.gapMs != null) text += `（空档 ${clockOf(ev.gapMs)}）`;
      return text;
    }
    case 'pump-stop':
      return `${pumpNameOf(state, ev.pumpId)}停止，本次运行 ${ev.minutes.toFixed(1)} 分钟${
        ev.reason === 'switch' ? `，换由${pumpNameOf(state, ev.replacedBy)}接替（先起后停）` : ''
      }`;
    case 'pump-switch':
      return `换泵：${pumpNameOf(state, ev.fromId)} → ${pumpNameOf(state, ev.toId)}`;
    case 'pump-maintenance':
      return ev.maintenance
        ? `${pumpNameOf(state, ev.pumpId)}转为检修${ev.minutes != null ? `，停止前运行 ${ev.minutes.toFixed(1)} 分钟` : ''}`
        : `${pumpNameOf(state, ev.pumpId)}检修完成，恢复备用`;
    case 'handover':
      return `交接班：${ev.from} → ${ev.to}`
        + (ev.running.length
          ? `；在运 ${ev.running.map((r) => `${pumpNameOf(state, r.pumpId)}剩余 ${r.remainingMinutes} 分钟`).join('、')}`
          : '；交接时无泵运行')
        + '，下一班继续计时';
    case 'overtime':
      return `${pumpNameOf(state, ev.pumpId)}标记超时：四台泵均在运行或检修，缺备用泵，暂不停机`;
    case 'gap-violation':
      return `违规：水位 ${ev.level?.toFixed(2)} 米高于安全线，全部停泵空档超过 2 分钟（实测 ${clockOf(ev.gapMs)}）`;
    default:
      return ev.type;
  }
}

/** 台账筛选分类。 */
export function eventCategory(ev) {
  if (ev.type === 'gap-violation' || (ev.type === 'pump-start' && ev.violation)) return 'alert';
  if (ev.type === 'overtime') return 'alert';
  if (ev.type === 'pump-start' || ev.type === 'pump-stop' || ev.type === 'pump-switch') return 'run';
  if (ev.type === 'water-level') return 'water';
  if (ev.type === 'handover') return 'handover';
  if (ev.type === 'pump-maintenance') return 'maint';
  return 'other';
}

export function eventTypeLabel(ev) {
  return {
    'water-level': '水位',
    'pump-start': ev.violation ? '违规' : '起泵',
    'pump-stop': '停泵',
    'pump-switch': '换泵',
    'pump-maintenance': '检修',
    handover: '交接班',
    overtime: '超时',
    'gap-violation': '违规',
  }[ev.type] || ev.type;
}

export { elapsedMs, hasBackup, noBackupCapacity, GAP_LIMIT_MS };
