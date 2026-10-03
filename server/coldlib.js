// 温控口径都集中在这里：超限段、断链、MKT、放行判定
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

// 参与判定的记录：停用探头名下的记录剔除；同一探头同一时刻自动与手工并存时以手工为准
function effectiveRecords(data, batchId) {
  const rows = recordsOfBatch(data, batchId).filter((r) => {
    const probe = probeOf(data, r.probeId);
    return !probe || probe.status !== '停用';
  });
  const picked = {};
  const order = [];
  for (const row of rows) {
    const key = row.probeId + '|' + row.at;
    if (picked[key] === undefined) {
      picked[key] = row;
      order.push(key);
      continue;
    }
    if (row.source === '人工') picked[key] = row;
  }
  return order.map((key) => picked[key]);
}

// 超限：连续超出上下限的时段，回到范围内即断开。
// 段时长按段内相邻记录的实际时刻差累加；单点成段时时长为 0（只是一次读数，不占时长）。
function segmentStats(rows, settings) {
  const segments = [];
  let current = null;
  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
    if (out) {
      const point = { id: row.id, probeId: row.probeId, at: row.at, temperatureC: value };
      if (current) {
        const gap = store.minutesBetween(current.endAt, row.at);
        current.minutes += gap;
        current.endAt = row.at;
        current.peakC = value > current.peakC ? value : current.peakC;
        current.lowC = value < current.lowC ? value : current.lowC;
        current.points.push(point);
      } else {
        current = {
          startAt: row.at, endAt: row.at, minutes: 0,
          peakC: value, lowC: value, points: [point],
        };
        segments.push(current);
      }
    } else {
      current = null;
    }
  }
  const longest = segments.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, lowC: 0, points: [] });
  const total = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longestMinutes: longest.minutes, longest, totalMinutes: total, segmentCount: segments.length };
}

function excursionStats(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const stats = segmentStats(rows, data.settings);
  return Object.assign({}, stats, {
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  });
}

// 断链：相邻记录的时刻差超过门槛（严格大于），缺口时长按实际时刻差算
function chainGaps(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      gaps.push({
        index: gaps.length,
        from: { id: rows[i - 1].id, probeId: rows[i - 1].probeId, at: rows[i - 1].at, temperatureC: Number(rows[i - 1].temperatureC) },
        to: { id: rows[i].probeId, probeId: rows[i].probeId, at: rows[i].at, temperatureC: Number(rows[i].temperatureC) },
        minutes,
        countedMinutes: minutes,
      });
    }
  }
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.minutes, 0), longestGapMinutes: gaps.reduce((m, g) => (g.minutes > m ? g.minutes : m), 0) };
}

// MKT：平均动力学温度（不是算术平均）
// MKT = −Ea / (R × ln((Σ e^(−Ea/(R·T)))/n)) − 273.15
function mktCelsius(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return 0;
  const ea = Number(settings.mktActivationEnergy) || 83144;
  const r = Number(settings.gasConstant) || 8.314;
  const sum = rows.reduce((acc, row) => acc + Math.exp(-ea / (r * (Number(row.temperatureC) + 273.15))), 0);
  const mkt = -ea / (r * Math.log(sum / rows.length)) - 273.15;
  return store.round(mkt, 2);
}

function addDaysText(day, days) {
  const d = new Date(String(day).slice(0, 10) + 'T00:00:00+08:00');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return bj.getUTCFullYear() + '-' + p(bj.getUTCMonth() + 1) + '-' + p(bj.getUTCDate());
}

function daysBetweenText(a, b) {
  return Math.round((new Date(String(b) + 'T00:00:00+08:00') - new Date(String(a) + 'T00:00:00+08:00')) / 86400000);
}

// 探头校准有效期（可带宽限天数）
function probeValidOn(probe, day, graceDays) {
  if (!probe || !probe.calibratedUntil) return true;
  const grace = graceDays == null ? 0 : Number(graceDays);
  return String(day).slice(0, 10) <= addDaysText(probe.calibratedUntil, grace);
}

// 本批次参与判定记录里，已过校准期的探头（含第一笔超限记录时刻与笔数）
function expiredProbes(data, batchId, graceDays) {
  const grace = graceDays == null ? Number(data.settings.probeCalibrationGraceDays || 0) : Number(graceDays);
  const rows = effectiveRecords(data, batchId);
  const map = new Map();
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe || probeValidOn(probe, String(row.at).slice(0, 10), grace)) continue;
    let item = map.get(probe.id);
    if (!item) {
      item = {
        probeId: probe.id, probeCode: probe.code, calibratedUntil: probe.calibratedUntil,
        graceDays: grace, firstAt: row.at, lastAt: row.at, recordIds: [], overdueDays: 0,
      };
      map.set(probe.id, item);
    }
    item.recordIds.push(row.id);
    if (row.at > item.lastAt) item.lastAt = row.at;
    item.overdueDays = Math.max(item.overdueDays, daysBetweenText(probe.calibratedUntil, String(row.at).slice(0, 10)));
  }
  return Array.from(map.values());
}

// 累计超限时长：按批次周期累计，跨月不重置
function accumulatedExcursionMinutes(data, batchId) {
  return excursionStats(data, batchId).totalMinutes;
}

// 放行判定：最长超限、累计超限、断链、探头校准、有记录五条
function releaseCheck(data, batch) {
  const settings = data.settings;
  const stats = excursionStats(data, batch.id);
  const chain = chainGaps(data, batch.id);
  const accumulated = stats.totalMinutes;
  const expired = expiredProbes(data, batch.id);
  const conditions = [
    { key: 'records', ok: stats.recordCount > 0, value: stats.recordCount, limit: 1, text: '至少有一条参与判定的温度记录' },
    { key: 'longest', ok: stats.longestMinutes <= Number(settings.allowExcursionMinutes), value: stats.longestMinutes, limit: Number(settings.allowExcursionMinutes), text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟' },
    { key: 'total', ok: accumulated <= Number(settings.allowTotalExcursionMinutes), value: accumulated, limit: Number(settings.allowTotalExcursionMinutes), text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟' },
    { key: 'chain', ok: chain.gapCount === 0, value: chain.gapCount, limit: 0, text: '全程没有断链' },
    { key: 'calibration', ok: expired.length === 0, value: expired.length, limit: 0, text: '参与判定的探头都在校准有效期内' },
  ];
  return {
    mkt: mktCelsius(data, batch.id),
    longestMinutes: stats.longestMinutes,
    totalMinutes: stats.totalMinutes,
    segmentCount: stats.segmentCount,
    recordCount: stats.recordCount,
    firstAt: stats.firstAt,
    lastAt: stats.lastAt,
    segments: stats.segments,
    chain,
    expiredProbes: expired,
    conditions,
    pass: conditions.every((c) => c.ok),
    failed: conditions.filter((c) => !c.ok).map((c) => c.key),
  };
}

module.exports = {
  toDate,
  addDaysText,
  daysBetweenText,
  probeOf,
  recordsOfBatch,
  effectiveRecords,
  segmentStats,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  releaseCheck,
};
