// 业务规则冒烟测试（node js/test-rules.mjs），不依赖浏览器。
import assert from 'node:assert';
import { createInitialState, recordWaterLevel, startPump, stopPump, switchPump, toggleMaintenance, handover, evaluateTick, describeEvent } from './archive.js';
import { RUN_LIMIT_MS, GAP_LIMIT_MS, PUMP_STATE } from './rotation.js';

const MIN = 60 * 1000;
let t = 1_000_000_000_000;
const now = () => t;
const advance = (ms) => { t += ms; };

// 1. 初始：四台泵全部备用
let s = createInitialState();
assert.equal(s.pumps.length, 4);
assert.ok(s.pumps.every((p) => p.state === PUMP_STATE.STANDBY));

// 2. 水位高于安全线时最后一台泵不能停
recordWaterLevel(s, 6.0);
startPump(s, 'P1', now());
assert.equal(stopPump(s, 'P1', now()).ok, false);
advance(30 * MIN);
assert.equal(switchPump(s, 'P1', now()).ok, false, '未到45分钟不应允许换泵');
advance(16 * MIN);

// 到点后先起累计最少的备用泵（P2），再停旧泵
assert.equal(switchPump(s, 'P1', now()).ok, true);
assert.equal(s.pumps[0].state, PUMP_STATE.STANDBY);
assert.equal(s.pumps[1].state, PUMP_STATE.RUNNING);
assert.ok(s.pumps[0].totalMinutes >= 46);
const startIdx = s.events.findIndex((e) => e.type === 'pump-start' && e.pumpId === 'P2');
const stopIdx = s.events.findIndex((e) => e.type === 'pump-stop' && e.pumpId === 'P1');
assert.ok(startIdx >= 0 && startIdx < stopIdx, '换泵必须先起备用再停旧泵');

// 4. 无备用泵时换泵被拒 → 四台全在运行/检修 → evaluateTick 标记超时且不停机
t = 2_000_000_000_000;
let s2 = createInitialState();
recordWaterLevel(s2, 7);
['P1', 'P2', 'P3'].forEach((id) => startPump(s2, id, t));
toggleMaintenance(s2, 'P4', t);
advance(RUN_LIMIT_MS + MIN);
assert.equal(switchPump(s2, 'P1', now()).ok, false);
const evs = evaluateTick(s2, now());
assert.equal(evs.length, 3, '三台运行泵各应产生一条超时事件');
assert.ok(s2.pumps.filter((p) => p.state === PUMP_STATE.RUNNING).length === 3, '超时不停机');
assert.ok(s2.pumps.filter((p) => p.state === PUMP_STATE.RUNNING).every((p) => p.overtimeMarked));
assert.equal(s2.pumps.find((p) => p.id === 'P4').overtimeMarked, false);
// 恢复备用后解除超时
toggleMaintenance(s2, 'P4', now());
evaluateTick(s2, now());
assert.ok(s2.pumps.every((p) => !p.overtimeMarked));

// 5. 空档违规：最后一台泵送修（水位仍高），超过 2 分钟巡检记违规；起泵后解除
t = 3_000_000_000_000;
let s3 = createInitialState();
recordWaterLevel(s3, 5.5);
startPump(s3, 'P1', t);
advance(10 * MIN);
toggleMaintenance(s3, 'P1', now());
assert.equal(evaluateTick(s3, now()).length, 0, '2分钟内不算违规');
advance(GAP_LIMIT_MS + 1000);
const bad = evaluateTick(s3, now());
assert.equal(bad.length, 1);
assert.equal(bad[0].type, 'gap-violation');
// 再巡检不重复记
assert.equal(evaluateTick(s3, now()).length, 0);
const started = startPump(s3, 'P2', now());
assert.equal(started.violation, false, '该次空档违规已由巡检记录，起泵不重复记');

// 6. 水位回到安全线下才能停最后一台泵
t = 4_000_000_000_000;
let s4 = createInitialState();
recordWaterLevel(s4, 5.0);
startPump(s4, 'P1', t);
assert.equal(stopPump(s4, 'P1', t).ok, false, '水位恰在安全线上仍不能停');
recordWaterLevel(s4, 4.99);
assert.equal(stopPump(s4, 'P1', t).ok, true);
assert.ok(s4.pumps[0].totalMinutes >= 0);

// 7. 交接班：剩余分钟折算，下一班继续计时
t = 5_000_000_000_000;
let s5 = createInitialState();
recordWaterLevel(s5, 6);
startPump(s5, 'P1', t);
advance(30 * MIN); // 已跑 30 分钟，交接时填剩余 15 分钟
const hr = handover(s5, { from: '张工', to: '李工', remainingByPump: { P1: 15 } }, now());
assert.equal(hr.ok, true);
assert.equal(s5.currentOperator, '李工');
const expectedStart = now() - (RUN_LIMIT_MS - 15 * MIN);
assert.equal(s5.pumps[0].runStartedAt, expectedStart);
// 再跑 15 分钟即到点可换泵
advance(15 * MIN);
assert.equal(switchPump(s5, 'P1', now()).ok, true, '接班后按剩余15分钟继续计时，到点应可换泵');

// 8. 交接校验
assert.equal(handover(s5, { from: '', to: '王', remainingByPump: {} }, now()).ok, false);
let s6 = createInitialState();
startPump(s6, 'P1', now());
assert.equal(handover(s6, { from: 'a', to: 'b', remainingByPump: { P1: 99 } }, now()).ok, false);

// 9. 台账文案均可生成，不抛错
for (const ev of [...s.events, ...s2.events, ...s3.events, ...s4.events, ...s5.events]) {
  const text = describeEvent(
    ev.at > 2_500_000_000_000 ? s5 : ev.at > 1_500_000_000_000 ? s2 : s,
    ev
  );
  assert.ok(typeof text === 'string' && text.length > 0);
}

console.log('全部规则测试通过 ✔');
