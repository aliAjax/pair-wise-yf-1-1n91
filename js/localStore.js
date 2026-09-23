/**
 * 业务文件三：本地存档
 * 负责台账与泵组档案在浏览器 localStorage 的持久化，以及导出备份。
 */
window.LocalStore = (function () {
  'use strict';

  var KEY = 'pump-station-ledger-v1';

  /** 保存当前状态 */
  function save(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.error('本地存档失败', e);
      return false;
    }
  }

  /** 读取存档，无存档或损坏时返回 null */
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('读取存档失败', e);
      return null;
    }
  }

  /** 清空存档 */
  function clear() {
    localStorage.removeItem(KEY);
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function stamp() {
    var d = new Date();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
           '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  /** 导出整份备份（JSON，可用于恢复/移交） */
  function exportJson(state) {
    download('泵站台账备份-' + stamp() + '.json',
             JSON.stringify(state, null, 2),
             'application/json');
  }

  /** 导出台账（CSV，可直接用 Excel 打开打印，替代纸质台账） */
  function exportCsv(state) {
    var header = ['时间', '班次', '类型', '泵组', '水位(m)', '内容'];
    var rows = state.logs.map(function (l) {
      return [
        formatTime(l.ts),
        '第' + l.shiftNo + '班',
        l.type,
        l.pumpName,
        l.waterLevel === null ? '' : l.waterLevel.toFixed(2),
        l.detail
      ];
    });
    var csv = [header].concat(rows).map(function (r) {
      return r.map(function (c) {
        c = String(c);
        return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
      }).join(',');
    }).join('\r\n');
    // 加 BOM 让 Excel 正确识别中文
    download('泵站值守台账-' + stamp() + '.csv', '﻿' + csv, 'text/csv;charset=utf-8');
  }

  function formatTime(ts) {
    var d = new Date(ts);
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  return {
    KEY: KEY,
    save: save,
    load: load,
    clear: clear,
    exportJson: exportJson,
    exportCsv: exportCsv,
    formatTime: formatTime
  };
})();
