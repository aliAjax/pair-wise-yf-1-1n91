/**
 * 业务文件一：档案
 * 负责泵组档案（四台预置泵组）与值守台账记录的登记、查询。
 * 不掺杂轮换规则与存档逻辑。
 */
window.PumpArchive = (function () {
  'use strict';

  /** 泵组状态枚举 */
  var STATUS = {
    RUNNING: 'running',       // 运行
    STANDBY: 'standby',       // 备用
    MAINTENANCE: 'maintenance' // 检修
  };

  var STATUS_LABEL = {
    running: '运行中',
    standby: '备用',
    maintenance: '检修'
  };

  /** 预置四台泵组 */
  var PUMP_PRESET = [
    { id: 'P1', name: '1号泵组' },
    { id: 'P2', name: '2号泵组' },
    { id: 'P3', name: '3号泵组' },
    { id: 'P4', name: '4号泵组' }
  ];

  function createPumps() {
    return PUMP_PRESET.map(function (p) {
      return {
        id: p.id,
        name: p.name,
        status: STATUS.STANDBY,
        totalMinutes: 0,   // 累计运行分钟
        runStart: null,    // 本次启动时间戳（毫秒），停泵时清零
        rotNotified: false, // 本次运行是否已提示过换泵
        overtime: false     // 是否处于超时运行（缺备用泵）
      };
    });
  }

  /** 初始档案状态 */
  function createState() {
    return {
      pumps: createPumps(),
      waterLevel: {
        current: null,     // 当前水位（米）
        safetyLine: 2.5    // 安全线（米），可调整
      },
      logs: [],            // 台账记录
      shift: { no: 1, startedAt: Date.now() }, // 当前班次
      gapSince: null,      // 全部停泵后的空档起点时间戳
      gapLogged: false     // 本次空档是否已记违规
    };
  }

  /** 台账登记 */
  function addLog(state, type, detail, pumpId, waterLevel) {
    var pump = pumpId ? getPump(state, pumpId) : null;
    var entry = {
      ts: Date.now(),
      shiftNo: state.shift.no,
      type: type,
      pumpId: pump ? pump.id : '',
      pumpName: pump ? pump.name : '',
      waterLevel: (typeof waterLevel === 'number') ? waterLevel : null,
      detail: detail
    };
    state.logs.push(entry);
    return entry;
  }

  function getPump(state, id) {
    for (var i = 0; i < state.pumps.length; i++) {
      if (state.pumps[i].id === id) return state.pumps[i];
    }
    return null;
  }

  function pumpsByStatus(state, status) {
    return state.pumps.filter(function (p) { return p.status === status; });
  }

  function runningPumps(state) { return pumpsByStatus(state, STATUS.RUNNING); }
  function standbyPumps(state) { return pumpsByStatus(state, STATUS.STANDBY); }

  return {
    STATUS: STATUS,
    STATUS_LABEL: STATUS_LABEL,
    createState: createState,
    addLog: addLog,
    getPump: getPump,
    runningPumps: runningPumps,
    standbyPumps: standbyPumps
  };
})();
