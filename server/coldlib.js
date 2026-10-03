// 温控口径都集中在这里：参与判定的记录、超限段、断链、MKT、放行判定、判定依据与反事实
const store = require('./store');

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function recordsOfBatch(data, batchId) {
  return data.records
    .filter((r) => r.batchId === batchId)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function probeOf(data, probeId) {
  return data.probes.find((p) => p.id === probeId) || null;
}

function dayOf(at) {
  return String(at).slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((toDate(b + ' 00:00:00') - toDate(a + ' 00:00:00')) / 86400000);
}

// 参与判定的记录：
// 1) 停用探头名下的记录不参与；
// 2) 同一探头同一时刻既有自动又有手工更正时，以手工为准。
// 返回 { rows, overrides, suppressed }，把取舍依据一并带出来。
function effectiveRecordsDetailed(data, batchId) {
  const settings = data.settings;
  const grace = Number(settings.probeCalibrationGraceDays || 0);
  const picked = {};
  const order = [];
  const overrides = [];
  const suppressed = [];
  for (const row of recordsOfBatch(data, batchId)) {
    const probe = probeOf(data, row.probeId);
    if (probe && probe.status === '停用') {
      suppressed.push({ recordId: row.id, probeId: probe.id, probeCode: probe.code, at: row.at, temperatureC: Number(row.temperatureC), source: row.source });
      continue;
    }
    const key = row.probeId + '|' + row.at;
    if (picked[key] === undefined) {
      picked[key] = row;
      order.push(key);
      continue;
    }
    const current = picked[key];
    if (row.source === '人工' && current.source === '自动') {
      overrides.push({
        recordId: row.id, droppedRecordId: current.id, probeId: row.probeId,
        probeCode: probe ? probe.code : '', at: row.at,
        manualC: Number(row.temperatureC), autoC: Number(current.temperatureC),
      });
      picked[key] = row;
    } else if (row.source === '自动' && current.source === '人工') {
      overrides.push({
        recordId: current.id, droppedRecordId: row.id, probeId: row.probeId,
        probeCode: probe ? probe.code : '', at: row.at,
        manualC: Number(current.temperatureC), autoC: Number(row.temperatureC),
      });
    }
  }
  return { rows: order.map((key) => picked[key]), overrides, suppressed, grace };
}

function effectiveRecords(data, batchId) {
  return effectiveRecordsDetailed(data, batchId).rows;
}

function isOutOfRange(value, settings) {
  return value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
}

// 超限：连续超出上下限的时段，回到范围内即断开；
// 每段时长只累加段内相邻两条超限记录之间的实际时刻差（不是固定记录间隔）。
function segmentStats(rows, settings) {
  const segments = [];
  let current = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const value = Number(row.temperatureC);
    if (!isOutOfRange(value, settings)) { current = null; continue; }
    const prev = i > 0 ? rows[i - 1] : null;
    const prevOut = !!prev && isOutOfRange(Number(prev.temperatureC), settings);
    const gapMinutes = prevOut ? Math.max(0, store.minutesBetween(prev.at, row.at)) : 0;
    if (!current) {
      current = {
        index: segments.length + 1,
        startAt: row.at, endAt: row.at, minutes: 0,
        peakC: value, peakAt: row.at, points: 0, records: [],
      };
      segments.push(current);
    }
    current.records.push({ id: row.id, at: row.at, temperatureC: value, probeId: row.probeId, source: row.source, gapMinutes });
    current.points += 1;
    current.endAt = row.at;
    current.minutes += gapMinutes;
    if (value > current.peakC) { current.peakC = value; current.peakAt = row.at; }
  }
  const longest = segments.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, peakAt: '', points: 0, records: [], index: 0 });
  const total = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longestMinutes: longest.minutes, longest, totalMinutes: total, segmentCount: segments.length };
}

function excursionStats(data, batchId, settingsOverride) {
  const settings = Object.assign({}, data.settings, settingsOverride || {});
  const rows = effectiveRecords(data, batchId);
  const stats = segmentStats(rows, settings);
  return Object.assign({}, stats, {
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  });
}

// 断链：相邻记录的时刻差超过门槛（严格大于）
function chainGaps(data, batchId, settingsOverride) {
  const settings = Object.assign({}, data.settings, settingsOverride || {});
  const rows = effectiveRecords(data, batchId);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      gaps.push({
        index: gaps.length + 1,
        from: rows[i - 1].at, to: rows[i].at, minutes,
        thresholdMinutes: Number(settings.chainGapMinutes),
        overMinutes: minutes - Number(settings.chainGapMinutes),
        fromRecordId: rows[i - 1].id, toRecordId: rows[i].id,
        probeId: rows[i].probeId,
      });
    }
  }
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.minutes, 0), maxGapMinutes: gaps.reduce((acc, g) => Math.max(acc, g.minutes), 0) };
}

// MKT：平均动力学温度，不是算术平均
// MKT = −Ea / (R × ln((Σ e^(−Ea/(R·T))) / n)) − 273.15
function mktCelsius(data, batchId, settingsOverride) {
  const settings = Object.assign({}, data.settings, settingsOverride || {});
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return 0;
  const ea = Number(settings.mktActivationEnergy || 83144);
  const r = Number(settings.gasConstant || 8.314);
  let sum = 0;
  for (const row of rows) sum += Math.exp(-ea / (r * (Number(row.temperatureC) + 273.15)));
  const mktK = -ea / (r * Math.log(sum / rows.length));
  return store.round(mktK - 273.15, 2);
}

// 探头校准有效期（可含宽限天数）
function probeValidOn(probe, day, graceDays) {
  if (!probe || !probe.calibratedUntil) return true;
  const grace = Number(graceDays || 0);
  return String(day) <= String(probe.calibratedUntil) || daysBetween(String(probe.calibratedUntil), String(day)) <= grace;
}

function expiredProbes(data, batchId, graceDays) {
  const rows = effectiveRecords(data, batchId);
  const bad = {};
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe || !probe.calibratedUntil) continue;
    const day = dayOf(row.at);
    if (String(day) <= String(probe.calibratedUntil)) continue;
    if (daysBetween(String(probe.calibratedUntil), day) <= Number(graceDays || 0)) continue;
    if (!bad[probe.id]) {
      bad[probe.id] = {
        probeId: probe.id, probeCode: probe.code, calibratedUntil: probe.calibratedUntil,
        firstAt: row.at, lastAt: row.at, recordCount: 0, daysOver: 0, graceDays: Number(graceDays || 0),
      };
    }
    const item = bad[probe.id];
    if (row.at < item.firstAt) item.firstAt = row.at;
    if (row.at > item.lastAt) item.lastAt = row.at;
    item.recordCount += 1;
    item.daysOver = Math.max(item.daysOver, daysBetween(String(probe.calibratedUntil), day));
  }
  return Object.keys(bad).map((id) => bad[id]);
}

// 累计超限时长：按批次周期累计，跨月不重置
function accumulatedExcursionMinutes(data, batchId, settingsOverride) {
  return excursionStats(data, batchId, settingsOverride).totalMinutes;
}

// 把某次判定完整拆开：参与的记录、各口径原始值、四条（加无记录共五条）条件与依据
function evaluateBatch(data, batch, opt) {
  const options = opt || {};
  const settings = Object.assign({}, data.settings, options.settings || {});
  const detail = effectiveRecordsDetailed(data, batch.id);
  const rows = detail.rows;
  const stats = segmentStats(rows, settings);
  const chain = chainGapsWithRows(rows, settings);
  const expired = expiredProbesWithRows(data, rows, Number(settings.probeCalibrationGraceDays || 0));
  const mkt = rows.length ? mktWithRows(rows, settings) : 0;

  const limitLong = Number(settings.allowExcursionMinutes);
  const limitTotal = Number(settings.allowTotalExcursionMinutes);
  const hasRecords = rows.length > 0;

  const conditions = [
    {
      key: 'records',
      ok: hasRecords,
      value: rows.length,
      limit: 1,
      unit: '条',
      text: '有温度记录才能放行',
      evidence: hasRecords ? null : { reason: '这个批次没有任何参与判定的温度记录（停用探头名下记录不计入）' },
    },
    {
      key: 'longest',
      ok: hasRecords && stats.longestMinutes <= limitLong,
      value: hasRecords ? stats.longestMinutes : null,
      limit: limitLong,
      unit: '分钟',
      text: '单次连续超限不超过 ' + limitLong + ' 分钟',
      evidence: longestEvidence(stats, hasRecords),
    },
    {
      key: 'total',
      ok: hasRecords && stats.totalMinutes <= limitTotal,
      value: hasRecords ? stats.totalMinutes : null,
      limit: limitTotal,
      unit: '分钟',
      text: '累计超限不超过 ' + limitTotal + ' 分钟（跨月不重置）',
      evidence: totalEvidence(stats, hasRecords),
    },
    {
      key: 'chain',
      ok: hasRecords && chain.gapCount === 0,
      value: hasRecords ? chain.gapCount : null,
      limit: 0,
      unit: '处',
      text: '全程没有断链（相邻记录间隔不超过 ' + Number(settings.chainGapMinutes) + ' 分钟）',
      evidence: chainEvidence(chain, hasRecords, Number(settings.chainGapMinutes)),
    },
    {
      key: 'calibration',
      ok: hasRecords && expired.length === 0,
      value: expired.length,
      limit: 0,
      unit: '台',
      text: '参与判定的探头都在校准有效期内',
      evidence: calibrationEvidence(expired, hasRecords),
    },
  ];

  return {
    mkt,
    longestMinutes: stats.longestMinutes,
    totalMinutes: stats.totalMinutes,
    recordCount: rows.length,
    rawRecordCount: recordsOfBatch(data, batch.id).length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
    chain,
    expiredProbes: expired,
    segments: stats.segments.map(plainSegment),
    longestSegment: stats.longest.index ? plainSegment(stats.longest) : null,
    overrides: detail.overrides,
    suppressed: detail.suppressed,
    graceDays: Number(settings.probeCalibrationGraceDays || 0),
    settings: {
      lowerLimitC: Number(settings.lowerLimitC),
      upperLimitC: Number(settings.upperLimitC),
      allowExcursionMinutes: limitLong,
      allowTotalExcursionMinutes: limitTotal,
      chainGapMinutes: Number(settings.chainGapMinutes),
      recordIntervalMinutes: Number(settings.recordIntervalMinutes),
      probeCalibrationGraceDays: Number(settings.probeCalibrationGraceDays || 0),
    },
    conditions,
    pass: conditions.every((c) => c.ok),
    failed: conditions.filter((c) => !c.ok).map((c) => c.key),
  };
}

function plainSegment(s) {
  return {
    index: s.index, startAt: s.startAt, endAt: s.endAt, minutes: s.minutes,
    peakC: s.peakC, peakAt: s.peakAt, points: s.points,
    records: s.records.map((p) => ({ id: p.id, at: p.at, temperatureC: p.temperatureC, probeId: p.probeId, source: p.source, gapMinutes: p.gapMinutes })),
  };
}

function longestEvidence(stats, hasRecords) {
  if (!hasRecords) return null;
  if (!stats.segmentCount) return { segmentCount: 0, longestMinutes: 0, longest: null, text: '全程温度都在带内，没有超限段' };
  return {
    segmentCount: stats.segmentCount,
    longestMinutes: stats.longestMinutes,
    longest: plainSegment(stats.longest),
    text: '共 ' + stats.segmentCount + ' 段超限；最长的是第 ' + stats.longest.index + ' 段（' +
      stats.longest.startAt + ' 至 ' + stats.longest.endAt + '），' + stats.longest.minutes + ' 分钟，由 ' +
      stats.longest.points + ' 条连续超限记录构成，峰值 ' + stats.longest.peakC + '℃（' + stats.longest.peakAt + '）',
  };
}

function totalEvidence(stats, hasRecords) {
  if (!hasRecords) return null;
  return {
    segmentCount: stats.segmentCount,
    totalMinutes: stats.totalMinutes,
    parts: stats.segments.map((s) => ({
      index: s.index, startAt: s.startAt, endAt: s.endAt, minutes: s.minutes,
      peakC: s.peakC, points: s.points,
    })),
    text: stats.segmentCount
      ? '累计超限由 ' + stats.segmentCount + ' 段构成：' +
        stats.segments.map((s) => '第' + s.index + '段 ' + s.minutes + ' 分钟').join('＋') +
        '＝' + stats.totalMinutes + ' 分钟'
      : '没有超限段，累计 0 分钟',
  };
}

function chainEvidence(chain, hasRecords, threshold) {
  if (!hasRecords) return null;
  if (!chain.gapCount) return { gapCount: 0, gaps: [], text: '相邻记录间隔都不超过 ' + threshold + ' 分钟，没有断链' };
  return {
    gapCount: chain.gapCount,
    thresholdMinutes: threshold,
    gaps: chain.gaps,
    text: '共 ' + chain.gapCount + ' 处断链：' + chain.gaps.map((g) =>
      g.from.slice(5) + ' 的记录之后到 ' + g.to.slice(5) + ' 之间缺了 ' + g.minutes + ' 分钟（门槛 ' + threshold + ' 分钟，超 ' + g.overMinutes + ' 分钟）').join('；'),
  };
}

function calibrationEvidence(expired, hasRecords) {
  if (!hasRecords) return null;
  if (!expired.length) return { expiredCount: 0, probes: [], text: '参与判定的探头在校准有效期内' };
  return {
    expiredCount: expired.length,
    probes: expired,
    text: expired.length + ' 台探头已过校准有效期：' + expired.map((p) =>
      p.probeCode + ' 校准有效期到 ' + p.calibratedUntil + '，最早过期记录在 ' + p.firstAt +
      '（已超 ' + p.daysOver + ' 天，名下 ' + p.recordCount + ' 条记录参与判定）').join('；'),
  };
}

function chainGapsWithRows(rows, settings) {
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = Math.max(0, store.minutesBetween(rows[i - 1].at, rows[i].at));
    if (minutes > Number(settings.chainGapMinutes)) {
      gaps.push({
        index: gaps.length + 1,
        from: rows[i - 1].at, to: rows[i].at, minutes,
        thresholdMinutes: Number(settings.chainGapMinutes),
        overMinutes: minutes - Number(settings.chainGapMinutes),
        fromRecordId: rows[i - 1].id, toRecordId: rows[i].id,
        probeId: rows[i].probeId,
      });
    }
  }
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.minutes, 0), maxGapMinutes: gaps.reduce((acc, g) => Math.max(acc, g.minutes), 0) };
}

function expiredProbesWithRows(data, rows, graceDays) {
  const bad = {};
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe || !probe.calibratedUntil) continue;
    const day = dayOf(row.at);
    if (String(day) <= String(probe.calibratedUntil)) continue;
    if (daysBetween(String(probe.calibratedUntil), day) <= graceDays) continue;
    if (!bad[probe.id]) {
      bad[probe.id] = {
        probeId: probe.id, probeCode: probe.code, calibratedUntil: probe.calibratedUntil,
        firstAt: row.at, lastAt: row.at, recordCount: 0, daysOver: 0, graceDays,
      };
    }
    const item = bad[probe.id];
    if (row.at < item.firstAt) item.firstAt = row.at;
    if (row.at > item.lastAt) item.lastAt = row.at;
    item.recordCount += 1;
    item.daysOver = Math.max(item.daysOver, daysBetween(String(probe.calibratedUntil), day));
  }
  return Object.keys(bad).map((id) => bad[id]);
}

function mktWithRows(rows, settings) {
  const ea = Number(settings.mktActivationEnergy || 83144);
  const r = Number(settings.gasConstant || 8.314);
  let sum = 0;
  for (const row of rows) sum += Math.exp(-ea / (r * (Number(row.temperatureC) + 273.15)));
  const mktK = -ea / (r * Math.log(sum / rows.length));
  return store.round(mktK - 273.15, 2);
}

// 放行判定
function releaseCheck(data, batch) {
  return evaluateBatch(data, batch, {});
}

/* ================= 反事实解释 =================
   回答两类问题：
   A. 单独（或组合）改哪几条记录的温度到带内，结论会翻转；
   B. 哪项判定参数放宽到多少，结论会翻转。
   判定只区分“在带内/带外”：一个点进带后，它所在的超限段会在该点断开（单点不计时长），
   继续往带内改不会再改变判定——所以改记录的临界温度就是带边界整值。
   断链只能靠补录（或放宽断链门槛），校准只能靠续校（或给宽限）。 */

function evaluateWithPatches(data, batch, patches, settingsOverride) {
  // patches: { temps: {recordId: valueC} }
  const fake = {
    settings: Object.assign({}, data.settings, settingsOverride || {}),
    probes: data.probes,
    records: data.records.map((r) => {
      const t = patches && patches.temps && patches.temps[r.id];
      return t === undefined ? r : Object.assign({}, r, { temperatureC: t });
    }),
  };
  return evaluateBatch(fake, batch, {});
}

function outOfRangePoints(base) {
  const points = [];
  for (const seg of base.segments) {
    for (const p of seg.records) {
      points.push({ id: p.id, at: p.at, temperatureC: p.temperatureC, source: p.source, segmentIndex: seg.index });
    }
  }
  return points;
}

function recordById(data, id) {
  return data.records.find((r) => r.id === id) || null;
}

// 单条记录改到带内（高温降到 ≤ 上限，低温升到 ≥ 下限）后，它所属的超限段会在该点断开消失；
// 继续往带内改不再影响判定。所以临界值就是带边界整值：要么“改到边界即够”，要么“只改这一条不够”。
function singleCritical(data, batch, point, settings) {
  const goingDown = point.temperatureC > Number(settings.upperLimitC);
  const boundary = goingDown ? Number(settings.upperLimitC) : Number(settings.lowerLimitC);
  const trial = evaluateWithPatches(data, batch, { temps: { [point.id]: boundary } });
  const ok = trial.conditions.find((c) => c.key === 'longest').ok && trial.conditions.find((c) => c.key === 'total').ok;
  if (!ok) return null;
  return {
    recordId: point.id,
    at: point.at,
    currentC: point.temperatureC,
    direction: goingDown ? 'down' : 'up',
    criticalC: boundary,
    boundaryC: boundary,
    changeC: store.round(Math.abs(point.temperatureC - boundary), 2),
    resultingLongest: trial.longestMinutes,
    resultingTotal: trial.totalMinutes,
    otherFailed: trial.failed.filter((k) => k !== 'longest' && k !== 'total'),
  };
}

// 单段断点 DP：选最少的点挪进带内，使每个残余连续小段的边权和（时长）都 ≤ longestLimit；
// 同样的断点数下保留的时长越少越好（利于跨段压累计）。
// 点 v0..v{n-1}，边 e[k] 连 v{k-1}-v{k}（k=1..n-1）。加两个虚断点 -1（段首）与 n（段尾）。
function segmentBreakOptions(seg, longestLimit) {
  const recs = seg.records;
  const n = recs.length;
  const pref = [0];
  for (let k = 1; k < n; k += 1) pref[k] = pref[k - 1] + (recs[k].gapMinutes || 0);
  const runSum = (i, j) => {
    // 断点 i、j 之间活点 i+1..j-1 的内部边 e[i+2..j-1] 之和
    const hi = j - 1;
    const lo = i + 1;
    return hi > lo ? pref[hi] - pref[lo] : 0;
  };
  // best[j]: Map(断点数 -> {kept 保留时长, path 实断点下标})，处理到虚/实断点 j
  const best = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) best[j] = new Map();
  const seed = new Map();
  seed.set(0, { kept: 0, path: [] });
  best[-1] = seed;
  for (let j = 0; j <= n; j += 1) {
    for (let i = -1; i < j; i += 1) {
      const prev = best[i];
      if (!prev) continue;
      const keptRun = runSum(i, j);
      if (keptRun > longestLimit) continue;
      const isReal = j < n;
      prev.forEach((st, cnt) => {
        const nc = cnt + (isReal ? 1 : 0);
        const cand = { kept: st.kept + keptRun, path: isReal ? st.path.concat(j) : st.path };
        const cur = best[j].get(nc);
        if (!cur || cand.kept < cur.kept) best[j].set(nc, cand);
      });
    }
  }
  // 终点虚断点 n 上收集：断点数 → 残余时长（保留边权之和，越短越好）与断点位置
  const options = [];
  best[n].forEach((st, cnt) => {
    options.push({ count: cnt, residual: st.kept, path: st.path.map((idx) => recs[idx]) });
  });
  options.sort((a, b) => (a.count - b.count || a.residual - b.residual));
  return options;
}

// 求“把最长+累计两项翻过来”的最少改记录方案：各段断点 DP 后做跨段背包。
// 带外点过多时退回逐点贪心，并把 approximate 标出来。
function recordFixPlan(data, batch, base, settings) {
  const longestLimit = Number(settings.allowExcursionMinutes);
  const totalLimit = Number(settings.allowTotalExcursionMinutes);
  const allPoints = outOfRangePoints(base);
  let chosenPoints = [];
  let approximate = false;

  if (allPoints.length <= 300) {
    // perSeg: [{options, segIndex}]；global: Map(总断点数 → {residual, picks 每段断点数, paths})
    let global = new Map();
    global.set(0, { residual: 0, picks: [], paths: [] });
    for (const seg of base.segments) {
      const options = segmentBreakOptions(seg, longestLimit);
      const next = new Map();
      global.forEach((g, gc) => {
        for (const op of options) {
          const nc = gc + op.count;
          const cand = { residual: g.residual + op.residual, picks: g.picks.concat(op.count), paths: g.paths.concat([op.path]) };
          const cur = next.get(nc);
          if (!cur || cand.residual < cur.residual) next.set(nc, cand);
        }
      });
      global = next;
    }
    const feasible = [...global.entries()]
      .filter(([, v]) => v.residual <= totalLimit)
      .sort((a, b) => a[0] - b[0]);
    if (feasible.length) {
      chosenPoints = feasible[0][1].paths.reduce((acc, path) => acc.concat(path), []);
    }
  } else {
    approximate = true;
    chosenPoints = greedyFix(base, longestLimit, totalLimit);
  }
  if (!chosenPoints.length) return null;

  const temps = {};
  const changes = [];
  for (const p of chosenPoints) {
    const critical = p.temperatureC > Number(settings.upperLimitC) ? Number(settings.upperLimitC) : Number(settings.lowerLimitC);
    temps[p.id] = critical;
    changes.push({ recordId: p.id, at: p.at, currentC: p.temperatureC, criticalC: critical, direction: p.temperatureC > critical ? 'down' : 'up', changeC: store.round(Math.abs(p.temperatureC - critical), 2) });
  }
  const trial = evaluateWithPatches(data, batch, { temps });
  const excursionOk = trial.conditions.find((c) => c.key === 'longest').ok && trial.conditions.find((c) => c.key === 'total').ok;
  if (!excursionOk) return null;
  return {
    size: changes.length,
    approximate,
    changes: changes.sort((a, b) => (a.at < b.at ? -1 : 1)),
    resultingLongest: trial.longestMinutes,
    resultingTotal: trial.totalMinutes,
    otherFailed: trial.failed.filter((k) => k !== 'longest' && k !== 'total'),
  };
}

// 大规模数据的兜底贪心：每轮挪走消掉原始邻接边时长最多的点，直到两项都过
function greedyFix(base, longestLimit, totalLimit) {
  const fixed = {};
  const residualOf = () => {
    let total = 0;
    for (const seg of base.segments) {
      let run = 0;
      const recs = seg.records;
      for (let i = 1; i < recs.length; i += 1) {
        if (fixed[recs[i - 1].id] || fixed[recs[i].id]) { run = 0; continue; }
        run += recs[i].gapMinutes || 0;
        if (run > longestLimit) run = Infinity; // 单次仍超
        total += recs[i].gapMinutes || 0;
      }
    }
    return total;
  };
  const passes = () => {
    for (const seg of base.segments) {
      let run = 0;
      const recs = seg.records;
      for (let i = 1; i < recs.length; i += 1) {
        if (fixed[recs[i - 1].id] || fixed[recs[i].id]) { run = 0; continue; }
        run += recs[i].gapMinutes || 0;
        if (run > longestLimit) return false;
      }
    }
    return residualOf() <= totalLimit;
  };
  let guard = 0;
  while (!passes() && guard < 100000) {
    guard += 1;
    let best = null;
    for (const seg of base.segments) {
      const recs = seg.records;
      for (let i = 0; i < recs.length; i += 1) {
        if (fixed[recs[i].id]) continue;
        let removed = 0;
        if (i > 0 && !fixed[recs[i - 1].id]) removed += recs[i].gapMinutes || 0;
        if (i + 1 < recs.length && !fixed[recs[i + 1].id]) removed += recs[i + 1].gapMinutes || 0;
        if (!best || removed > best.removed) best = recs[i];
      }
    }
    if (!best) break;
    fixed[best.id] = true;
  }
  return outOfRangePoints(base).filter((p) => fixed[p.id]);
}

function counterfactuals(data, batch, opt) {
  const base = evaluateBatch(data, batch, opt || {});
  const settings = base.settings;
  const result = {
    currentPass: base.pass,
    currentFailed: base.failed.slice(),
    recordChanges: null,
    paramChanges: null,
    calibrationChanges: null,
    note: '',
  };

  if (!base.recordCount) {
    result.note = '这个批次还没有任何温度记录，改参数或改单条读数都没有意义；先补录温度记录后才能判定，且全程不能有断链。';
    result.recordChanges = { excursionFails: false, candidateCount: 0, minimalSize: null, flippable: false, approximate: false, items: [], requiresOther: ['records'], note: result.note };
    result.paramChanges = { items: [], packageItems: [], packageFlips: false, blockedBy: ['records'] };
    result.calibrationChanges = { probes: [], renewFlips: false, graceCriticalDays: 0, graceFlips: false, direction: '没有记录，暂不涉及探头校准' };
    return result;
  }

  const chain = base.chain;
  const points = outOfRangePoints(base);
  const excursionFails = base.failed.some((k) => k === 'longest' || k === 'total');

  if (!excursionFails) {
    // 最长与累计两项本就合格：改读数没有必要，不给改记录方案
    result.recordChanges = {
      excursionFails: false,
      candidateCount: points.length,
      minimalSize: null,
      flippable: false,
      approximate: false,
      items: [],
      requiresOther: base.failed.slice(),
      note: points.length
        ? '最长与累计超限两项本就合格：' + points.length + ' 个带外读数都没撑出超过允许时长的超限段，不需要改任何读数。'
        : '没有带外读数，最长与累计超限两项本就合格。',
    };
  } else {
    // ---- A. 改记录（只在最长/累计不合格时给方案）----
    // A1. 单条：逐个超限点试“改到带边界”，能让最长+累计两项都过的，就是“改这一条即解决超限”
    const singleItems = [];
    for (const p of points.slice(0, 60)) {
      const one = singleCritical(data, batch, p, settings);
      if (one) singleItems.push({
        size: 1,
        changes: [{ recordId: one.recordId, at: one.at, currentC: one.currentC, criticalC: one.criticalC, direction: one.direction, changeC: one.changeC }],
        resultingLongest: one.resultingLongest,
        resultingTotal: one.resultingTotal,
        otherFailed: one.otherFailed,
      });
    }
    // A2. 精确最小改记录方案（段内断点 DP + 段间合并；规模过大时退回贪心并标注近似）
    const plan = recordFixPlan(data, batch, base, settings);
    const fullSingles = singleItems.filter((it) => !it.otherFailed.length);
    const items = singleItems.slice();
    if (plan && !fullSingles.length) items.push(plan);
    const minimalSize = fullSingles.length ? 1 : (plan && !plan.otherFailed.length ? plan.size : null);

    result.recordChanges = {
      excursionFails: true,
      candidateCount: points.length,
      minimalSize,
      flippable: minimalSize !== null,
      approximate: !!(plan && plan.approximate),
      items: items.slice(0, 8),
      requiresOther: chain.gapCount ? ['chain'] : base.failed.includes('calibration') ? ['calibration'] : [],
    };
    if (!points.length) {
      result.recordChanges.note = '最长或累计超限判为不合格，但找不到带外记录（口径异常），请检查数据。';
    } else if (!fullSingles.length && plan && plan.otherFailed.length) {
      const left = plan.otherFailed.map((k) => (k === 'chain' ? chain.gapCount + ' 处断链' : k === 'calibration' ? '过期探头' : k)).join('、');
      result.recordChanges.note = '改温度只能消掉超限段；即使把方案里的 ' + plan.size + ' 条读数改到带内，还剩「' + left + '」挡着，结论仍不能翻转。断链要补录缺口记录，过期探头要续校。';
    } else if (fullSingles.length) {
      result.recordChanges.note = '只改 1 条读数即可让最长与累计超限都合格：';
    } else if (minimalSize) {
      result.recordChanges.note = '改 1 条不够；' + (plan.approximate ? '一个可行方案是改 ' : '最少要改 ') + minimalSize + ' 条读数到带内，即可让最长与累计超限都合格（每条的临界值见下）。';
    }
  }

  // ---- B. 放宽参数：单项临界值 + 最小组合包 ----
  const paramItems = [];
  const condLong = base.conditions.find((c) => c.key === 'longest');
  const condTotal = base.conditions.find((c) => c.key === 'total');
  const condCal = base.conditions.find((c) => c.key === 'calibration');

  paramItems.push({
    key: 'allowExcursionMinutes',
    label: '单次允许超限（分钟）',
    currentValue: Number(settings.allowExcursionMinutes),
    criticalValue: base.longestMinutes,
    mustRelax: !condLong.ok,
    flippableAlone: false,
    direction: !condLong.ok
      ? '放宽到 ≥ ' + base.longestMinutes + ' 分钟，这一项才过（现在 ' + settings.allowExcursionMinutes + ' 分钟，差 ' + (base.longestMinutes - Number(settings.allowExcursionMinutes)) + ' 分钟）'
      : '已满足；门槛最低可收紧到 ' + base.longestMinutes + ' 分钟（当前余量 ' + (Number(settings.allowExcursionMinutes) - base.longestMinutes) + ' 分钟）',
  });
  paramItems.push({
    key: 'allowTotalExcursionMinutes',
    label: '累计允许超限（分钟）',
    currentValue: Number(settings.allowTotalExcursionMinutes),
    criticalValue: base.totalMinutes,
    mustRelax: !condTotal.ok,
    flippableAlone: false,
    direction: !condTotal.ok
      ? '放宽到 ≥ ' + base.totalMinutes + ' 分钟，这一项才过（现在 ' + settings.allowTotalExcursionMinutes + ' 分钟，差 ' + (base.totalMinutes - Number(settings.allowTotalExcursionMinutes)) + ' 分钟）'
      : '已满足；门槛最低可收紧到 ' + base.totalMinutes + ' 分钟（当前余量 ' + (Number(settings.allowTotalExcursionMinutes) - base.totalMinutes) + ' 分钟）',
  });
  paramItems.push({
    key: 'chainGapMinutes',
    label: '断链门槛（分钟）',
    currentValue: Number(settings.chainGapMinutes),
    criticalValue: chain.maxGapMinutes,
    mustRelax: chain.gapCount > 0,
    flippableAlone: false,
    direction: chain.gapCount
      ? '放宽到 ≥ ' + chain.maxGapMinutes + ' 分钟，' + chain.gapCount + ' 处断链才全部消失（最长一处是 ' +
        chain.gaps.reduce((a, g) => (g.minutes > a.minutes ? g : a), chain.gaps[0]).from + ' 至 ' +
        chain.gaps.reduce((a, g) => (g.minutes > a.minutes ? g : a), chain.gaps[0]).to + '，缺 ' + chain.maxGapMinutes + ' 分钟）'
      : '没有断链；门槛当前 ' + settings.chainGapMinutes + ' 分钟，维持即可',
  });

  // 最小放宽组合包：只含当前不过的项，各取临界值，试算整体是否翻转
  const packageSettings = {};
  const packageItems = [];
  if (!condLong.ok) { packageSettings.allowExcursionMinutes = base.longestMinutes; packageItems.push(paramItems[0]); }
  if (!condTotal.ok) { packageSettings.allowTotalExcursionMinutes = base.totalMinutes; packageItems.push(paramItems[1]); }
  if (chain.gapCount > 0) { packageSettings.chainGapMinutes = chain.maxGapMinutes; packageItems.push(paramItems[2]); }
  const trialRelax = evaluateWithPatches(data, batch, {}, packageSettings);
  // 校准不通过时，放宽分钟参数也翻不过来
  const relaxBlockedByCal = !condCal.ok;
  const relaxBlockedByRecords = !base.recordCount;
  result.paramChanges = {
    items: paramItems,
    packageItems: packageItems.map((p) => ({ key: p.key, label: p.label, criticalValue: p.criticalValue, currentValue: p.currentValue })),
    packageFlips: trialRelax.pass,
    blockedBy: relaxBlockedByCal ? ['calibration'] : relaxBlockedByRecords ? ['records'] : [],
  };

  // ---- C. 校准：续校 / 宽限天数临界值 ----
  const calProbes = base.expiredProbes.map((p) => ({
    probeId: p.probeId,
    probeCode: p.probeCode,
    calibratedUntil: p.calibratedUntil,
    daysOver: p.daysOver,
    graceCriticalDays: p.daysOver,
    firstAt: p.firstAt,
    lastAt: p.lastAt,
    recordCount: p.recordCount,
  }));
  const maxDaysOver = calProbes.reduce((acc, p) => Math.max(acc, p.daysOver), 0);
  let graceTrialPass = false;
  if (calProbes.length) {
    const trial = evaluateBatch(data, batch, { settings: { probeCalibrationGraceDays: maxDaysOver } });
    graceTrialPass = trial.pass;
  }
  result.calibrationChanges = {
    probes: calProbes,
    renewFlips: calProbes.length ? evaluateWithPatches(data, batch, {}, {}).failed.filter((k) => k !== 'calibration').length === 0 : false,
    graceCriticalDays: maxDaysOver,
    graceFlips: graceTrialPass,
    direction: calProbes.length
      ? '把 ' + calProbes.map((p) => p.probeCode).join('、') + ' 重新校准（校准有效期改到 ' + base.firstAt.slice(0, 10) + ' 或之后），或把校准宽限天数放宽到 ≥ ' + maxDaysOver + ' 天，校准这一项才过'
      : '没有过期探头，不需要续校或宽限',
  };

  // ---- 结论文案 ----
  const notes = [];
  if (base.pass) {
    notes.push('当前已满足全部放行条件。');
    const margins = [];
    if (condLong.ok && base.recordCount) margins.push('单次超限余量 ' + (Number(settings.allowExcursionMinutes) - base.longestMinutes) + ' 分钟');
    if (condTotal.ok && base.recordCount) margins.push('累计超限余量 ' + (Number(settings.allowTotalExcursionMinutes) - base.totalMinutes) + ' 分钟');
    if (margins.length) notes.push(margins.join('，') + '。');
  } else if (result.recordChanges.flippable) {
    notes.push('只改温度记录即可翻为合格，最少改 ' + result.recordChanges.minimalSize + ' 条，每条改到的临界温度见上。');
  } else {
    const blockers = [];
    if (base.failed.includes('longest') || base.failed.includes('total')) blockers.push('超限（改记录或放宽分钟参数）');
    if (base.failed.includes('chain')) blockers.push('断链（补录缺口记录，或把断链门槛放宽到 ≥ ' + chain.maxGapMinutes + ' 分钟）');
    if (base.failed.includes('calibration')) blockers.push('探头校准（续校，或把宽限天数放宽到 ≥ ' + maxDaysOver + ' 天）');
    notes.push('要翻转为合格，必须同时处理：' + blockers.join('；') + '。');
  }
  result.note = notes.join('');
  return result;
}

module.exports = {
  toDate,
  probeOf,
  recordsOfBatch,
  effectiveRecords,
  effectiveRecordsDetailed,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  releaseCheck,
  evaluateBatch,
  evaluateScenario: evaluateWithPatches,
  counterfactuals,
};
