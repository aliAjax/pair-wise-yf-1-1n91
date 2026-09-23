/**
 * 业务文件二：轮换规则
 * 纯规则判定，不操作界面、不做存档：
 *  - 同一台泵连续运行满 45 分钟须换泵
 *  - 换泵先起备用泵、再停旧泵；空档超过 2 分钟记违规
 *  - 水位回到安全线下才能停泵
 *  - 四台泵都在运行或检修时标超时，不停机并提示缺备用泵
 *  - 交接班时在运泵组需登记交接人与剩余分钟，下一班接着计时
 */
window.RotationRules = (function () {
  'use strict';

  var RUN_LIMIT_MIN = 45; // 连续运行上限（分钟）
  var GAP_LIMIT_MIN = 2;  // 换泵空档上限（分钟）

  /** 本次连续运行分钟数 */
  function sessionMinutes(pump, now) {
    if (pump.status !== 'running' || !pump.runStart) return 0;
    return (now - pump.runStart) / 60000;
  }

  /** 距 45 分钟上限的剩余分钟（超时后为 0） */
  function remainingMinutes(pump, now) {
    return Math.max(0, RUN_LIMIT_MIN - sessionMinutes(pump, now));
  }

  /** 是否已连续运行满 45 分钟，需要换泵 */
  function needsRotation(pump, now) {
    return pump.status === 'running' && sessionMinutes(pump, now) >= RUN_LIMIT_MIN;
  }

  /** 挑选一台备用泵（档案中状态为备用的第一台） */
  function pickStandby(state) {
    var list = window.PumpArchive.standbyPumps(state);
    return list.length ? list[0] : null;
  }

  /**
   * 超时判定：已需换泵，但四台泵都在运行或检修（无备用泵）。
   * 超时不停机，仅标记并提示。
   */
  function isOvertime(state, pump, now) {
    return needsRotation(pump, now) && !pickStandby(state);
  }

  /**
   * 停泵许可：水位须回到安全线下才能停泵；
   * 换泵重叠期间（已有其他泵在跑）允许停旧泵。
   */
  function canStop(state, pump) {
    if (pump.status !== 'running') {
      return { ok: false, reason: '该泵组未在运行' };
    }
    var othersRunning = state.pumps.some(function (p) {
      return p.id !== pump.id && p.status === 'running';
    });
    var wl = state.waterLevel;
    if (!othersRunning && wl.current !== null && wl.current >= wl.safetyLine) {
      return {
        ok: false,
        reason: '水位 ' + wl.current.toFixed(2) + 'm 未回到安全线 ' +
                wl.safetyLine.toFixed(2) + 'm 以下，禁止停泵'
      };
    }
    return { ok: true };
  }

  /**
   * 空档违规判定：上一台停泵到下一台启泵的间隔超过 2 分钟。
   * 返回空档分钟数，未违规返回 null。
   */
  function gapViolation(gapSince, startTs) {
    if (!gapSince) return null;
    var gapMin = (startTs - gapSince) / 60000;
    return gapMin > GAP_LIMIT_MIN ? gapMin : null;
  }

  /** 空档是否已超过上限（用于值守中实时预警） */
  function gapExceeded(gapSince, now) {
    return !!gapSince && (now - gapSince) / 60000 > GAP_LIMIT_MIN;
  }

  /**
   * 交接班信息：在运泵组及其剩余分钟，供交接登记与下一班接着计时。
   */
  function handoverInfo(state, now) {
    return window.PumpArchive.runningPumps(state).map(function (p) {
      return {
        pump: p,
        sessionMin: sessionMinutes(p, now),
        remainingMin: remainingMinutes(p, now),
        overtime: needsRotation(p, now)
      };
    });
  }

  return {
    RUN_LIMIT_MIN: RUN_LIMIT_MIN,
    GAP_LIMIT_MIN: GAP_LIMIT_MIN,
    sessionMinutes: sessionMinutes,
    remainingMinutes: remainingMinutes,
    needsRotation: needsRotation,
    pickStandby: pickStandby,
    isOvertime: isOvertime,
    canStop: canStop,
    gapViolation: gapViolation,
    gapExceeded: gapExceeded,
    handoverInfo: handoverInfo
  };
})();
