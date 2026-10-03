// 判定解释与反事实：把每条结论落到具体记录，并算出"怎么改结论会翻转"。
// 所有反事实都用同一套口径重跑 releaseCheck：克隆数据 → 模拟改动 → 比对结论，不另立算法。
const store = require('./store');
const coldlib = require('./coldlib');

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

function probeCodeOf(data, probeId) {
  const p = coldlib.probeOf(data, probeId);
  return p ? p.code : '';
}

function round1(v) {
  return store.round(v, 1);
}

// 在“YYYY-MM-DD HH:mm:ss”（+08:00）上加减分钟，返回同样的 +08:00 本地文本
function shiftMinutesText(at, mins) {
  const d = coldlib.toDate(at);
  d.setUTCMinutes(d.getUTCMinutes() + mins);
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return bj.getUTCFullYear() + '-' + p(bj.getUTCMonth() + 1) + '-' + p(bj.getUTCDate()) +
    ' ' + p(bj.getUTCHours()) + ':' + p(bj.getUTCMinutes()) + ':' + p(bj.getUTCSeconds());
}

function dayOf(at) {
  return String(at).slice(0, 10);
}

/* ---------------- 模拟改动 ---------------- */

function withSettings(data, patch) {
  Object.assign(data.settings, patch);
  return data;
}

function withRecordTemps(data, edits) {
  // edits: [{ id, temperatureC }]
  for (const e of edits) {
    const row = data.records.find((r) => r.id === e.id);
    if (row) row.temperatureC = e.temperatureC;
  }
  return data;
}

function withRecordsRemoved(data, ids) {
  const set = new Set(ids);
  data.records = data.records.filter((r) => !set.has(r.id));
  return data;
}

function withAddedRecords(data, batchId, adds) {
  // adds: [{ probeId, at, temperatureC }]
  let n = 0;
  for (const a of adds) {
    n += 1;
    data.records.push({
      id: 'cf-add-' + n,
      batchId,
      probeId: a.probeId,
      at: a.at,
      temperatureC: a.temperatureC,
      source: '人工',
      operator: '反事实补录',
      remark: '',
    });
  }
  return data;
}

function withProbeCalUntil(data, probeId, date) {
  const p = data.probes.find((x) => x.id === probeId);
  if (p) p.calibratedUntil = date;
  return data;
}

function boundaryTemp(row, settings) {
  return Number(row.temperatureC) > Number(settings.upperLimitC)
    ? Number(settings.upperLimitC)
    : Number(settings.lowerLimitC);
}

function outRecordRows(data, batchId) {
  const stats = coldlib.excursionStats(data, batchId);
  const rows = [];
  for (const seg of stats.segments) {
    for (const pt of seg.points) rows.push(pt);
  }
  return rows;
}

function checkBrief(check) {
  return {
    pass: check.pass,
    failed: check.failed.slice(),
    longestMinutes: check.longestMinutes,
    totalMinutes: check.totalMinutes,
    segmentCount: check.segmentCount,
    gapCount: check.chain.gapCount,
    expiredProbeCount: check.expiredProbes.length,
    recordCount: check.recordCount,
  };
}

/* ---------------- 判定依据 ---------------- */

function buildEvidence(data, batch, check) {
  const settings = data.settings;
  const pointView = (pt) => ({
    id: pt.id, probeCode: probeCodeOf(data, pt.probeId), at: pt.at, temperatureC: pt.temperatureC,
  });

  // 最长超限：点名是哪一段的哪几条
  const longestCond = check.conditions.find((c) => c.key === 'longest');
  const longestSeg = check.segments.reduce(
    (acc, s, idx) => (s.minutes > acc.minutes ? { segment: s, index: idx, minutes: s.minutes } : acc),
    { segment: null, index: -1, minutes: 0 }
  );
  let longest = null;
  if (longestSeg.segment) {
    const s = longestSeg.segment;
    longest = {
      ok: longestCond.ok,
      value: check.longestMinutes,
      limit: longestCond.limit,
      overMinutes: Math.max(0, check.longestMinutes - longestCond.limit),
      segmentIndex: longestSeg.index + 1,
      startAt: s.startAt,
      endAt: s.endAt,
      minutes: s.minutes,
      peakC: s.peakC,
      lowC: s.lowC,
      pointCount: s.points.length,
      points: s.points.map(pointView),
      otherSegments: check.segments
        .map((seg, idx) => ({ segmentIndex: idx + 1, startAt: seg.startAt, endAt: seg.endAt, minutes: seg.minutes, peakC: seg.peakC, pointCount: seg.points.length }))
        .filter((seg) => seg.segmentIndex !== longestSeg.index + 1),
    };
  } else {
    longest = { ok: longestCond.ok, value: 0, limit: longestCond.limit, overMinutes: 0, segmentIndex: 0, points: [], otherSegments: [] };
  }

  // 累计超限：逐段列出构成
  const totalCond = check.conditions.find((c) => c.key === 'total');
  const total = {
    ok: totalCond.ok,
    value: check.totalMinutes,
    limit: totalCond.limit,
    overMinutes: Math.max(0, check.totalMinutes - totalCond.limit),
    segmentCount: check.segments.length,
    segments: check.segments.map((s, idx) => ({
      segmentIndex: idx + 1,
      startAt: s.startAt,
      endAt: s.endAt,
      minutes: s.minutes,
      peakC: s.peakC,
      pointCount: s.points.length,
      pointIds: s.points.map((p) => p.id),
    })),
  };

  // 断链：逐处列出两端记录
  const chainCond = check.conditions.find((c) => c.key === 'chain');
  const chain = {
    ok: chainCond.ok,
    value: check.chain.gapCount,
    thresholdMinutes: Number(settings.chainGapMinutes),
    gaps: check.chain.gaps.map((g) => ({
      index: g.index + 1,
      minutes: g.minutes,
      overMinutes: g.minutes - Number(settings.chainGapMinutes),
      from: { id: g.from.id, probeCode: probeCodeOf(data, g.from.probeId), at: g.from.at, temperatureC: g.from.temperatureC },
      to: { id: g.to.id, probeCode: probeCodeOf(data, g.to.probeId), at: g.to.at, temperatureC: g.to.temperatureC },
    })),
  };

  // 校准：逐台探头列出依据
  const calCond = check.conditions.find((c) => c.key === 'calibration');
  const calibration = {
    ok: calCond.ok,
    value: calCond.value,
    graceDays: Number(settings.probeCalibrationGraceDays || 0),
    expired: check.expiredProbes.map((p) => ({
      probeId: p.probeId,
      probeCode: p.probeCode,
      calibratedUntil: p.calibratedUntil,
      firstAt: p.firstAt,
      lastAt: p.lastAt,
      overdueDays: p.overdueDays,
      recordCount: p.recordIds.length,
      recordIds: p.recordIds.slice(),
    })),
  };

  const recCond = check.conditions.find((c) => c.key === 'records');
  const records = { ok: recCond.ok, value: recCond.value };

  return { records, longest, total, chain, calibration };
}

// 没参与判定的记录：停用探头名下、被同时刻手工记录覆盖的自动记录
function excludedRecords(data, batchId) {
  const raw = coldlib.recordsOfBatch(data, batchId);
  const out = [];
  for (const r of raw) {
    const probe = coldlib.probeOf(data, r.probeId);
    if (probe && probe.status === '停用') {
      out.push({ id: r.id, probeCode: probe.code, at: r.at, temperatureC: Number(r.temperatureC), reason: '探头已停用，名下记录不参与判定' });
      continue;
    }
    if (r.source === '自动') {
      const manual = raw.some((o) => o.probeId === r.probeId && o.at === r.at && o.source === '人工');
      if (manual) out.push({ id: r.id, probeCode: probe ? probe.code : '', at: r.at, temperatureC: Number(r.temperatureC), reason: '同一探头同一时刻有手工更正，以手工为准' });
    }
  }
  return out;
}

/* ---------------- 反事实：改记录温度 ---------------- */

function editPlan(data, batchId, ids) {
  const settings = data.settings;
  const edits = ids.map((id) => {
    const row = data.records.find((r) => r.id === id);
    return { id, temperatureC: boundaryTemp(row, settings) };
  });
  const sim = withRecordTemps(clone(data), edits);
  return { edits, check: coldlib.releaseCheck(sim, sim.batches.find((b) => b.id === batchId)) };
}

// 在超限点里找满足 predicate 的最小 id 集合；单点、再两点
function smallestIdSet(data, batchId, outIds, predicate) {
  // 单点
  for (const id of outIds) {
    const { check } = editPlan(data, batchId, [id]);
    if (predicate(check)) return { size: 1, sets: [[id]] };
  }
  if (outIds.length > 20) return { size: null, sets: [], limited: true };
  // 两点
  for (let i = 0; i < outIds.length; i += 1) {
    for (let j = i + 1; j < outIds.length; j += 1) {
      const pair = [outIds[i], outIds[j]];
      const { check } = editPlan(data, batchId, pair);
      if (predicate(check)) return { size: 2, sets: [pair] };
    }
  }
  return { size: null, sets: [] };
}

function buildRecordEdits(data, batch, check) {
  const settings = data.settings;
  const outRows = outRecordRows(data, batch.id);
  const recordEdits = outRows.map((row) => {
    const high = Number(row.temperatureC) > Number(settings.upperLimitC);
    const critical = high ? Number(settings.upperLimitC) : Number(settings.lowerLimitC);
    const { edits, check: after } = editPlan(data, batch.id, [row.id]);
    return {
      recordId: row.id,
      probeCode: probeCodeOf(data, row.probeId),
      at: row.at,
      temperatureC: row.temperatureC,
      direction: high ? '高于上限' : '低于下限',
      criticalC: round1(critical),
      criticalText: high ? '降到 ' + round1(critical) + '℃ 及以下' : '升到 ' + round1(critical) + '℃ 及以上',
      editedToC: round1(edits[0].temperatureC),
      flipsOverall: after.pass,
      after: checkBrief(after),
    };
  });

  // 整体翻转的最小改记录集合
  let minimal = { size: null, sets: [], flipsOverall: false };
  if (outRows.length) {
    const found = smallestIdSet(data, batch.id, outRows.map((r) => r.id), (c) => c.pass);
    minimal = {
      size: found.size,
      sets: found.sets,
      limited: !!found.limited,
      flipsOverall: found.size !== null,
    };
  }

  // 整体翻不了时，分别看最长、累计两条各自的最小改法
  const perCondition = [];
  if (!check.pass) {
    const need = [];
    if (check.failed.indexOf('longest') >= 0) need.push('longest');
    if (check.failed.indexOf('total') >= 0) need.push('total');
    for (const key of need) {
      const found = smallestIdSet(
        data, batch.id, outRows.map((r) => r.id),
        (c) => c.conditions.every((cc) => (cc.key === key ? cc.ok : true))
      );
      perCondition.push({
        condition: key,
        size: found.size,
        sets: found.sets,
        limited: !!found.limited,
        stillFailingWhenDone: (function () {
          if (found.size === null) return null;
          const { check: after } = editPlan(data, batch.id, found.sets[0]);
          return after.failed.filter((k) => k !== key);
        })(),
      });
    }
  }

  return { recordEdits, minimalRecordSets: minimal, perConditionRecordSets: perCondition };
}

/* ---------------- 反事实：补录断链 ---------------- */

// 一个缺口需要补几条、补在什么时刻：等分 (t1,t2) 使每段都 ≤ 门槛
function gapFillPlan(data, batchId, gapMinutesObj, settings) {
  const T = Number(settings.chainGapMinutes);
  const t1 = gapMinutesObj.from.at;
  const t2 = gapMinutesObj.to.at;
  const G = gapMinutesObj.minutes;
  let k = Math.max(1, Math.ceil(G / T) - 1);
  const bandMid = store.round((Number(settings.lowerLimitC) + Number(settings.upperLimitC)) / 2, 1);
  const build = (count) => {
    const adds = [];
    for (let i = 1; i <= count; i += 1) {
      const offset = Math.round((G * i) / (count + 1));
      adds.push({ probeId: gapMinutesObj.from.probeId, at: shiftMinutesText(t1, offset), temperatureC: bandMid });
    }
    return adds;
  };
  let adds = build(k);
  // 用判定口径验证；还有断链就继续加点
  let guard = 0;
  while (guard < G) {
    const sim = withAddedRecords(clone(data), batchId, adds);
    const after = coldlib.releaseCheck(sim, sim.batches.find((b) => b.id === batchId));
    const still = after.chain.gaps.find((g) => g.from.at === t1 && g.to.at === t2);
    if (!still) break;
    k += 1;
    adds = build(k);
    guard += 1;
  }
  // 只补一条时的可行窗口：[t2-T, t1+T]
  let onePointWindow = null;
  if (G <= 2 * T) {
    onePointWindow = { earliestAt: shiftMinutesText(t1, G - T), latestAt: shiftMinutesText(t1, T) };
  }
  return {
    gapIndex: gapMinutesObj.index + 1,
    fromAt: t1,
    toAt: t2,
    minutes: G,
    thresholdMinutes: T,
    needCount: k,
    onePointFeasible: G <= 2 * T,
    onePointWindow,
    addedRecords: adds,
    suggestedTemperatureC: bandMid,
  };
}

function buildGapFixes(data, batch, check) {
  if (!check.chain.gaps.length) return { gapFixes: [], combinedFlips: false, combinedAfter: null };
  const plans = check.chain.gaps.map((g) => gapFillPlan(data, batch.id, g, data.settings));
  const adds = plans.reduce((acc, p) => acc.concat(p.addedRecords), []);
  const sim = withAddedRecords(clone(data), batch.id, adds);
  const after = coldlib.releaseCheck(sim, sim.batches.find((b) => b.id === batch.id));
  return { gapFixes: plans, combinedFlips: after.pass, combinedAfter: checkBrief(after) };
}

/* ---------------- 反事实：校准 ---------------- */

function buildCalibrationFixes(data, batch, check) {
  const fixes = check.expiredProbes.map((p) => {
    // 解法一：校准有效期延到本探头最晚一笔参与记录那天（覆盖全部参与记录）
    const extendTo = dayOf(p.lastAt);
    const simExt = withProbeCalUntil(clone(data), p.probeId, extendTo);
    const afterExtend = coldlib.releaseCheck(simExt, simExt.batches.find((b) => b.id === batch.id));

    // 解法二：剔除该探头全部记录（可能变成无记录或制造断链）
    const simRm = withRecordsRemoved(clone(data), p.recordIds);
    const afterRemoval = coldlib.releaseCheck(simRm, simRm.batches.find((b) => b.id === batch.id));

    return {
      probeId: p.probeId,
      probeCode: p.probeCode,
      calibratedUntil: p.calibratedUntil,
      extendCalibratedUntilTo: extendTo,
      graceDaysNeeded: p.overdueDays,
      flipsOverallByExtend: afterExtend.pass,
      afterExtend: checkBrief(afterExtend),
      removalFlipsOverall: afterRemoval.pass,
      afterRemoval: checkBrief(afterRemoval),
    };
  });
  return fixes;
}

/* ---------------- 反事实：参数杠杆 ---------------- */

function buildParameterLevers(data, batch, check) {
  const s = data.settings;
  const levers = [];
  const simCheck = (patch) => {
    const sim = withSettings(clone(data), patch);
    return coldlib.releaseCheck(sim, sim.batches.find((b) => b.id === batch.id));
  };

  // 单次允许超限
  const longestFail = check.failed.indexOf('longest') >= 0;
  const longestLever = {
    key: 'allowExcursionMinutes',
    label: '单次连续超限允许时长',
    unit: '分钟',
    current: Number(s.allowExcursionMinutes),
    actual: check.longestMinutes,
  };
  if (longestFail) {
    const to = check.longestMinutes;
    const after = simCheck({ allowExcursionMinutes: to });
    longestLever.relaxTo = to;
    longestLever.relaxText = '放宽到 ' + to + ' 分钟（实际最长 ' + to + ' 分钟，恰好达标）';
    longestLever.relaxFlipsOverall = after.pass;
    longestLever.relaxStillFailing = after.failed;
  } else if (check.longestMinutes > 0) {
    longestLever.tightenTo = check.longestMinutes;
    longestLever.tightenText = '收紧到 ' + (check.longestMinutes - 1) + ' 分钟就会顶翻（临界 ' + check.longestMinutes + ' 分钟，低于它即不满足）';
  } else {
    longestLever.tightenTo = null;
    longestLever.tightenText = '本批没有计时超限段，收紧这条不会顶翻';
  }
  levers.push(longestLever);

  // 累计允许超限
  const totalFail = check.failed.indexOf('total') >= 0;
  const totalLever = {
    key: 'allowTotalExcursionMinutes',
    label: '累计超限允许时长',
    unit: '分钟',
    current: Number(s.allowTotalExcursionMinutes),
    actual: check.totalMinutes,
  };
  if (totalFail) {
    const to = check.totalMinutes;
    const after = simCheck({ allowTotalExcursionMinutes: to });
    totalLever.relaxTo = to;
    totalLever.relaxText = '放宽到 ' + to + ' 分钟（实际累计 ' + to + ' 分钟，恰好达标）';
    totalLever.relaxFlipsOverall = after.pass;
    totalLever.relaxStillFailing = after.failed;
  } else if (check.totalMinutes > 0) {
    totalLever.tightenTo = check.totalMinutes;
    totalLever.tightenText = '收紧到 ' + (check.totalMinutes - 1) + ' 分钟就会顶翻（临界 ' + check.totalMinutes + ' 分钟）';
  } else {
    totalLever.tightenTo = null;
    totalLever.tightenText = '本批累计超限为 0，收紧这条不会顶翻';
  }
  levers.push(totalLever);

  // 断链门槛
  const chainFail = check.failed.indexOf('chain') >= 0;
  const chainLever = {
    key: 'chainGapMinutes',
    label: '断链门槛',
    unit: '分钟',
    current: Number(s.chainGapMinutes),
    actual: chainFail ? check.chain.longestGapMinutes : minimumAdjacentGap(data, batch.id),
  };
  if (chainFail) {
    const to = check.chain.longestGapMinutes;
    const after = simCheck({ chainGapMinutes: to });
    chainLever.relaxTo = to;
    chainLever.relaxText = '放宽到 ' + to + ' 分钟（最大缺口 ' + to + ' 分钟，放宽后没有断链）';
    chainLever.relaxFlipsOverall = after.pass;
    chainLever.relaxStillFailing = after.failed;
  } else {
    const minGap = chainLever.actual;
    if (minGap > 0) {
      chainLever.tightenTo = minGap;
      chainLever.tightenText = '收紧到 ' + (minGap - 1) + ' 分钟就会出现断链（最小相邻间隔 ' + minGap + ' 分钟）';
    } else {
      chainLever.tightenTo = null;
      chainLever.tightenText = '记录不足两条，无断链可言';
    }
  }
  levers.push(chainLever);

  // 温度带上限
  const upperLever = buildLimitLever(data, batch, check, simCheck, 'upperLimitC', '温度带上限', true);
  levers.push(upperLever);
  // 温度带下限
  const lowerLever = buildLimitLever(data, batch, check, simCheck, 'lowerLimitC', '温度带下限', false);
  levers.push(lowerLever);

  // 校准宽限期
  const calFail = check.failed.indexOf('calibration') >= 0;
  if (calFail) {
    const maxOverdue = check.expiredProbes.reduce((m, p) => Math.max(m, p.overdueDays), 0);
    const after = simCheck({ probeCalibrationGraceDays: maxOverdue });
    levers.push({
      key: 'probeCalibrationGraceDays',
      label: '探头校准宽限期',
      unit: '天',
      current: Number(s.probeCalibrationGraceDays || 0),
      actual: maxOverdue,
      relaxTo: maxOverdue,
      relaxText: '宽限放到 ' + maxOverdue + ' 天（最晚记录距校准有效期 ' + maxOverdue + ' 天）',
      relaxFlipsOverall: after.pass,
      relaxStillFailing: after.failed,
    });
  }

  return levers;
}

function minimumAdjacentGap(data, batchId) {
  const rows = coldlib.effectiveRecords(data, batchId);
  let min = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const g = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (min === 0 || g < min) min = g;
  }
  return min;
}

function buildLimitLever(data, batch, check, simCheck, key, label, isUpper) {
  const s = data.settings;
  const rows = coldlib.effectiveRecords(data, batch.id);
  const limit = Number(isUpper ? s.upperLimitC : s.lowerLimitC);
  const lever = { key, label, unit: '℃', current: limit };
  const outside = rows.filter((r) => isUpper
    ? Number(r.temperatureC) > limit
    : Number(r.temperatureC) < limit);
  if (outside.length) {
    const target = isUpper
      ? Math.max.apply(null, outside.map((r) => Number(r.temperatureC)))
      : Math.min.apply(null, outside.map((r) => Number(r.temperatureC)));
    const after = simCheck(key === 'upperLimitC' ? { upperLimitC: target } : { lowerLimitC: target });
    lever.relaxTo = round1(target);
    lever.actual = round1(target);
    lever.relaxText = isUpper
      ? '上限放宽到 ' + round1(target) + '℃，现有的 ' + outside.length + ' 条偏高记录全部回到带内'
      : '下限放宽到 ' + round1(target) + '℃，现有的 ' + outside.length + ' 条偏低记录全部回到带内';
    lever.relaxFlipsOverall = after.pass;
    lever.relaxStillFailing = after.failed;
  } else if (rows.length) {
    const nearest = isUpper
      ? Math.max.apply(null, rows.map((r) => Number(r.temperatureC)))
      : Math.min.apply(null, rows.map((r) => Number(r.temperatureC)));
    const probe = round1(isUpper ? nearest - 0.1 : nearest + 0.1);
    const after = simCheck(key === 'upperLimitC' ? { upperLimitC: probe } : { lowerLimitC: probe });
    lever.tightenTo = round1(nearest);
    lever.actual = round1(nearest);
    lever.tightenText = isUpper
      ? '上限压到 ' + probe + '℃，最贴近上限的 ' + round1(nearest) + '℃ 读数就超限'
      : '下限抬到 ' + probe + '℃，最贴近下限的 ' + round1(nearest) + '℃ 读数就超限';
    lever.tightenFlipsOverall = after.pass === false;
    lever.tightenFailing = after.failed;
  }
  return lever;
}

/* ---------------- 推荐整改（组合修复） ---------------- */

function buildRemedy(data, batch, check, recordPart, gapPart, calFixes) {
  const settings = data.settings;
  const edits = [];
  const adds = [];
  const steps = [];

  // 无记录：先补一条带内读数（取所在冷库任一在用探头，时刻取入库时刻）
  if (check.failed.indexOf('records') >= 0) {
    const probe = data.probes.find((p) => p.roomId === batch.roomId && p.status === '在用') || data.probes.find((p) => p.status === '在用');
    const bandMid = store.round((Number(settings.lowerLimitC) + Number(settings.upperLimitC)) / 2, 1);
    if (probe) {
      adds.push({ probeId: probe.id, at: batch.loadedAt, temperatureC: bandMid });
      steps.push('先用在库探头 ' + probe.code + ' 补录一条 ' + batch.loadedAt + ' 的带内温度记录（' + bandMid + '℃ 左右），再谈其余条件');
    } else {
      steps.push('该批次所在冷库没有在用探头，需先接入探头并补录温度记录');
    }
  }

  // 温度整改：优先用“整体翻转”的最小集合；否则合并 longest/total 各自的最小组合
  if (recordPart.minimalRecordSets.flipsOverall) {
    const ids = recordPart.minimalRecordSets.sets[0];
    for (const id of ids) {
      const row = data.records.find((r) => r.id === id);
      const to = boundaryTemp(row, settings);
      edits.push({ id, toC: round1(to) });
    }
    steps.push('把 ' + ids.map((id) => labelRecord(data, id)).join('、') + ' 改到温度带边界');
  } else {
    const merged = [];
    for (const pc of recordPart.perConditionRecordSets) {
      if (pc.size !== null) for (const id of pc.sets[0]) if (merged.indexOf(id) < 0) merged.push(id);
    }
    for (const id of merged) {
      const row = data.records.find((r) => r.id === id);
      const to = boundaryTemp(row, settings);
      edits.push({ id, toC: round1(to) });
    }
    if (merged.length) steps.push('把 ' + merged.map((id) => labelRecord(data, id)).join('、') + ' 改到温度带边界，可消掉计时超限段');
  }

  // 补录断链
  const gapAdds = gapPart.gapFixes.reduce((acc, p) => acc.concat(p.addedRecords), []);
  if (gapAdds.length) steps.push('在 ' + gapPart.gapFixes.length + ' 处断链缺口补录 ' + gapAdds.length + ' 条带内温度记录（' + gapAdds[0].temperatureC + '℃ 左右）');
  adds.push.apply(adds, gapAdds);

  // 校准延期
  const extends0 = calFixes.map((f) => ({ probeId: f.probeId, probeCode: f.probeCode, calibratedUntil: f.extendCalibratedUntilTo }));
  for (const f of calFixes) steps.push('把探头 ' + f.probeCode + ' 的校准有效期延到 ' + f.extendCalibratedUntilTo + '（或完成送检重新校准）');

  // 整包模拟
  let sim = clone(data);
  if (edits.length) {
    withRecordTemps(sim, edits.map((e) => ({ id: e.id, temperatureC: e.toC })));
  }
  if (adds.length) withAddedRecords(sim, batch.id, adds);
  for (const ex of extends0) withProbeCalUntil(sim, ex.probeId, ex.calibratedUntil);
  const finalCheck = coldlib.releaseCheck(sim, sim.batches.find((b) => b.id === batch.id));

  return {
    steps,
    editedRecords: edits,
    addedRecords: adds,
    extendedProbes: extends0,
    finalPass: finalCheck.pass,
    finalStillFailing: finalCheck.failed,
    after: checkBrief(finalCheck),
  };
}

function labelRecord(data, id) {
  const r = data.records.find((x) => x.id === id);
  if (!r) return id;
  return r.at + ' 的 ' + Number(r.temperatureC) + '℃ 读数（' + id + '）';
}

/* ---------------- 入口 ---------------- */

function explain(data, batch) {
  const check = coldlib.releaseCheck(data, batch);
  const evidence = buildEvidence(data, batch, check);
  const excluded = excludedRecords(data, batch.id);
  const recordPart = buildRecordEdits(data, batch, check);
  const gapPart = buildGapFixes(data, batch, check);
  const calFixes = buildCalibrationFixes(data, batch, check);
  const levers = buildParameterLevers(data, batch, check);
  const remedy = buildRemedy(data, batch, check, recordPart, gapPart, calFixes);

  return {
    batchId: batch.id,
    batchCode: batch.code,
    pass: check.pass,
    failed: check.failed.slice(),
    mkt: check.mkt,
    evaluated: {
      recordCount: check.recordCount,
      firstAt: check.firstAt,
      lastAt: check.lastAt,
      excludedCount: excluded.length,
      excluded,
    },
    evidence,
    counterfactuals: {
      recordEdits: recordPart.recordEdits,
      minimalRecordSets: recordPart.minimalRecordSets,
      perConditionRecordSets: recordPart.perConditionRecordSets,
      gapFixes: gapPart.gapFixes,
      gapFillCombinedFlips: gapPart.combinedFlips,
      gapFillCombinedAfter: gapPart.combinedAfter,
      calibrationFixes: calFixes,
      parameterLevers: levers,
      remedy,
    },
  };
}

module.exports = { explain };
