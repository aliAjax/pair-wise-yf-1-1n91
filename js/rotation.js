/**
 * 轮换规则（业务文件 1/3）
 * 纯规则计算：45 分钟轮换、先起备用再停旧泵、空档 2 分钟判违规、
 * 缺备用泵标超时、安全线下才能停泵。本文件不读写 DOM、不读写存档。
 */

export const RUN_LIMIT_MS = 45 * 60 * 1000;        // 同一台泵连续运行满 45 分钟换泵
export const GAP_LIMIT_MS = 2 * 60 * 1000;        // 两台泵启停之间空档超过 2 分钟记违规

export const PUMP_STATE = {
  STANDBY: 'standby',       // 备用（停机）
  RUNNING: 'running',       // 运行
  MAINTENANCE: 'maintenance', // 检修
};

/** 当前连续运行毫秒（含交接时带入的剩余分钟折算）。停泵或检修时为 0。 */
export function elapsedMs(pump, now) {
  if (pump.state !== PUMP_STATE.RUNNING || pump.runStartedAt == null) return 0;
  return Math.max(0, now - pump.runStartedAt);
}

/** 本轮剩余毫秒，到 0 即应换泵。 */
export function remainingMs(pump, now) {
  if (pump.state !== PUMP_STATE.RUNNING) return null;
  return Math.max(0, RUN_LIMIT_MS - elapsedMs(pump, now));
}

/** 是否到达换泵时刻（连续运行满 45 分钟）。 */
export function isDue(pump, now) {
  return pump.state === PUMP_STATE.RUNNING && elapsedMs(pump, now) >= RUN_LIMIT_MS;
}

/**
 * 选取备用泵：备用（停机、非检修）的泵中，累计运行分钟最少者优先，
 * 累计相同取编号靠前者，避免总用同一台。无可用备用返回 null。
 */
export function pickBackup(pumps, excludeId = null) {
  return pumps
    .filter((p) => p.state === PUMP_STATE.STANDBY && p.id !== excludeId)
    .sort((a, b) => a.totalMinutes - b.totalMinutes || a.id.localeCompare(b.id))[0] || null;
}

/** 是否还有可用备用泵。 */
export function hasBackup(pumps) {
  return pumps.some((p) => p.state === PUMP_STATE.STANDBY);
}

/**
 * 四台泵都在运行或检修（没有备用也没有停机）时，判定为缺备用泵超时状态。
 */
export function noBackupCapacity(pumps) {
  return pumps.every((p) => p.state === PUMP_STATE.RUNNING || p.state === PUMP_STATE.MAINTENANCE);
}

/**
 * 空档判定：本次起泵距上一次任一台泵停泵的间隔。
 * 超过 2 分钟记违规；此前从未停过泵（泵站首次开泵）不算违规。
 * @returns {{violation:boolean, gapMs:number|null}}
 */
export function checkStartGap(events, startedAt) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'pump-stop' || e.type === 'pump-switch') {
      const gapMs = startedAt - e.at;
      return { violation: gapMs > GAP_LIMIT_MS, gapMs };
    }
    if (e.type === 'pump-start') {
      // 上一条起泵之前无停泵记录，且当时仍有泵在连续运行 → 属于同时启动，无空档
      return { violation: false, gapMs: null };
    }
  }
  return { violation: false, gapMs: null };
}

/**
 * 停泵保护：最后一台运行泵只允许在水位回到安全线以下时停止。
 * 换泵流程中备用泵已起，不属于最后一台，不受此限。
 * @returns {{allowed:boolean, reason:string|null}}
 */
export function canStopPump(pumps, waterLevel, safetyLine) {
  const running = pumps.filter((p) => p.state === PUMP_STATE.RUNNING);
  if (running.length > 1) return { allowed: true, reason: null };
  if (waterLevel == null) return { allowed: false, reason: '尚未登记水位，无法确认是否回到安全线以下' };
  if (waterLevel >= safetyLine) {
    return { allowed: false, reason: `水位 ${waterLevel.toFixed(2)} 米仍在安全线 ${safetyLine.toFixed(2)} 米以上，不能停泵` };
  }
  return { allowed: true, reason: null };
}

/**
 * 交接时把接班人填写的本轮剩余分钟折算回本轮起算时间戳，
 * 使下一班的 45 分钟计时与剩余分钟无缝衔接。
 */
export function carriedStartAt(remainingMinutes, handoverAt) {
  const minutes = Math.max(0, Number(remainingMinutes) || 0);
  return handoverAt - (RUN_LIMIT_MS - minutes * 60 * 1000);
}

/** 毫秒格式化为 mm:ss（超过 60 分钟显示 h:mm:ss）。 */
export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
