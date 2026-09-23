/**
 * 页面交互层：把档案、轮换规则、本地存档三个业务模块接到界面上。
 * 业务判断一律调用 RotationRules，数据读写一律经过 PumpArchive / LocalStore。
 */
(function () {
  'use strict';

  var Archive = window.PumpArchive;
  var Rules = window.RotationRules;
  var Store = window.LocalStore;

  var state = Store.load() || Archive.createState();

  function $(sel) { return document.querySelector(sel); }
  function now() { return Date.now(); }

  /* ---------------- 动作 ---------------- */

  function startPump(id) {
    var pump = Archive.getPump(state, id);
    if (!pump || pump.status !== Archive.STATUS.STANDBY) return;
    var t = now();

    // 空档检查：上一台停泵到本次启泵超过 2 分钟记违规
    var gap = Rules.gapViolation(state.gapSince, t);
    if (gap !== null && !state.gapLogged) {
      Archive.addLog(state, '违规',
        '换泵空档 ' + gap.toFixed(1) + ' 分钟，超过 ' + Rules.GAP_LIMIT_MIN + ' 分钟上限', id);
    }
    state.gapSince = null;
    state.gapLogged = false;

    pump.status = Archive.STATUS.RUNNING;
    pump.runStart = t;
    pump.rotNotified = false;
    pump.overtime = false;
    Archive.addLog(state, '启泵', pump.name + ' 启动', id);
    commit();
  }

  function stopPump(id) {
    var pump = Archive.getPump(state, id);
    if (!pump) return;

    // 水位未回到安全线下禁止停泵（换泵重叠除外）
    var check = Rules.canStop(state, pump);
    if (!check.ok) { toast(check.reason); return; }

    var t = now();
    var session = Rules.sessionMinutes(pump, t);
    pump.totalMinutes += session;
    pump.status = Archive.STATUS.STANDBY;
    pump.runStart = null;
    pump.rotNotified = false;
    pump.overtime = false;
    Archive.addLog(state, '停泵',
      pump.name + ' 停止，本次运行 ' + session.toFixed(1) + ' 分钟', id);

    // 全部停泵，开始计空档
    if (Archive.runningPumps(state).length === 0) {
      state.gapSince = t;
      state.gapLogged = false;
    }
    commit();
  }

  function toggleMaintenance(id) {
    var pump = Archive.getPump(state, id);
    if (!pump) return;
    if (pump.status === Archive.STATUS.RUNNING) {
      toast('运行中的泵组需先停泵才能转检修');
      return;
    }
    if (pump.status === Archive.STATUS.MAINTENANCE) {
      pump.status = Archive.STATUS.STANDBY;
      Archive.addLog(state, '恢复', pump.name + ' 检修结束，恢复备用', id);
    } else {
      pump.status = Archive.STATUS.MAINTENANCE;
      Archive.addLog(state, '检修', pump.name + ' 转检修', id);
    }
    commit();
  }

  function logWater() {
    var v = parseFloat($('#waterInput').value);
    if (isNaN(v)) { toast('请输入水位数值'); return; }
    var s = parseFloat($('#safetyInput').value);
    if (!isNaN(s) && s > 0) state.waterLevel.safetyLine = s;

    state.waterLevel.current = v;
    var over = v >= state.waterLevel.safetyLine;
    Archive.addLog(state, '水位',
      '水位 ' + v.toFixed(2) + 'm，' + (over ? '达到/超过安全线' : '安全线以下'),
      null, v);
    $('#waterInput').value = '';
    commit();
  }

  function handover() {
    var t = now();
    var infos = Rules.handoverInfo(state, t);
    var name = $('#handoverName').value.trim();

    // 交接时还有泵在跑，必须填交接人，并登记剩余分钟
    if (infos.length > 0 && !name) {
      toast('仍有泵组在运行，请填写交接人');
      return;
    }

    var detail;
    if (infos.length > 0) {
      var parts = infos.map(function (i) {
        var txt = i.pump.name + ' 在运（已运行 ' + Math.floor(i.sessionMin) +
                  ' 分钟，剩余 ' + Math.floor(i.remainingMin) + ' 分钟';
        if (i.overtime) txt += '，已超时';
        return txt + '）';
      });
      detail = '交接人：' + name + '；' + parts.join('；') + '，下一班接着计时';
    } else {
      detail = '交接人：' + (name || '—') + '；无在运泵组';
    }
    Archive.addLog(state, '交接', '第 ' + state.shift.no + ' 班交接。' + detail);

    // 班次推进，运行计时不清零，下一班接着计时
    state.shift.no += 1;
    state.shift.startedAt = t;
    $('#handoverName').value = '';
    commit();
  }

  function resetAll() {
    if (!confirm('确定清空全部台账与存档，重新开始？')) return;
    Store.clear();
    state = Archive.createState();
    commit();
  }

  /* ---------------- 规则巡检（每秒） ---------------- */

  function evaluate() {
    var t = now();
    var changed = false;

    state.pumps.forEach(function (p) {
      if (p.status !== Archive.STATUS.RUNNING) return;

      if (Rules.needsRotation(p, t)) {
        var standby = Rules.pickStandby(state);
        if (!p.rotNotified) {
          p.rotNotified = true;
          changed = true;
          if (standby) {
            Archive.addLog(state, '换泵',
              p.name + ' 连续运行满 ' + Rules.RUN_LIMIT_MIN +
              ' 分钟，请换泵：先起 ' + standby.name + '，再停 ' + p.name, p.id);
          }
        }
        // 四台都在运行或检修 → 无备用泵，标超时、不停机
        if (!standby && !p.overtime) {
          p.overtime = true;
          changed = true;
          Archive.addLog(state, '超时',
            p.name + ' 连续运行满 ' + Rules.RUN_LIMIT_MIN +
            ' 分钟，四台泵组均在运行或检修，缺备用泵，超时运行不停机', p.id);
        }
        // 超时后又有备用泵可用 → 提示换泵
        if (standby && p.overtime) {
          p.overtime = false;
          changed = true;
          Archive.addLog(state, '换泵',
            standby.name + ' 已可用，请换泵：先起 ' + standby.name + '，再停 ' + p.name, p.id);
        }
      }
    });

    // 空档超过 2 分钟，实时记一次违规
    if (state.gapSince && !state.gapLogged && Rules.gapExceeded(state.gapSince, t)) {
      state.gapLogged = true;
      changed = true;
      var gapMin = (t - state.gapSince) / 60000;
      Archive.addLog(state, '违规',
        '换泵空档 ' + gapMin.toFixed(1) + ' 分钟，超过 ' + Rules.GAP_LIMIT_MIN + ' 分钟上限');
    }

    if (changed) commit(); else render(t);
  }

  /* ---------------- 渲染 ---------------- */

  function fmtDuration(minFloat) {
    var totalSec = Math.max(0, Math.floor(minFloat * 60));
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function render(t) {
    t = t || now();
    $('#clock').textContent = Store.formatTime(t);
    $('#shiftLabel').textContent = '第 ' + state.shift.no + ' 班';
    renderWater();
    renderPumps(t);
    renderHandover(t);
    renderAlerts(t);
    renderLogs();
  }

  function renderWater() {
    var wl = state.waterLevel;
    $('#waterNow').textContent = wl.current === null ? '--' : wl.current.toFixed(2);
    $('#safetyInput').value = wl.safetyLine;
    var el = $('#waterStatus');
    if (wl.current === null) {
      el.textContent = '尚未登记';
      el.className = 'water-status';
    } else if (wl.current >= wl.safetyLine) {
      el.textContent = '达到/超过安全线 ' + wl.safetyLine.toFixed(2) + 'm，禁止停泵';
      el.className = 'water-status over';
    } else {
      el.textContent = '安全线 ' + wl.safetyLine.toFixed(2) + 'm 以下，可以停泵';
      el.className = 'water-status safe';
    }
  }

  function renderPumps(t) {
    var grid = $('#pumpGrid');
    grid.innerHTML = '';
    state.pumps.forEach(function (p) {
      var session = Rules.sessionMinutes(p, t);
      var pct = Math.min(100, session / Rules.RUN_LIMIT_MIN * 100);
      var over = Rules.needsRotation(p, t);

      var card = document.createElement('div');
      card.className = 'pump-card ' + p.status + (p.overtime ? ' overtime' : '');

      var badges = '<span class="badge ' + p.status + '">' +
                   Archive.STATUS_LABEL[p.status] + '</span>';
      if (p.overtime) badges += '<span class="badge overtime">超时</span>';

      card.innerHTML =
        '<div class="pump-head"><span class="pump-name">' + p.name + '</span>' +
          '<span>' + badges + '</span></div>' +
        '<div class="pump-session">' +
          (p.status === 'running'
            ? fmtDuration(session) + ' <small>/ ' + Rules.RUN_LIMIT_MIN + ':00</small>'
            : '-- <small>本次运行</small>') +
        '</div>' +
        '<div class="progress' + (over ? ' over' : '') + '">' +
          '<div style="width:' + (p.status === 'running' ? pct : 0) + '%"></div></div>' +
        '<div class="pump-total">累计运行 ' + Math.floor(p.totalMinutes) + ' 分钟</div>' +
        '<div class="pump-actions"></div>';

      var actions = card.querySelector('.pump-actions');
      actions.appendChild(makeBtn('启泵', function () { startPump(p.id); },
        p.status !== Archive.STATUS.STANDBY));
      actions.appendChild(makeBtn('停泵', function () { stopPump(p.id); },
        p.status !== Archive.STATUS.RUNNING));
      actions.appendChild(makeBtn(
        p.status === Archive.STATUS.MAINTENANCE ? '恢复' : '检修',
        function () { toggleMaintenance(p.id); },
        p.status === Archive.STATUS.RUNNING));

      grid.appendChild(card);
    });
  }

  function makeBtn(text, onclick, disabled) {
    var b = document.createElement('button');
    b.className = 'btn';
    b.textContent = text;
    b.disabled = !!disabled;
    b.addEventListener('click', onclick);
    return b;
  }

  function renderHandover(t) {
    var infos = Rules.handoverInfo(state, t);
    var el = $('#handoverInfo');
    if (!infos.length) {
      el.innerHTML = '当前无在运泵组，可直接交接。';
      return;
    }
    el.innerHTML = infos.map(function (i) {
      return '<strong>' + i.pump.name + '</strong> 在运：已运行 ' +
             Math.floor(i.sessionMin) + ' 分钟，剩余 ' +
             Math.floor(i.remainingMin) + ' 分钟' + (i.overtime ? '（已超时）' : '');
    }).join('<br>') + '<br>交接后下一班接着计时，请填写交接人。';
  }

  function renderAlerts(t) {
    var box = $('#alerts');
    var html = '';

    var wl = state.waterLevel;
    if (wl.current !== null && wl.current >= wl.safetyLine) {
      html += '<div class="alert info">水位 ' + wl.current.toFixed(2) +
              'm 达到/超过安全线 ' + wl.safetyLine.toFixed(2) + 'm，水位回到安全线下才能停泵。</div>';
    }

    state.pumps.forEach(function (p) {
      if (p.status !== Archive.STATUS.RUNNING || !Rules.needsRotation(p, t)) return;
      if (p.overtime) {
        html += '<div class="alert danger">缺备用泵：' + p.name +
                ' 已超时运行（四台泵组均在运行或检修），不停机，请尽快恢复备用泵。</div>';
      } else {
        var standby = Rules.pickStandby(state);
        html += '<div class="alert warn">请换泵：' + p.name + ' 已连续运行满 ' +
                Rules.RUN_LIMIT_MIN + ' 分钟，先起备用泵' +
                (standby ? '（建议 ' + standby.name + '）' : '') + '，再停 ' + p.name + '。</div>';
      }
    });

    if (state.gapSince) {
      var gapMin = (t - state.gapSince) / 60000;
      var cls = Rules.gapExceeded(state.gapSince, t) ? 'danger' : 'warn';
      html += '<div class="alert ' + cls + '">当前无泵组运行，空档已 ' +
              gapMin.toFixed(1) + ' 分钟（上限 ' + Rules.GAP_LIMIT_MIN + ' 分钟）。</div>';
    }

    box.innerHTML = html;
  }

  function renderLogs() {
    var body = $('#logBody');
    var logs = state.logs.slice(-300).reverse();
    body.innerHTML = logs.map(function (l) {
      return '<tr>' +
        '<td>' + Store.formatTime(l.ts) + '</td>' +
        '<td>第' + l.shiftNo + '班</td>' +
        '<td class="log-type ' + l.type + '">' + l.type + '</td>' +
        '<td>' + (l.pumpName || '') + '</td>' +
        '<td>' + (l.waterLevel === null ? '' : l.waterLevel.toFixed(2)) + '</td>' +
        '<td>' + l.detail + '</td>' +
      '</tr>';
    }).join('');
  }

  /* ---------------- 存档 ---------------- */

  var lastSaveAt = 0;

  function commit() {
    Store.save(state);
    lastSaveAt = now();
    $('#saveInfo').textContent = '已自动保存 ' + Store.formatTime(lastSaveAt);
    render();
  }

  /* ---------------- 启动 ---------------- */

  $('#btnWater').addEventListener('click', logWater);
  $('#btnHandover').addEventListener('click', handover);
  $('#btnExportCsv').addEventListener('click', function () { Store.exportCsv(state); });
  $('#btnExportJson').addEventListener('click', function () { Store.exportJson(state); });
  $('#btnReset').addEventListener('click', resetAll);
  window.addEventListener('beforeunload', function () { Store.save(state); });

  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3000);
  }

  if (Store.load()) {
    $('#saveInfo').textContent = '已恢复上次存档';
  }
  render();
  setInterval(evaluate, 1000);
})();
