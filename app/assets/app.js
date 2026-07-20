// ============================================================================================
// Market viewer — application script (split out of viewer/index.html, behavior-identical).
//
// Loads data/index.json, lazy-loads the cohort shards, and ranks listings by how far under fair
// value they sit (valuation.dealPct). The model lives in the pipeline (valuation.py) — this file
// only displays. Serve from the repo root:
//     python -m http.server 8000   ->   http://localhost:8000/viewer/
//
// Sections: state · data loading · render (deals + triage) · modal + charts · wiring.
// ============================================================================================

// ============ state =========================================================================
const ROOT = "data/";  // published: viewer at app/, data at app/data/ (was "../data/" in-repo)          // shared data root; each model lives under ROOT + id + "/"
let MODELS = [], MODEL = null;    // models.json manifest + the selected model
let DATA = ROOT;                  // per-model base path (ROOT + "<id>/"), set by selectModel
let ALL = [], REACHABLE = new Set(), COHORTS = null;
let detailChart = null;   // active Chart.js instance in the drill-down
let sortKey = "valuation.dealPct", sortDir = 1;
let triSortKey = "_prio", triSortDir = -1;          // triage defaults: highest priority first
let viewState = "deals";   // "deals" | "triage" — driven by the header tabs (was <select id=view>)

// --- dealer lenses (Deals view) ------------------------------------------------------------
// Presets over the SAME data (no new fetch) that re-point the deals table for a different reader.
// Picking a lens sets the default sort + an optional row filter and relabels a few columns so the
// table reads to the intended audience; the user can still re-sort by clicking any header.
//   shopper — today's behavior: under-market cars first (the buyer's view).
//   profit  — a dealer's own margin view: cars priced ABOVE model value, biggest $ gap first.
//   aging   — capital tied up: longest days-on-lot first, a stale (undropped) price flagged.
const LENSES = {
  shopper: { label: "Best deals", sort: ["valuation.dealPct", 1],
             hint: "Under-market cars first — the shopper's view." },
  profit:  { label: "Profit opportunity", sort: ["valuation.dealDelta", -1],
             filter: r => { const dp = get(r, "valuation.dealPct"); return dp != null && dp > 0; },
             headers: { "valuation.dealPct": "vs. market", "valuation.expected": "Market value" },
             hint: "Priced above model value, biggest $ gap first — margin being captured on the lot." },
  aging:   { label: "Aging capital", sort: ["valuation.signals.listedDays", -1],
             headers: { "valuation.expected": "Market value", "valuation.signals.listedDays": "Days / cuts" },
             stale: true,
             hint: "Longest time on lot first — a stale, un-cut price is the one to negotiate." },
};
let activeLens = "shopper";

const get = (o, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), o);
const f$ = n => n == null ? "—" : "$" + Math.round(n).toLocaleString();
const fPct = n => n == null ? "—" : (n > 0 ? "+" : "") + (n * 100).toFixed(1) + "%";
const fConf = n => n == null ? "?" : n.toFixed(2);
const view = () => viewState;
// Read a resolved design token so the Chart.js canvas (which needs concrete colors, not CSS vars)
// tracks the active light/dark theme. Falls back to a dark-legible default if the var is unset.
const cssVar = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};
// HTML-escape: every record is third-party (auto.dev feed + scraped dealer pages), so dealer/
// trim/vin/url strings are untrusted before they hit innerHTML — escape to fix stray '&' in
// dealer names today and to close attribute-breakout in the href.
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// --- trust (Deals view) --------------------------------------------------------------------
// How a field's value was confirmed, mapped to a strength. manual/vin/site are independently
// trustworthy; "search" means aggregators only (one listing's echoes can't run away, but it's
// weaker); feed/none never clear on their own. See confidence.py for the tiers.
const TIER_STRENGTH = { manual: "strong", vin: "strong", site: "strong", search: "mid", feed: "weak", none: "weak" };
const TIER_ABBR     = { manual: "man", vin: "VIN", site: "site", search: "agg", feed: "feed", none: "—" };

// A record is only as trustworthy as its WEAKER field — a rock-solid VIN powertrain doesn't
// help if the trim that completes the cohort key was a bare feed guess. Drive the badge off
// whichever of (trim, powertrain) has the lower confidence.
function trustOf(r) {
  const pc = r.powertrainConfidence, tc = r.trimConfidence;
  const weakPt = (pc == null ? -1 : pc) <= (tc == null ? -1 : tc);
  const tier = (weakPt ? r.powertrainVerifiedBy : r.trimVerifiedBy) || "none";
  return {
    strength: TIER_STRENGTH[tier] || "weak",
    label: (weakPt ? "P:" : "T:") + (TIER_ABBR[tier] || tier),
    title: `powertrain: ${r.powertrainVerifiedBy || "none"} ${fConf(pc)}  ·  trim: ${r.trimVerifiedBy || "none"} ${fConf(tc)}`,
  };
}

// --- condition signals (Deals + Triage) ------------------------------------------------------
// Owner/accident history is an unverified pass-through from the feed (no confidence tier like
// trim/powertrain), shown as plain info, not trust-gated. 559 records predate this data in the
// feed and show "—". CPO is resolved server-side (confidence.resolve_cpo) into 4 states:
// "manufacturer" (an OEM program phrase like "Toyota Certified" was mined off the dealer's own
// VDP) / "dealer" (a generic certified mention on a VDP, no OEM program) / "unknown" (the feed
// flags CPO but no VDP evidence attributes the source — most feed-CPO records, which clear via
// snippet-only search and never get a VDP fetch) / "none".
function conditionOf(r) {
  const parts = [];
  if (r.ownerCount != null) parts.push(`${r.ownerCount} owner${r.ownerCount === 1 ? "" : "s"}`);
  else if (r.oneOwner === true) parts.push("1 owner");
  if (r.accidentCount != null) parts.push(`${r.accidentCount} accident${r.accidentCount === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "—";
}
function cpoBadge(r) {
  if (r.cpo === "manufacturer") return `<span class="badge b-cpo-mfr" title="Manufacturer-certified (OEM program)">OEM CPO</span> `;
  if (r.cpo === "dealer") return `<span class="badge b-cpo" title="Dealer-certified (no OEM program)">CPO·D</span> `;
  if (r.cpo === "unknown") return `<span class="badge b-cpo-unknown" title="Certified per feed — source (dealer vs OEM) unverified">CPO?</span> `;
  if (r.cpo == null) return `<span class="badge">—</span> `;
  return "";  // "none" => no badge (absence reads as not-certified; keeps the table uncluttered)
}
function carfaxLink(r) {
  const u = (typeof r.carfaxUrl === "string" && /^https?:/.test(r.carfaxUrl)) ? r.carfaxUrl : null;
  return u ? `<a class="carfax-link" href="${esc(u)}" target="_blank" title="Carfax report">CF</a>` : "";
}
// `expected` is condition-adjusted off `marketValue` (accidents/owners/CPO/distance, see
// valuation.py layer 2); this renders that breakdown so the adjustment is visible, not baked in.
const ADJ_LABEL = { accidents: "Accidents", owners: "Owners", oneOwner: "1-owner", cpo: "CPO", distance: "Distance", optionLift: "Options" };
const ADJ_DOLLARS = { distance: true, optionLift: true };   // dollar deltas, not pct
function adjustmentTitle(v) {
  const adj = v.adjustments;
  if (!adj || !Object.keys(adj).length) return "";
  const parts = Object.entries(adj).map(([k, d]) =>
    `${ADJ_LABEL[k] || k}: ${ADJ_DOLLARS[k] ? f$(d) : fPct(d)}`);
  return `title="${esc(`market ${f$(v.marketValue)} · ${parts.join(" · ")}`)}"`;
}

// --- deal rating + market-timing signals (Deals view, valuation.py layers 3-4) ---------------
// The headline is an ABSOLUTE rating (price vs expected on fixed bands), not a within-cohort
// rank — in an overpriced cohort the least-bad car still isn't a deal. The badge is muted when
// `ratingConfident` is false (a thin pooled/msrp basis can't support an absolute call).
const RATING_LABEL = { great: "Great", good: "Good", fair: "Fair", high: "High", overpriced: "Over" };
function ratingBadge(v) {
  // A branded title (from VDP text or an identity-guarded search snippet) OVERRIDES the deal
  // rating with a hard danger badge — the car is excluded from comps and must never read as a deal.
  if (v.titleBrand) {
    const src = v.titleBrandSource || "vdp";
    return `<span class="badge r-branded" title="Branded title (source: ${esc(src)}) — excluded from comps">${esc(String(v.titleBrand).toUpperCase())}</span>`;
  }
  const r = v.rating;
  if (!r) return `<span class="badge">—</span>`;
  const cls = v.ratingConfident === false ? "r-muted" : "r-" + r;
  const conf = v.confidence == null ? "" : ` · conf ${v.confidence.toFixed(2)}`;
  const title = `${RATING_LABEL[r] || r} · ${fPct(v.dealPct)} vs expected · ${v.basis}${v.cohortN ? " n=" + v.cohortN : ""}${conf}`;
  return `<span class="badge ${cls}" title="${esc(title)}">${RATING_LABEL[r] || r}</span>`;
}
// Market-timing facts kept SEPARATE from value (vAuto's velocity idea): days on lot, price
// drops, and a derived negotiability — the stale / dropped car is the one to negotiate.
function signalsCell(v) {
  const s = v.signals || {};
  const hot = s.negotiability === "high";
  const bits = [];
  if (s.listedDays != null) {
    const cm = s.cohortMedianDaysListed;
    bits.push(`<span class="${hot ? "neg-high" : "stats"}" title="${esc(cm != null ? "cohort median " + cm + "d" : "")}">${s.listedDays}d</span>`);
  }
  if (s.priceDrop) bits.push(`<span class="neg-high" title="dropped over ${s.priceDrop.drops} step(s)">▼${f$(s.priceDrop.total)}</span>`);
  if (!bits.length) return "—";
  return `<span title="negotiability: ${s.negotiability || "—"}">${bits.join(" ")}</span>`;
}

// --- triage (Triage view) ------------------------------------------------------------------
// What's keeping the record out of the cohort. Trim-only is the cheapest to clear (powertrain
// already VIN-resolved → one corroboration does it); comboConflict is an illegal trim+powertrain
// pair that a search can't fix (it needs a data correction), so it ranks at the bottom.
function blockerOf(r) {
  if (r.comboConflict) return "combo";
  if (r.trimFlagged && r.powertrainFlagged) return "both";
  if (r.powertrainFlagged) return "powertrain";
  return "trim";
}

// Median asking price of CLEARED comps in the same (year, powertrain) — the reference a flagged
// record's price is judged against. Trim is unknown while flagged, so year+powertrain is the
// fair coarse cohort. Computed once over the cohort-ready set.
let PEER_MED = {};
function buildPeerMedians() {
  const groups = {};
  for (const r of ALL) {
    if (!r.cohortReady || r.gone || r.price == null) continue;
    (groups[`${r.year}|${r.powertrain}`] ||= []).push(r.price);
  }
  PEER_MED = {};
  for (const k in groups) {
    const a = groups[k].sort((x, y) => x - y), m = a.length >> 1;
    PEER_MED[k] = a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;   // true median for even cohorts
  }
}

// Priority = deal potential × clearability × reachability, each in [0,1], deal-weighted so a
// potentially-great deal that's merely stuck floats above a meh car that's easy to clear.
function triageScore(r) {
  const med = PEER_MED[`${r.year}|${r.powertrain}`];
  const gap = (med && r.price != null) ? (med - r.price) / med : 0;   // +ve = cheaper than comps
  const deal = Math.max(0, Math.min(1, gap / 0.15));                   // 15% under comps -> maxed
  const blk = blockerOf(r);
  const close = blk === "combo" ? 0 : blk === "trim" ? 0.9 : blk === "powertrain" ? 0.5 : 0.35;
  const reach = REACHABLE.has(r.dealer) ? 1 : 0;
  const score = 0.45 * deal + 0.35 * close + 0.20 * reach;
  const bf = blk === "powertrain" ? r.powertrainConfidence
           : blk === "both" ? Math.min(r.trimConfidence ?? 0, r.powertrainConfidence ?? 0)
           : r.trimConfidence;
  return { score, blocker: blk, dealGap: (med && r.price != null) ? gap : null, reach: reach === 1, blockConf: bf ?? null };
}

// ============ data loading ==================================================================
async function load() {
  const idx = await fetch(DATA + "index.json").then(r => r.json());
  const shards = await Promise.all(idx.shards.map(s => fetch(DATA + s.file).then(r => r.json())));
  ALL = shards.flat();
  // dealer registry (verify.py) — a record is "reachable" (clearable cheaply) if its dealer has
  // a known domain. Optional: the viewer still works if dealers.json isn't served.
  try {
    const reg = await fetch("../dealers.json").then(r => r.json());
    REACHABLE = new Set(reg.filter(d => d.domain).map(d => d.name));
  } catch (e) { REACHABLE = new Set(); }

  // per-cohort visualization data (engine-computed lines/bands/depreciation). Optional: the
  // viewer still works without it — the drill-down just omits the chart.
  try { COHORTS = await fetch(DATA + "cohorts.json").then(r => r.json()); } catch (e) { COHORTS = null; }

  buildPeerMedians();
  ALL.forEach(r => {
    // precompute the weaker-field confidence so the Trust column is sortable like any other key.
    r._trustConf = Math.min(r.trimConfidence == null ? 0 : r.trimConfidence,
                            r.powertrainConfidence == null ? 0 : r.powertrainConfidence);
    if (r.flagged) {
      const t = triageScore(r);
      r._prio = t.score; r._blocker = t.blocker; r._dealGap = t.dealGap;
      r._reachable = t.reach ? 1 : 0; r._blockConf = t.blockConf;
    }
  });
  document.getElementById("stats").textContent =
    `${idx.total} listings · ${idx.cohortReady} cohort-ready · ${idx.flagged} flagged`;
  const fresh = document.getElementById("freshness");
  if (fresh) fresh.textContent = idx.generatedAt ? `data as of ${idx.generatedAt}` : "";
  const years = [...new Set(ALL.map(r => r.year))].sort();
  // rebuilt from scratch each load so switching models doesn't append duplicate year options
  document.getElementById("year").innerHTML =
    `<option value="">All years</option>` + years.map(y => `<option>${y}</option>`).join("");
  render();
}

// ============ render (deals + triage) =======================================================
function commonFilter(r) {
  const pt = document.getElementById("powertrain").value;
  const year = document.getElementById("year").value;
  const hideGone = document.getElementById("hideGone").checked;
  if (pt && r.powertrain !== pt) return false;
  if (year && String(r.year) !== year) return false;
  if (hideGone && r.gone) return false;
  return true;
}

function sortBy(rows, key, dir) {
  return rows.sort((a, b) => {
    const x = get(a, key), y = get(b, key);
    if (x == null) return 1; if (y == null) return -1;
    return (x > y ? 1 : x < y ? -1 : 0) * dir;
  });
}

// stale = long time on lot with NO price cut yet — the negotiable, un-marked-down car the aging
// lens surfaces (same rule the ranking engine's stalePriceCount uses: listedDays>=60 ∧ no drop).
function isStale(v) {
  const s = (v || {}).signals || {};
  return s.listedDays != null && s.listedDays >= 60 && !s.priceDrop;
}

function renderDeals() {
  const basis = document.getElementById("basis").value;
  const lens = LENSES[activeLens] || LENSES.shopper;
  let rows = ALL.filter(r => {
    if (!commonFilter(r)) return false;
    const b = get(r, "valuation.basis");
    if (basis === "trust" && !["cohort", "pooled"].includes(b)) return false;
    if (basis === "" && (b === "not-ready" || b == null)) return false;
    if (lens.filter && !lens.filter(r)) return false;   // lens row filter (e.g. profit = over-market only)
    return true;
  });
  sortBy(rows, sortKey, sortDir);
  document.getElementById("rows").innerHTML = rows.map(r => {
    const v = r.valuation || {}, dp = v.dealPct;
    const tr = trustOf(r);
    // an underpriced deal only earns the bright "good" color when BOTH the classification
    // behind its cohort is solid AND the valuation basis is dense enough to trust the band;
    // otherwise show it muted so a shaky clear or a thin fit can't masquerade as a steal.
    const solid = tr.strength === "strong" && v.ratingConfident !== false;
    const cls = dp == null ? ""
      : dp < -0.03 ? (solid ? "pct-good" : "pct-tentative")
      : dp > 0.03 ? "pct-bad" : "";
    const url = (typeof r.url === "string" && /^https?:/.test(r.url)) ? r.url : null;
    return `<tr class="${r.gone ? "gone" : ""}" data-vin="${esc(r.vin || "")}">
      <td class="num">${ratingBadge(v)} <span class="${cls}">${fPct(dp)}</span></td>
      <td>${r.year}</td><td>${esc(r.trim || "—")}</td>
      <td>${r.powertrain || "—"}</td>
      <td><span class="badge t-${tr.strength}" title="${tr.title}">${tr.label}</span></td>
      <td class="num">${(r.mileage || 0).toLocaleString()}</td>
      <td class="num">${f$(r.price)}</td><td class="num" ${adjustmentTitle(v)}>${f$(v.expected)}</td>
      <td><span class="badge b-${v.basis}">${v.basis || "—"}${v.cohortN ? " · n=" + v.cohortN : ""}</span></td>
      <td class="num">${signalsCell(v)}${lens.stale && isStale(v) ? ` <span class="chip-stale" title="≥60 days on lot with no price cut — negotiable">stale</span>` : ""}</td>
      <td class="num">${r.distanceMi == null ? "—" : r.distanceMi + "mi"}</td>
      <td>${esc(r.dealer || "—")}</td>
      <td>${cpoBadge(r)}${esc(conditionOf(r))}</td>
      <td>${url ? `<a href="${esc(url)}" target="_blank">${esc((r.vin || "").slice(-6))}</a>` : esc((r.vin || "").slice(-6))}${carfaxLink(r)}</td>
    </tr>`;
  }).join("");
  return rows.length;
}

function renderTriage() {
  let rows = ALL.filter(r => r.flagged && commonFilter(r));
  sortBy(rows, triSortKey, triSortDir);
  const maxP = Math.max(0.001, ...rows.map(r => r._prio || 0));
  document.getElementById("triageRows").innerHTML = rows.map(r => {
    const blk = r._blocker;
    const url = (typeof r.url === "string" && /^https?:/.test(r.url)) ? r.url : null;
    const gap = r._dealGap == null ? "—"
      : `<span class="${r._dealGap > 0.03 ? "pct-good" : r._dealGap < -0.03 ? "pct-bad" : ""}">${fPct(-r._dealGap)}</span>`;
    return `<tr class="${r.gone ? "gone" : ""}" data-vin="${esc(r.vin || "")}">
      <td title="deal×clearability×reachability"><span class="prio-bar" style="width:${Math.round(46 * (r._prio || 0) / maxP)}px"></span>
        <span class="stats"> ${Math.round(100 * (r._prio || 0))}</span></td>
      <td>${r.year}</td><td>${esc(r.trim || "—")}</td><td>${r.powertrain || "—"}</td>
      <td><span class="badge blk-${blk}">${blk}</span></td>
      <td class="num">${fConf(r._blockConf)}</td>
      <td class="num">${f$(r.price)}</td>
      <td class="num">${gap}</td>
      <td class="${r._reachable ? "yes" : "no"}">${r._reachable ? "✓" : "—"}</td>
      <td class="num">${(r.mileage || 0).toLocaleString()}</td>
      <td>${esc(r.dealer || "—")}</td>
      <td>${cpoBadge(r)}${esc(conditionOf(r))}</td>
      <td>${url ? `<a href="${esc(url)}" target="_blank">${esc((r.vin || "").slice(-6))}</a>` : esc((r.vin || "").slice(-6))}${carfaxLink(r)}</td>
    </tr>`;
  }).join("");
  return rows.length;
}

function render() {
  const triage = view() === "triage";
  document.getElementById("dealsTable").hidden = triage;
  document.getElementById("triageTable").hidden = !triage;
  document.getElementById("basis").hidden = triage;        // basis is meaningless for flagged rows
  document.getElementById("lensBar").hidden = triage;      // lenses re-point the Deals table only
  const n = triage ? renderTriage() : renderDeals();
  const empty = document.getElementById("empty");
  empty.hidden = n > 0;
  empty.textContent = triage ? "No flagged records match — backlog is clear for this filter."
                             : "No cohort-ready deals match — run the verify worker to clear trims/powertrains.";
}

function wireSort(tableId, getKey, setKey) {
  document.querySelectorAll(`#${tableId} th[data-k]`).forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    setKey(k, getKey().key === k ? -getKey().dir : (tableId === "triageTable" ? -1 : 1));
    render();
  });
}
wireSort("dealsTable", () => ({ key: sortKey, dir: sortDir }), (k, d) => { sortKey = k; sortDir = d; });
wireSort("triageTable", () => ({ key: triSortKey, dir: triSortDir }), (k, d) => { triSortKey = k; triSortDir = d; });

// ============ modal + charts (drill-down detail) ============================================
// Rating colors come from the same design tokens the table bands use, resolved to concrete hex at
// draw time so the chart tracks the active light/dark theme (Chart.js can't consume CSS vars).
const RATING_TOKENS = { great: "--deal-great", good: "--deal-good", fair: "--deal-fair", high: "--deal-high", overpriced: "--deal-over" };
const RATING_FALLBACK = { great: "#2dd4aa", good: "#5fbf9b", fair: "#8a8a98", high: "#f5a623", overpriced: "#f26b6b" };
const ratingColor = k => cssVar(RATING_TOKENS[k], RATING_FALLBACK[k]);
const cohortKey = r => `${r.year}|${r.trim}|${r.powertrain}`;
const medianOf = a => { const s = a.filter(x => x != null).sort((x, y) => x - y), n = s.length;
  return n ? (n % 2 ? s[n >> 1] : (s[(n >> 1) - 1] + s[n >> 1]) / 2) : null; };
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16);
  return `rgba(${n>>16&255},${n>>8&255},${n&255},${a})`; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// deal-rating bands shaded to FOLLOW the (sloped) Theil-Sen line, drawn behind the points so the
// table's great/good/fair/high/over colors read straight off the chart.
const bandPlugin = {
  id: "cohortBands",
  beforeDatasetsDraw(chart) {
    const cfg = chart.$bands; if (!cfg || !cfg.line) return;
    const { ctx, chartArea: ca, scales: { x, y } } = chart;
    const L = cfg.line, b = cfg.bands;
    const yp = (mi, m) => clamp(y.getPixelForValue((L.slope * mi + L.intercept) * m), ca.top, ca.bottom);
    const mults = [1 + b.great, 1 + b.good, 1 + b.fair, 1 + b.high];   // 0.90 0.95 1.05 1.10
    const cols = ["great", "good", "fair", "high", "overpriced"].map(ratingColor);
    const eL = [ca.bottom, ...mults.map(m => yp(x.min, m)), ca.top];
    const eR = [ca.bottom, ...mults.map(m => yp(x.max, m)), ca.top];
    const xL = x.getPixelForValue(x.min), xR = x.getPixelForValue(x.max);
    ctx.save();
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(xL, eL[i]); ctx.lineTo(xR, eR[i]);
      ctx.lineTo(xR, eR[i + 1]); ctx.lineTo(xL, eL[i + 1]); ctx.closePath();
      ctx.fillStyle = hexA(cols[i], 0.10); ctx.fill();
    }
    ctx.restore();
  },
};
if (window.Chart) Chart.register(bandPlugin);

const chartToggles = { ols: false, parent: false, bands: true, mode: "scatter" };
let CURRENT_REC = null;

function lineSeg(fit, xMin, xMax) {
  return fit ? [{ x: xMin, y: fit.slope * xMin + fit.intercept }, { x: xMax, y: fit.slope * xMax + fit.intercept }] : [];
}

function renderCohortChart(rec) {
  const cv = document.getElementById("cohortChart");
  if (!cv || !window.Chart) return;
  if (detailChart) { detailChart.destroy(); detailChart = null; }
  const note = document.getElementById("chartNote");
  if (note) note.textContent = "";
  const key = cohortKey(rec);
  const cdata = (COHORTS && COHORTS.cohorts) ? COHORTS.cohorts[key] : null;

  if (chartToggles.mode === "depreciation") {
    const dep = (COHORTS && COHORTS.depreciation) ? COHORTS.depreciation[`${rec.trim}|${rec.powertrain}`] : null;
    if (!dep || !dep.length) { if (note) note.textContent = "No depreciation series for this trim yet."; return; }
    // MSRP is absent for some models (e.g. the feed mislabels the trim, so there's no verified base
    // MSRP) — fall back to a market-value-vs-age series so the chart stays honest instead of blank.
    // Both branches map over the full dep array so dep[c.dataIndex] stays aligned in the tooltip.
    const hasMsrp = dep.some(d => d.retained != null);
    const usd = v => "$" + (v / 1000).toFixed(0) + "k";
    if (!hasMsrp && note) note.textContent = "No verified MSRP for this trim — showing market value vs. age.";
    const accent = cssVar("--accent", "#7aa2ff"), muted = cssVar("--text-muted", "#8a8a98"),
      grid = cssVar("--border", "#262633"), txt = cssVar("--text", "#d8d8e0");
    detailChart = new Chart(cv, {
      type: "line",
      data: { datasets: [
        { label: hasMsrp ? "% of MSRP retained" : "Market value (median)",
          data: hasMsrp ? dep.map(d => ({ x: d.age, y: d.retained == null ? null : +(d.retained * 100).toFixed(1) }))
                        : dep.map(d => ({ x: d.age, y: d.marketValue })),
          borderColor: accent, backgroundColor: accent, tension: .25, pointRadius: 4 },
      ] },
      options: { responsive: true, maintainAspectRatio: false,
        scales: { x: { title: { display: true, text: "Age (years)" }, reverse: true, ticks: { color: muted }, grid: { color: grid } },
                  y: { title: { display: true, text: hasMsrp ? "% of MSRP retained" : "Market value" },
                       ticks: { color: muted, callback: hasMsrp ? undefined : (v => usd(v)) }, grid: { color: grid } } },
        plugins: { legend: { labels: { color: txt } },
          tooltip: { callbacks: { label: c => { const d = dep[c.dataIndex];
            const mi = d.medianMileage != null ? ` @ ${d.medianMileage.toLocaleString()}mi` : "";
            return hasMsrp
              ? `${d.year}: ${c.parsed.y}% retained · mkt ${f$(d.marketValue)}${mi} · MSRP ${f$(d.msrp)}`
              : `${d.year}: ${f$(d.marketValue)}${mi}`; } } } } },
    });
    return;
  }

  const inCohort = r => !r.gone && r.price != null && r.mileage != null && cohortKey(r) === key;
  const inParent = r => !r.gone && r.price != null && r.mileage != null
    && r.year === rec.year && r.powertrain === rec.powertrain && r.trim !== rec.trim;
  const cohort = ALL.filter(inCohort);
  const parent = ALL.filter(inParent);
  const pt = r => ({ x: r.mileage, y: r.price, _r: r });
  const miles = cohort.map(r => r.mileage).concat(rec.mileage || 0);
  const xMin = Math.min(...miles), xMax = Math.max(...miles);

  const accent = cssVar("--accent", "#7aa2ff"), muted = cssVar("--text-muted", "#8a8a98"),
    grid = cssVar("--border", "#262633"), txt = cssVar("--text", "#d8d8e0"),
    surface = cssVar("--surface", "#fff");
  const datasets = [];
  datasets.push({ label: "Other trims (same year)", data: parent.map(pt), pointRadius: 2.5,
    backgroundColor: hexA(muted, .3), hidden: !chartToggles.parent });
  datasets.push({ label: "Cohort comps", data: cohort.filter(r => r.vin !== rec.vin).map(pt),
    pointRadius: 4, backgroundColor: hexA(accent, .85) });
  datasets.push({ label: "This car", data: [pt(rec)], pointRadius: 7, pointStyle: "rectRot",
    backgroundColor: surface, borderColor: accent, borderWidth: 2 });
  if (cdata) {
    datasets.push({ label: "Theil-Sen (robust)", type: "line", data: lineSeg(cdata.theilSen, xMin, xMax),
      borderColor: ratingColor("great"), borderWidth: 2, pointRadius: 0, fill: false });
    datasets.push({ label: "OLS (naive)", type: "line", data: lineSeg(cdata.ols, xMin, xMax),
      borderColor: ratingColor("high"), borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, fill: false,
      hidden: !chartToggles.ols });
  }

  // Cohorts with no robust fit (common for low-volume models like Venza, but also a well-populated
  // cohort whose comps share one mileage → null Theil-Sen) get an explanatory note so the empty
  // deal-band area reads as intentional. Report the engine's cohort size (cohorts.json n = count of
  // cohort-ready members), falling back to the plotted comps (excluding this car) when no viz entry.
  if (note && (!cdata || !cdata.theilSen)) {
    const n = (cdata && cdata.n != null) ? cdata.n : cohort.filter(r => r.vin !== rec.vin).length;
    note.textContent = `No robust fit (n=${n}).`;
  }

  detailChart = new Chart(cv, {
    type: "scatter",
    data: { datasets },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      scales: { x: { title: { display: true, text: "Mileage" }, ticks: { color: muted, callback: v => (v / 1000) + "k" }, grid: { color: grid } },
                y: { title: { display: true, text: "Price" }, ticks: { color: muted, callback: v => "$" + (v / 1000).toFixed(0) + "k" }, grid: { color: grid } } },
      plugins: { legend: { labels: { color: txt, filter: i => i.text !== "OLS (naive)" || chartToggles.ols } },
        tooltip: { callbacks: { label: c => { const r = c.raw && c.raw._r; if (!r) return c.dataset.label;
          const v = r.valuation || {}; return `${r.trim} · ${(r.mileage||0).toLocaleString()}mi · ${f$(r.price)}${v.dealPct!=null ? " · "+fPct(v.dealPct)+" "+(v.rating||"") : ""}`; } } } },
    },
    plugins: [bandPlugin],
  });
  detailChart.$bands = (cdata && cdata.theilSen && chartToggles.bands && COHORTS.bands)
    ? { line: cdata.theilSen, bands: COHORTS.bands } : null;
  detailChart.update();
}

// animate each cohort point falling from its first listed price to its current price (price-drop
// history), so a screen full of motivated sellers is visible at a glance.
function replayPriceDrops() {
  if (!detailChart || chartToggles.mode !== "scatter") return;
  const ds = detailChart.data.datasets.filter(d => d.type !== "line");
  const frames = [];
  ds.forEach(d => d.data.forEach(p => {
    const h = p._r && p._r.priceHistory;
    if (h && h.length > 1) frames.push({ p, from: h[0].price, to: p.y });
  }));
  if (!frames.length) return;
  const t0 = performance.now(), dur = 1400;
  detailChart.$bands && (detailChart.$bands._save = detailChart.$bands, detailChart.$bands = null);
  const step = now => {
    const k = clamp((now - t0) / dur, 0, 1), e = 1 - Math.pow(1 - k, 3);
    frames.forEach(f => f.p.y = f.from + (f.to - f.from) * e);
    detailChart.update("none");
    if (k < 1) requestAnimationFrame(step);
    else renderCohortChart(CURRENT_REC);   // restore bands + final state
  };
  requestAnimationFrame(step);
}

function sparkline(history) {
  if (!history || history.length < 2) return "";
  const ps = history.map(h => h.price), n = ps.length;
  const lo = Math.min(...ps), hi = Math.max(...ps), span = hi - lo || 1, W = 220, H = 44;
  const pts = ps.map((p, i) => `${(i / (n - 1) * W).toFixed(1)},${(H - 4 - (p - lo) / span * (H - 8)).toFixed(1)}`).join(" ");
  const drop = ps[n - 1] < ps[0];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${drop ? "var(--good)" : "var(--dim)"}" stroke-width="2"/></svg>`;
}

function kv(k, v) { return v == null || v === "" ? "" : `<div><span class="k">${k}</span>${esc(v)}</div>`; }

function openDetail(rec) {
  CURRENT_REC = rec;
  const v = rec.valuation || {}, tr = trustOf(rec);
  document.getElementById("detailTitle").textContent = `${rec.year} ${MODEL ? MODEL.model : ""} ${rec.trim || ""} ${rec.powertrain || ""}`.replace(/\s+/g, " ").trim();
  // Listing URL is third-party feed data, so scheme-check before it becomes an href (same
  // guard the table rows and carfax link use).
  const listingUrl = (typeof rec.url === "string" && /^https?:/.test(rec.url)) ? rec.url : null;
  const dealerLink = listingUrl
    ? `<a href="${esc(listingUrl)}" target="_blank">${esc(rec.dealer || "View listing")} ↗</a>`
    : esc(rec.dealer || "—");
  document.getElementById("detailSub").innerHTML =
    `${ratingBadge(v)} &nbsp; ${(rec.mileage || 0).toLocaleString()} mi &nbsp;·&nbsp; ${f$(rec.price)}` +
    (v.expected != null ? ` &nbsp;·&nbsp; expected ${f$(v.expected)} (${fPct(v.dealPct)})` : "") +
    `<div style="margin-top:6px;font-size:13px">VIN <span style="font-family:monospace;user-select:all">${esc(rec.vin || "—")}</span> &nbsp;·&nbsp; ${dealerLink}</div>`;

  const key = cohortKey(rec);
  const cohort = ALL.filter(r => !r.gone && r.price != null && cohortKey(r) === key);
  const cMedP = medianOf(cohort.map(r => r.price)), cMedM = medianOf(cohort.map(r => r.mileage || 0));

  const adj = v.adjustments || {};
  const adjRows = Object.entries(adj).map(([k, d]) =>
    `<div class="adj-row"><span>${ADJ_LABEL[k] || k}</span><span class="${d < 0 ? "neg" : "pos"}">${ADJ_DOLLARS[k] ? f$(d) : fPct(d)}</span></div>`).join("")
    || '<p class="vlog">No condition adjustments (cohort-average history).</p>';

  const vlog = (rec.verifyLog || []).slice(-6).map(e =>
    `<li>${esc(e.how || e.tier || "obs")} · ${esc(e.host || "")} → ${esc(e.trim || "")} ${esc(e.powertrain || "")} <span class="stats">(${esc(e.strength || "")})</span></li>`).join("");

  const carfax = (typeof rec.carfaxUrl === "string" && /^https?:/.test(rec.carfaxUrl))
    ? `<a href="${esc(rec.carfaxUrl)}" target="_blank">View Carfax report ↗</a>` : '<span class="vlog">No Carfax link in feed.</span>';

  const opts = (rec.options && rec.options.length)
    ? `<div class="chips">${rec.options.map(o => `<span>${esc(o)}</span>`).join("")}</div>`
    : '<span class="vlog">No options mined from a dealer page yet.</span>';

  const hasChart = !!window.Chart;
  document.getElementById("detailBody").innerHTML = `
    <div class="sect">
      <h3>Cohort — price vs mileage</h3>
      ${hasChart ? `<div class="chart-tools">
        <button id="tgScatter" class="${chartToggles.mode === "scatter" ? "on" : ""}">Price vs mileage</button>
        <button id="tgDep" class="${chartToggles.mode === "depreciation" ? "on" : ""}">Depreciation</button>
        <span style="flex:1"></span>
        <button id="tgBands" class="${chartToggles.bands ? "on" : ""}">Deal bands</button>
        <button id="tgOls" class="${chartToggles.ols ? "on" : ""}">vs naive OLS</button>
        <button id="tgParent" class="${chartToggles.parent ? "on" : ""}">Other trims</button>
        <button id="tgReplay">▶ Replay price drops</button>
      </div>
      <div class="chart-wrap"><canvas id="cohortChart"></canvas></div>
      <div id="chartNote" class="vlog"></div>`
      : '<p class="vlog">Chart library unavailable offline.</p>'}
    </div>
    <div class="sect"><h3>Price history</h3>
      ${sparkline(rec.priceHistory)}
      <div class="vlog">${(rec.priceHistory || []).map(h => `${h.date}: ${f$(h.price)}`).join(" &nbsp;→&nbsp; ") || "Single observation."}</div>
      ${signalsCell(v) !== "—" ? `<div style="margin-top:6px">Market: ${signalsCell(v)}</div>` : ""}
    </div>
    <div class="sect"><h3>Carfax &amp; provenance</h3>
      <div>${carfax}</div>
      ${vlog ? `<ul class="vlog">${vlog}</ul>` : '<p class="vlog">No verification log.</p>'}
    </div>
    <div class="sect"><h3>Cohort snapshot</h3>
      <div class="kv">
        ${kv("Cohort", `${rec.trim} ${rec.powertrain} ${rec.year}`)}
        ${kv("Comps (n)", v.cohortN ?? cohort.length)}
        ${kv("Basis", v.basis)}
        ${kv("Median price", cMedP == null ? null : f$(cMedP))}
        ${kv("Median miles", cMedM == null ? null : cMedM.toLocaleString())}
        ${kv("Market value", v.marketValue == null ? null : f$(v.marketValue))}
      </div>
    </div>
    <div class="sect"><h3>Trust signals</h3>
      <div class="kv">
        <div><span class="k">Trust</span><span class="badge t-${tr.strength}">${tr.label}</span> ${esc(tr.title)}</div>
        ${kv("Rating confidence", v.confidence == null ? null : v.confidence.toFixed(2) + (v.ratingConfident === false ? " (muted)" : ""))}
        ${kv("Trim conf", rec.trimConfidence == null ? null : fConf(rec.trimConfidence) + " via " + (rec.trimVerifiedBy || "—"))}
        ${kv("Powertrain conf", rec.powertrainConfidence == null ? null : fConf(rec.powertrainConfidence) + " via " + (rec.powertrainVerifiedBy || "—"))}
      </div>
    </div>
    <div class="sect"><h3>Condition adjustments</h3>${adjRows}</div>
    <div class="sect"><h3>Specs</h3>
      <div class="kv">
        ${kv("Exterior", rec.exteriorColor)} ${kv("Interior", rec.interiorColor)}
        ${kv("Engine", rec.engine)} ${kv("Transmission", rec.transmission)}
        ${kv("Drivetrain", rec.drivetrain)} ${kv("Base MSRP", rec.baseMsrp == null ? null : f$(rec.baseMsrp))}
        ${kv("Built", rec.plantCountry ? [rec.plantCity, rec.plantCountry].filter(Boolean).join(", ") : null)}
        ${kv("CPO", rec.cpo === "manufacturer" ? "Yes (OEM)" : rec.cpo === "dealer" ? "Yes (Dealer)" : rec.cpo === "unknown" ? "Yes (source unverified)" : null)} ${kv("Condition", conditionOf(rec))}
        ${rec.titleBrand ? `<div><span class="k">Title</span><span class="badge r-branded">${esc(String(rec.titleBrand).toUpperCase())}</span> <span class="stats">source: ${esc(rec.titleBrandSource || "vdp")} — excluded from comps</span></div>` : ""}
      </div>
      <div style="margin-top:8px"><span class="k" style="color:var(--dim)">Options </span>${opts}</div>
    </div>`;

  if (hasChart) {
    const set = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    const reflectAndRender = () => { ["tgBands","tgOls","tgParent","tgScatter","tgDep"].forEach(id => {
      const el = document.getElementById(id); if (!el) return;
      const on = id === "tgBands" ? chartToggles.bands : id === "tgOls" ? chartToggles.ols
        : id === "tgParent" ? chartToggles.parent : id === "tgScatter" ? chartToggles.mode === "scatter"
        : chartToggles.mode === "depreciation"; el.classList.toggle("on", on); });
      renderCohortChart(rec); };
    set("tgBands", () => { chartToggles.bands = !chartToggles.bands; reflectAndRender(); });
    set("tgOls", () => { chartToggles.ols = !chartToggles.ols; reflectAndRender(); });
    set("tgParent", () => { chartToggles.parent = !chartToggles.parent; reflectAndRender(); });
    set("tgScatter", () => { chartToggles.mode = "scatter"; reflectAndRender(); });
    set("tgDep", () => { chartToggles.mode = "depreciation"; reflectAndRender(); });
    set("tgReplay", replayPriceDrops);
    renderCohortChart(rec);
  }

  const modal = document.getElementById("detail");
  modal.hidden = false;
  document.getElementById("detailClose").focus();
}

function closeDetail() {
  const modal = document.getElementById("detail");
  modal.hidden = true;
  if (detailChart) { detailChart.destroy(); detailChart = null; }
  CURRENT_REC = null;
}

// ============ wiring ========================================================================
// open on row click (event delegation; rows carry data-vin), close on ×/backdrop/ESC
function wireRowClicks(id) {
  document.getElementById(id).addEventListener("click", e => {
    const tr = e.target.closest("tr[data-vin]"); if (!tr) return;
    if (e.target.closest("a")) return;            // let VIN/carfax links work normally
    const rec = ALL.find(r => r.vin === tr.dataset.vin);
    if (rec) openDetail(rec);
  });
}
wireRowClicks("rows");
wireRowClicks("triageRows");
document.getElementById("detailClose").addEventListener("click", closeDetail);
document.getElementById("detail").addEventListener("click", e => { if (e.target.id === "detail") closeDetail(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !document.getElementById("detail").hidden) closeDetail(); });

["powertrain", "basis", "year", "hideGone"].forEach(id =>
  document.getElementById(id).addEventListener("change", render));

// view tabs — write viewState (the old <select id=view>) and reflect the active tab
document.querySelectorAll("#viewTabs .tab").forEach(btn => btn.addEventListener("click", () => {
  viewState = btn.dataset.view;
  document.querySelectorAll("#viewTabs .tab").forEach(b => {
    const on = b === btn;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  render();
}));

// --- dealer lens selector -------------------------------------------------------------------
// Default column-header text, captured so a lens can relabel and restore. Keyed by the th's
// data-k (which stays put — only the visible label changes, sort keys are untouched).
const DEFAULT_HEADERS = { "valuation.dealPct": "Deal", "valuation.expected": "Expected",
                          "valuation.signals.listedDays": "Market" };
function relabelHeaders(lens) {
  const over = (lens && lens.headers) || {};
  for (const k in DEFAULT_HEADERS) {
    const th = document.querySelector(`#dealsTable th[data-k="${k}"]`);
    if (th) th.textContent = over[k] || DEFAULT_HEADERS[k];
  }
}
function selectLens(name) {
  const lens = LENSES[name] || LENSES.shopper;
  activeLens = LENSES[name] ? name : "shopper";
  [sortKey, sortDir] = lens.sort;          // lens default sort (user can still re-sort by header)
  document.querySelectorAll("#lens button").forEach(b => b.classList.toggle("on", b.dataset.lens === activeLens));
  document.getElementById("lensHint").textContent = lens.hint || "";
  relabelHeaders(lens);
  render();
}
(function buildLensBar() {
  const box = document.getElementById("lens");
  if (!box) return;
  box.innerHTML = Object.entries(LENSES).map(([k, l]) =>
    `<button data-lens="${k}"${k === activeLens ? ' class="on"' : ""}>${l.label}</button>`).join("");
  box.querySelectorAll("button").forEach(b => b.addEventListener("click", () => selectLens(b.dataset.lens)));
  document.getElementById("lensBar").hidden = false;      // reveal now that it's populated
  document.getElementById("lensHint").textContent = LENSES[activeLens].hint || "";
})();

// theme toggle — explicit choice sets data-theme on <html> and persists; absent choice follows the
// OS (prefers-color-scheme) via the stylesheet. Chart colors read tokens, so re-render an open modal.
function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
}
function currentTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr) return attr;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
(function initTheme() {
  applyTheme(localStorage.getItem("viewerTheme"));   // null → OS default
  const btn = document.getElementById("themeToggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    localStorage.setItem("viewerTheme", next);
    applyTheme(next);
    if (CURRENT_REC && detailChart) renderCohortChart(CURRENT_REC);   // recolor an open chart
  });
})();

// Set the page chrome (title, powertrain options) for the selected model, then load its data.
function applyModelChrome() {
  const title = `${MODEL.label} Market`;
  document.title = title;
  document.getElementById("appTitle").textContent = title;
  const pts = MODEL.powertrains || [];
  document.getElementById("powertrain").innerHTML =
    pts.map(p => `<option value="${p.id}">${p.label}</option>`).join("") +
    `<option value="">All powertrains</option>`;
  document.getElementById("powertrain").value = MODEL.targetPowertrain || "";   // "" = all
}

async function selectModel(id) {
  MODEL = MODELS.find(m => m.id === id) || MODELS[0];
  DATA = ROOT + MODEL.id + "/";
  localStorage.setItem("model", MODEL.id);
  applyModelChrome();
  try {
    await load();
  } catch (e) {
    // a failed switch must not leave the previous model's rows under the new model's chrome
    ALL = []; COHORTS = null; render();
    document.getElementById("stats").textContent = "load error: " + e;
  }
}

// Load the manifest, fill the model selector, then show the saved (or first) model.
async function init() {
  try { MODELS = (await fetch(ROOT + "models.json").then(r => r.json())).models || []; }
  catch (e) { MODELS = []; }
  if (!MODELS.length) {
    document.getElementById("stats").textContent = "no data/models.json — run fetch.py first";
    return;
  }
  const sel = document.getElementById("model");
  sel.innerHTML = MODELS.map(m => `<option value="${m.id}">${m.label}</option>`).join("");
  sel.hidden = MODELS.length < 2;     // no point showing a one-option selector
  const saved = localStorage.getItem("model");
  const initial = MODELS.some(m => m.id === saved) ? saved : MODELS[0].id;
  sel.value = initial;
  sel.addEventListener("change", () => selectModel(sel.value));
  await selectModel(initial);
}

init();
