
/*
 Auction Radar — Phase 1 Persistence Engine
 -------------------------------------------
 Goals:
 1) New auctions are permanently stored in the browser (localStorage).
 2) Every new auction automatically becomes available in "Κατάταξη Απόδοσης".
 3) No duplicates: records are merged by stable key.
 4) First seen / last seen / change history are retained.
 5) Segments: Thessaloniki, Sindos/Industrial, Athens.
 6) Existing fetch logic can integrate with one call:
        window.AuctionRadarPhase1.ingest(records)
*/

(function (global) {
  "use strict";

  const STORAGE_KEY = "auctionRadar.phase1.portfolio.v1";
  const SETTINGS_KEY = "auctionRadar.phase1.settings.v1";

  const SEGMENTS = {
    THESSALONIKI: "thessaloniki",
    SINDOS_INDUSTRIAL: "sindos_industrial",
    ATHENS: "athens"
  };

  function nowISO() {
    return new Date().toISOString();
  }

  function dayKey(value = new Date()) {
    const d = value instanceof Date ? value : new Date(value);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function stripGreekDiacritics(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function textOf(r) {
    return stripGreekDiacritics([
      r.title, r.type, r.address, r.location, r.area, r.region, r.city,
      r.description, r.property_type, r.category
    ].filter(Boolean).join(" "));
  }

  function numberFrom(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value == null) return null;
    const cleaned = String(value)
      .replace(/\s/g, "")
      .replace(/€/g, "")
      .replace(/\.(?=\d{3}(?:\D|$))/g, "")
      .replace(",", ".")
      .replace(/[^\d.-]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeDate(value) {
    if (!value) return null;
    const s = String(value).trim();
    // dd/mm/yyyy [hh:mm]
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (m) {
      const [, dd, mm, yyyy, hh="00", mi="00"] = m;
      return `${yyyy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}T${hh.padStart(2,"0")}:${mi}:00`;
    }
    const d = new Date(s);
    return Number.isNaN(d.valueOf()) ? s : d.toISOString();
  }

  function stableKey(r) {
    const direct = r.id || r.auction_id || r.auctionId || r.code || r.uuid;
    if (direct) return `id:${String(direct).trim()}`;

    const url = r.url || r.link || r.source_url || r.href;
    if (url) {
      try {
        const u = new URL(url, global.location && global.location.href ? global.location.href : "https://example.invalid");
        return `url:${u.origin}${u.pathname}`.toLowerCase();
      } catch (_) {
        return `url:${String(url).trim().toLowerCase().split("?")[0]}`;
      }
    }

    const signature = [
      r.title || r.type || "",
      r.address || r.location || "",
      r.sqm || r.area_sqm || r.square_meters || "",
      r.auction_date || r.date || ""
    ].map(x => stripGreekDiacritics(x).replace(/\s+/g, " ").trim()).join("|");

    // small deterministic hash
    let h = 2166136261;
    for (let i = 0; i < signature.length; i++) {
      h ^= signature.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `sig:${(h >>> 0).toString(16)}`;
  }

  function classifySegment(r) {
    const t = textOf(r);

    const industrialArea = [
      "σινδο", "βιπε", "βιομηχανικη περιοχη θεσσαλονικης",
      "καλοχωρι", "διαβατα", "ιωνια θεσσαλονικης",
      "νεα μαγνησια", "αγχιαλο"
    ].some(k => t.includes(stripGreekDiacritics(k)));

    const industrialType = [
      "βιομηχαν", "βιοτεχν", "εργοστασ", "αποθηκ",
      "logistics", "επαγγελματικο κτιριο", "γηπεδο",
      "οικοπεδο", "αγροτεμαχ"
    ].some(k => t.includes(stripGreekDiacritics(k)));

    if (industrialArea && industrialType) return SEGMENTS.SINDOS_INDUSTRIAL;

    const athens = [
      "αθην", "αττικ", "πειραι", "μαρουσι", "κηφισια", "χαlandri",
      "χαλανδρι", "περιστερι", "αιγαλεω", "γλυφαδα", "καλλιθεα",
      "νεα σμυρνη", "παλαιο φαληρο", "μεταμορφωση", "ασπροπυργ"
    ].some(k => t.includes(stripGreekDiacritics(k)));

    if (athens) return SEGMENTS.ATHENS;

    return SEGMENTS.THESSALONIKI;
  }

  function normalize(r) {
    const price = numberFrom(
      r.first_offer_price ?? r.starting_price ?? r.price ?? r.price_first ?? r.amount
    );
    const sqm = numberFrom(
      r.sqm ?? r.area_sqm ?? r.square_meters ?? r.m2
    );

    const out = {
      key: stableKey(r),
      sourceId: r.id || r.auction_id || r.auctionId || null,
      title: r.title || r.property_type || r.type || "Ακίνητο",
      address: r.address || r.location || "",
      city: r.city || r.region || "",
      sqm,
      startingPrice: price,
      auctionDate: normalizeDate(r.auction_date || r.date || r.auctionDate),
      source: r.source || "eAuction24",
      url: r.url || r.link || r.source_url || r.href || "",
      raw: r
    };
    out.segment = r.segment || classifySegment(out);
    return out;
  }

  function emptyDB() {
    return {
      version: 1,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      records: {},
      snapshots: {}
    };
  }

  function loadDB() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyDB();
      const db = JSON.parse(raw);
      if (!db || typeof db !== "object") return emptyDB();
      db.records ||= {};
      db.snapshots ||= {};
      return db;
    } catch (_) {
      return emptyDB();
    }
  }

  function saveDB(db) {
    db.updatedAt = nowISO();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }

  const trackedFields = [
    "title", "address", "sqm", "startingPrice", "auctionDate", "url", "segment"
  ];

  function diff(oldRec, newRec) {
    const changes = [];
    for (const field of trackedFields) {
      const a = oldRec[field] ?? null;
      const b = newRec[field] ?? null;
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        changes.push({ field, from: a, to: b });
      }
    }
    return changes;
  }

  function ingest(records, options = {}) {
    if (!Array.isArray(records)) {
      throw new Error("AuctionRadarPhase1.ingest(records): records must be an array.");
    }

    const db = loadDB();
    const seenAt = options.seenAt || nowISO();
    const today = dayKey(seenAt);
    const result = { totalInput: records.length, created: 0, updated: 0, unchanged: 0, keys: [] };

    for (const sourceRecord of records) {
      const n = normalize(sourceRecord);
      const existing = db.records[n.key];

      if (!existing) {
        db.records[n.key] = {
          ...n,
          firstSeen: seenAt,
          firstSeenDay: today,
          lastSeen: seenAt,
          lastSeenDay: today,
          active: true,
          history: [{
            at: seenAt,
            kind: "created",
            changes: []
          }],
          // analysis fields can be filled later by user / app
          analysis: {
            estimatedMarketValue: null,
            estimatedMonthlyRent: null,
            renovationCost: null,
            otherPurchaseCosts: null,
            targetBid: null
          }
        };
        result.created++;
      } else {
        const changes = diff(existing, n);
        if (changes.length) {
          db.records[n.key] = {
            ...existing,
            ...n,
            firstSeen: existing.firstSeen,
            firstSeenDay: existing.firstSeenDay,
            lastSeen: seenAt,
            lastSeenDay: today,
            active: true,
            history: [
              ...(existing.history || []),
              { at: seenAt, kind: "changed", changes }
            ],
            analysis: existing.analysis || {}
          };
          result.updated++;
        } else {
          existing.lastSeen = seenAt;
          existing.lastSeenDay = today;
          existing.active = true;
          result.unchanged++;
        }
      }
      result.keys.push(n.key);
    }

    // Daily snapshot of keys observed. We intentionally do not mark older
    // records inactive automatically, because the upstream source may return
    // only a partial page. The existing fetcher can explicitly call markMissingInactive().
    db.snapshots[today] = Array.from(new Set([
      ...(db.snapshots[today] || []),
      ...result.keys
    ]));

    saveDB(db);
    dispatch("auction-radar:ingested", result);
    return result;
  }

  function markMissingInactive(currentKeys, options = {}) {
    const db = loadDB();
    const at = options.at || nowISO();
    const set = new Set(currentKeys || []);
    let changed = 0;

    Object.values(db.records).forEach(rec => {
      if (rec.active && !set.has(rec.key)) {
        rec.active = false;
        rec.history ||= [];
        rec.history.push({ at, kind: "removed_from_source", changes: [] });
        changed++;
      }
    });

    saveDB(db);
    dispatch("auction-radar:status-changed", { changed });
    return changed;
  }

  function computeMetrics(rec) {
    const a = rec.analysis || {};
    const buy = numberFrom(a.targetBid ?? rec.startingPrice);
    const renovation = numberFrom(a.renovationCost) || 0;
    const other = numberFrom(a.otherPurchaseCosts) || 0;
    const totalCost = buy != null ? buy + renovation + other : null;

    const market = numberFrom(a.estimatedMarketValue);
    const rent = numberFrom(a.estimatedMonthlyRent);

    // Scenario A — C&H immediate resale. The 50% level is a target, never a rejection rule.
    const immediateSaleProfit = totalCost != null && market != null ? market - totalCost : null;
    const immediateSaleROI = totalCost > 0 && immediateSaleProfit != null ? immediateSaleProfit / totalCost : null;
    const immediateSaleTarget50 = immediateSaleROI != null ? immediateSaleROI >= 0.50 : null;

    // Scenario B — 36 months of rent, then sale at the entered estimated market value.
    // Rental income is intentionally gross unless C&H includes operating costs in other assumptions.
    const threeYearRentalIncome = rent != null ? rent * 36 : null;
    const threeYearTotalProfit = totalCost != null && market != null && threeYearRentalIncome != null
      ? (market + threeYearRentalIncome) - totalCost
      : null;
    const threeYearROI = totalCost > 0 && threeYearTotalProfit != null ? threeYearTotalProfit / totalCost : null;
    const threeYearAnnualizedROI = threeYearROI != null && (1 + threeYearROI) > 0
      ? Math.pow(1 + threeYearROI, 1 / 3) - 1
      : null;

    const grossRentYield = totalCost > 0 && rent != null ? (rent * 12) / totalCost : null;

    let strategy = "needs_estimate";
    if (immediateSaleROI != null && threeYearAnnualizedROI != null) {
      if (Math.abs(immediateSaleROI - threeYearAnnualizedROI) <= 0.02) strategy = "both";
      else strategy = immediateSaleROI > threeYearAnnualizedROI ? "immediate_sale" : "three_year_hold";
    } else if (immediateSaleROI != null) {
      strategy = "immediate_sale";
    } else if (threeYearAnnualizedROI != null) {
      strategy = "three_year_hold";
    }

    // Ranking compares the best annualized path. Missing estimates never get invented ROI;
    // they retain only the mild discovery boost from the source €/sqm.
    const performance = [immediateSaleROI, threeYearAnnualizedROI]
      .filter(v => v != null && Number.isFinite(v));
    const bestAnnualizedROI = performance.length ? Math.max(...performance) : null;
    let score = bestAnnualizedROI != null ? Math.max(0, Math.min(90, bestAnnualizedROI * 100)) : 0;
    if (rec.startingPrice && rec.sqm) {
      const psm = rec.startingPrice / rec.sqm;
      score += Math.max(0, Math.min(10, (2500 - psm) / 250));
    }

    return {
      totalCost,
      immediateSaleProfit,
      immediateSaleROI,
      immediateSaleTarget50,
      threeYearRentalIncome,
      threeYearTotalProfit,
      threeYearROI,
      threeYearAnnualizedROI,
      bestAnnualizedROI,
      strategy,
      // Backward-compatible aliases used by older exports/UI.
      resaleProfit: immediateSaleProfit,
      resaleMargin: immediateSaleROI,
      grossRentYield,
      pricePerSqm: rec.startingPrice && rec.sqm ? rec.startingPrice / rec.sqm : null,
      score: Math.round(score * 10) / 10
    };
  }

  function list(options = {}) {
    const db = loadDB();
    let rows = Object.values(db.records).map(r => ({ ...r, metrics: computeMetrics(r) }));

    if (options.segment && options.segment !== "all") {
      rows = rows.filter(r => r.segment === options.segment);
    }
    if (options.activeOnly) rows = rows.filter(r => r.active);
    if (options.newToday) rows = rows.filter(r => r.firstSeenDay === dayKey());

    const sortBy = options.sortBy || "score";
    rows.sort((a, b) => {
      if (sortBy === "firstSeen") return String(b.firstSeen).localeCompare(String(a.firstSeen));
      if (sortBy === "startingPrice") return (a.startingPrice ?? Infinity) - (b.startingPrice ?? Infinity);
      return (b.metrics.score ?? 0) - (a.metrics.score ?? 0);
    });
    return rows;
  }

  function get(key) {
    return loadDB().records[key] || null;
  }

  function updateAnalysis(key, patch) {
    const db = loadDB();
    const rec = db.records[key];
    if (!rec) throw new Error(`Unknown auction key: ${key}`);
    rec.analysis = { ...(rec.analysis || {}), ...(patch || {}) };
    rec.history ||= [];
    rec.history.push({ at: nowISO(), kind: "analysis_updated", changes: Object.keys(patch || {}) });
    saveDB(db);
    dispatch("auction-radar:analysis-updated", { key });
    return { ...rec, metrics: computeMetrics(rec) };
  }

  function stats(segment = "all") {
    const rows = list({ segment });
    const today = dayKey();
    return {
      total: rows.length,
      active: rows.filter(r => r.active).length,
      newToday: rows.filter(r => r.firstSeenDay === today).length,
      changedToday: rows.filter(r => (r.history || []).some(h =>
        h.kind === "changed" && dayKey(h.at) === today
      )).length,
      industrial: rows.filter(r => r.segment === SEGMENTS.SINDOS_INDUSTRIAL).length,
      athens: rows.filter(r => r.segment === SEGMENTS.ATHENS).length
    };
  }

  function exportJSON(filename = `auction-radar-${dayKey()}.json`) {
    const blob = new Blob([JSON.stringify(loadDB(), null, 2)], { type: "application/json;charset=utf-8" });
    downloadBlob(blob, filename);
  }

  function exportCSV(options = {}) {
    const rows = list(options);
    const headers = [
      "key","segment","firstSeen","lastSeen","active","title","address","sqm",
      "startingPrice","auctionDate","source","url","estimatedMarketValue",
      "estimatedMonthlyRent","renovationCost","otherPurchaseCosts","targetBid","pricePerSqm",
      "grossRentYield","immediateSaleProfit","immediateSaleROI","immediateSaleTarget50",
      "threeYearRentalIncome","threeYearTotalProfit","threeYearROI","threeYearAnnualizedROI",
      "strategy","score"
    ];
    const escape = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [headers.join(";")];

    for (const r of rows) {
      const a = r.analysis || {}, m = r.metrics || {};
      const values = {
        ...r,
        estimatedMarketValue: a.estimatedMarketValue,
        estimatedMonthlyRent: a.estimatedMonthlyRent,
        renovationCost: a.renovationCost,
        otherPurchaseCosts: a.otherPurchaseCosts,
        targetBid: a.targetBid,
        pricePerSqm: m.pricePerSqm,
        grossRentYield: m.grossRentYield,
        immediateSaleProfit: m.immediateSaleProfit,
        immediateSaleROI: m.immediateSaleROI,
        immediateSaleTarget50: m.immediateSaleTarget50,
        threeYearRentalIncome: m.threeYearRentalIncome,
        threeYearTotalProfit: m.threeYearTotalProfit,
        threeYearROI: m.threeYearROI,
        threeYearAnnualizedROI: m.threeYearAnnualizedROI,
        strategy: m.strategy,
        score: m.score
      };
      lines.push(headers.map(h => escape(values[h])).join(";"));
    }

    const bom = "\ufeff";
    downloadBlob(
      new Blob([bom + lines.join("\n")], { type: "text/csv;charset=utf-8" }),
      options.filename || `auction-radar-${dayKey()}.csv`
    );
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function clearAll() {
    localStorage.removeItem(STORAGE_KEY);
    dispatch("auction-radar:cleared", {});
  }

  function backup() {
    return JSON.stringify(loadDB());
  }

  function restore(json) {
    const db = typeof json === "string" ? JSON.parse(json) : json;
    if (!db || !db.records) throw new Error("Invalid Auction Radar backup.");
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    dispatch("auction-radar:restored", {});
  }

  function dispatch(name, detail) {
    try {
      global.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (_) {}
  }

  global.AuctionRadarPhase1 = {
    version: "1.1.0",
    SEGMENTS,
    ingest,
    list,
    get,
    stats,
    updateAnalysis,
    markMissingInactive,
    exportJSON,
    exportCSV,
    backup,
    restore,
    clearAll,
    classifySegment,
    normalize,
    computeMetrics,
    dayKey
  };

  // Optional zero-code bridge: if the existing page exposes its daily rows
  // as window.__AUCTION_RECORDS__, they are automatically persisted.
  if (Array.isArray(global.__AUCTION_RECORDS__)) {
    try { ingest(global.__AUCTION_RECORDS__); } catch (_) {}
  }
})(window);
