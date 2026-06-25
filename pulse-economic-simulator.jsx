import React, { useState, useRef, useEffect } from "react";
import CONFIG from "./pulse-config.json";

/* ------------------------------------------------------------------ *
 * PULSE — Economic Sentiment Observatory + Message Bus
 *
 * Two coupled layers:
 *  1. A deterministic MACRO engine (the exogenous "constants") that
 *     moves each cycle by scenario + aggregate sentiment.
 *  2. A live LLM world layer with FULL AGENCY: each cycle Claude writes
 *     how eight personas react AND decides the actual world events that
 *     occur — who founds, hires, is laid off, quits, deals, invests, or
 *     shuts down — given the whole context.
 *
 * The engine does NOT adjudicate outcomes. It is a faithful ledger:
 * it applies the model's decided events to state (with light guards so
 * a bad reference can't crash it) and feeds the result back into macro.
 * ------------------------------------------------------------------ */

const { MAX_TICKS, MODEL, PERSONAS, INDICATORS, SCENARIOS, BOUNDS, SENT, EVENT_META, STATUS_META, AGING_CYCLES, GROUPS, GROUP_KIND_META } = CONFIG;

const byHandle = Object.fromEntries(PERSONAS.map((p) => [p.handle, p]));
const byGroupHandle = Object.fromEntries(GROUPS.map((g) => [g.handle, g]));
const idxOf = (h) => PERSONAS.findIndex((p) => p.handle === h);

/* ---------- helpers ---------- */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const norm = (s) => String(s || "").replace(/^@/, "").toLowerCase().trim();
const personaOf = (econ, h) => byHandle[h] || byGroupHandle[h] || (econ.dynamicPersonas && econ.dynamicPersonas[h]) || null;
const nameOf = (econ, h) => personaOf(econ, h)?.name || h;

function stepMacro(v, key, tick, mood) {
  const s = SCENARIOS[key], d = s.drift, n = () => Math.random() - 0.5;
  const nv = { ...v };
  nv.rate = v.rate + d.rate + 0.05 * n();
  nv.unemployment = v.unemployment + d.unemployment - 0.18 * mood + 0.08 * n();
  nv.inflation = v.inflation + d.inflation + 0.06 * n();
  nv.gdp = v.gdp + d.gdp + 0.6 * mood + 0.12 * n();
  nv.stocks = v.stocks * (1 + d.stocks / 100 + (mood * 0.9) / 100 + 0.004 * n());
  nv.confidence = v.confidence + d.confidence + 6.5 * mood + 0.6 * n();
  const ev = s.events[tick];
  if (ev) for (const k in ev) { if (k === "stocks") nv.stocks *= 1 + ev[k] / 100; else nv[k] += ev[k]; }
  for (const k of Object.keys(BOUNDS)) nv[k] = clamp(nv[k], BOUNDS[k][0], BOUNDS[k][1]);
  return nv;
}

function fmt(key, val) {
  const m = INDICATORS.find((i) => i.key === key);
  if (key === "stocks") return Math.round(val).toLocaleString();
  return val.toFixed(m.dec);
}
function fmtDelta(key, dv) {
  const m = INDICATORS.find((i) => i.key === key);
  const sign = dv > 0 ? "+" : "";
  if (key === "stocks") return sign + Math.round(dv).toLocaleString();
  return sign + dv.toFixed(m.dec);
}

const sentInfo = (s) => SENT.find((b) => s <= b.max) || SENT[2];

function cycleLabel(tick) {
  if (tick === 0) return "Pre-sim";
  const y = Math.floor((tick - 1) / 4) + 1, q = ((tick - 1) % 4) + 1;
  return `Year ${y} · Q${q}`;
}

/* ---------- economy state ---------- */
function initEconomy() {
  const agents = {};
  const set = (h, status, employer) => (agents[h] = {
    handle: h, status, employer: employer || null,
    seeking: status === "seeking", married_to: null, deceased: false, born_tick: null,
  });
  set("rustbelt_marcus", "seeking", null);
  set("priya_builds", "founder", "v_anand");
  set("eleanor_v", "retired", null);
  set("devontrades", "trader", null);
  set("sofiascafe", "founder", "v_cafe");
  set("jamalwheels", "gig", null);
  set("okafor_realty", "founder", "v_realty");
  set("dr_lin_macro", "economist", null);
  const ventures = {
    v_anand: { id: "v_anand", name: "Anand Labs", sector: "tech", founder: "priya_builds", employees: [] },
    v_cafe: { id: "v_cafe", name: "Marín's Café", sector: "food", founder: "sofiascafe", employees: [] },
    v_realty: { id: "v_realty", name: "Okafor Realty", sector: "real estate", founder: "okafor_realty", employees: [] },
    v_megacorp: { id: "v_megacorp", name: "MegaCorp Industries", sector: "conglomerate", founder: "megacorp_industries", employees: [] },
  };
  return { agents, ventures, seq: 1, dynamicPersonas: {},
    totals: { hires: 0, deals: 0, launches: 0, layoffs: 0, invests: 0, closes: 0, marriages: 0, births: 0, deaths: 0, buys: 0, purchases: 0, rate_changes: 0, regulates: 0, spending_bills: 0, tax_actions: 0 } };
}

const ventureOfFounder = (econ, h) => Object.values(econ.ventures).find((v) => v.founder === h) || null;

function agentHandle(econ, str) {
  const t = norm(str);
  if (byHandle[t]) return t;
  if (byGroupHandle[t]) return t;
  if (econ.dynamicPersonas && econ.dynamicPersonas[t]) return t;
  const all = [...PERSONAS, ...GROUPS, ...Object.values(econ.dynamicPersonas || {})];
  const p = all.find((x) =>
    norm(x.handle) === t || x.name.toLowerCase() === t || x.name.toLowerCase().split(" ")[0] === t ||
    (t && (t.includes(x.handle) || x.handle.includes(t) || x.name.toLowerCase().includes(t))));
  return p ? p.handle : null;
}
function findVenture(econ, str) {
  if (!str) return null;
  const t = norm(str);
  let v = Object.values(econ.ventures).find((x) =>
    x.id === str || x.name.toLowerCase() === t || (t && (x.name.toLowerCase().includes(t) || t.includes(x.name.toLowerCase()))));
  if (v) return v;
  const fh = agentHandle(econ, str);
  if (fh) return ventureOfFounder(econ, fh);
  return null;
}

/* ---------- the ledger: faithfully apply the model's decided events ---------- */
function applyEvents(econ, events, vitals, tick) {
  const ledger = [];
  const micro = { hires: 0, launches: 0, deals: 0, layoffs: 0, invests: 0, closes: 0, marriages: 0, births: 0, deaths: 0, buys: 0, purchases: 0, rate_delta: 0, gdp_boost: 0, confidence_boost: 0, stocks_shock: 0 };
  const order = { rate_change: 0, regulate: 0, stimulus: 0, subsidize: 0, bailout: 0, launch: 1, marry: 2, acquire: 2, invest: 3, hire: 4, deal: 5, buy: 6, purchase: 7, quit: 8, layoff: 9, close: 10, birth: 11, death: 12 };
  const evs = [...events].sort((a, b) => (order[a.type] ?? 99) - (order[b.type] ?? 99));
  const leave = (wh) => { for (const vv of Object.values(econ.ventures)) { const i = vv.employees.indexOf(wh); if (i >= 0) vv.employees.splice(i, 1); } };

  for (const ev of evs) {
    try {
      if (ev.type === "launch") {
        const fh = agentHandle(econ, ev.founder || ev.worker || ev.handle);
        if (!fh) continue;
        const a0 = econ.agents[fh]; if (!a0 || a0.deceased || a0.status === "child") continue;
        const nm = (ev.venture && String(ev.venture).trim()) || `${nameOf(econ, fh).split(" ")[0]}'s venture`;
        if (Object.values(econ.ventures).some((v) => v.founder === fh && v.name.toLowerCase() === nm.toLowerCase())) continue;
        const id = "v_" + econ.seq++;
        econ.ventures[id] = { id, name: nm, sector: ev.sector || "services", founder: fh, employees: [] };
        const a = econ.agents[fh]; if (a) { a.status = "founder"; a.employer = id; a.seeking = false; }
        micro.launches++; econ.totals.launches++;
        ledger.push({ kind: "launch", text: `${nm} founded by ${nameOf(econ, fh)} (${econ.ventures[id].sector})` });
      } else if (ev.type === "marry") {
        const p1 = agentHandle(econ, ev.partner1), p2 = agentHandle(econ, ev.partner2);
        if (!p1 || !p2 || p1 === p2) continue;
        const a1 = econ.agents[p1], a2 = econ.agents[p2];
        if (!a1 || !a2 || a1.deceased || a2.deceased || a1.status === "child" || a2.status === "child") continue;
        if (a1.married_to || a2.married_to) continue;
        a1.married_to = p2; a2.married_to = p1;
        micro.marriages++; econ.totals.marriages++;
        ledger.push({ kind: "marry", text: `${nameOf(econ, p1)} and ${nameOf(econ, p2)} got married` });
      } else if (ev.type === "hire") {
        const wh = agentHandle(econ, ev.worker || ev.target);
        const v = findVenture(econ, ev.venture || ev.employer || ev.founder);
        if (!wh || !v) continue;
        const w = econ.agents[wh]; if (!w || w.status === "retired" || w.deceased || w.status === "child") continue;
        if (w.status === "founder" && ventureOfFounder(econ, wh)) continue;
        leave(wh);
        if (!v.employees.includes(wh)) v.employees.push(wh);
        w.status = "employed"; w.employer = v.id; w.seeking = false;
        micro.hires++; econ.totals.hires++;
        ledger.push({ kind: "hire", text: `${nameOf(econ, wh)} hired by ${v.name}${ev.role ? " as " + ev.role : ""}` });
      } else if (ev.type === "deal") {
        const b = agentHandle(econ, ev.buyer);
        const s = agentHandle(econ, ev.seller || ev.target || ev.provider);
        if (!b || !s || b === s) continue;
        const ab = econ.agents[b], as_ = econ.agents[s];
        if (ab?.deceased || as_?.deceased) continue;
        micro.deals++; econ.totals.deals++;
        ledger.push({ kind: "deal", text: `${nameOf(econ, b)} bought ${ev.what || "services"} from ${nameOf(econ, s)}` });
      } else if (ev.type === "buy") {
        const bh = agentHandle(econ, ev.buyer || ev.person);
        if (!bh) continue;
        const ab = econ.agents[bh]; if (!ab || ab.deceased || ab.status === "child") continue;
        const item = ev.what || "groceries";
        const where = ev.where ? ` at ${ev.where}` : "";
        micro.buys++; econ.totals.buys++;
        ledger.push({ kind: "buy", text: `${nameOf(econ, bh)} bought ${item}${where}` });
      } else if (ev.type === "purchase") {
        const bh = agentHandle(econ, ev.buyer || ev.person);
        if (!bh) continue;
        const ab = econ.agents[bh]; if (!ab || ab.deceased || ab.status === "child") continue;
        const item = ev.what || "a major item";
        micro.purchases++; econ.totals.purchases++;
        ledger.push({ kind: "purchase", text: `${nameOf(econ, bh)} purchased ${item}` });
      } else if (ev.type === "quit") {
        const wh = agentHandle(econ, ev.worker); if (!wh) continue;
        const w = econ.agents[wh]; if (!w || w.deceased) continue;
        const v = findVenture(econ, ev.venture) || (w.employer && econ.ventures[w.employer]);
        leave(wh); w.status = "seeking"; w.employer = null; w.seeking = true;
        micro.layoffs++;
        ledger.push({ kind: "quit", text: `${nameOf(econ, wh)} left ${v ? v.name : "their job"}` });
      } else if (ev.type === "layoff") {
        const v = findVenture(econ, ev.venture); if (!v) continue;
        const wh = agentHandle(econ, ev.worker);
        const target = wh && v.employees.includes(wh) ? wh : v.employees[v.employees.length - 1];
        if (!target) continue;
        v.employees.splice(v.employees.indexOf(target), 1);
        const w = econ.agents[target]; if (w) { w.status = "seeking"; w.employer = null; w.seeking = true; }
        micro.layoffs++; econ.totals.layoffs++;
        ledger.push({ kind: "layoff", text: `${v.name} laid off ${nameOf(econ, target)}` });
      } else if (ev.type === "close") {
        const v = findVenture(econ, ev.venture); if (!v) continue;
        for (const wh of [...v.employees]) { const w = econ.agents[wh]; if (w) { w.status = "seeking"; w.employer = null; w.seeking = true; } micro.layoffs++; }
        const f = econ.agents[v.founder]; if (f && !f.deceased) { f.status = "seeking"; f.employer = null; f.seeking = true; }
        micro.closes++; econ.totals.closes++;
        ledger.push({ kind: "close", text: `${v.name} shut down` });
        delete econ.ventures[v.id];
      } else if (ev.type === "invest") {
        const inv = agentHandle(econ, ev.investor);
        const v = findVenture(econ, ev.venture); if (!v) continue;
        if (inv && econ.agents[inv]?.deceased) continue;
        micro.invests++; econ.totals.invests++;
        ledger.push({ kind: "invest", text: `${inv ? nameOf(econ, inv) : "An investor"} backed ${v.name}` });
      } else if (ev.type === "rate_change") {
        const issuer = agentHandle(econ, ev.issuer); if (!issuer || !byGroupHandle[issuer]) continue;
        const delta = clamp(Number(ev.delta) || 0, -3, 3);
        micro.rate_delta += delta;
        micro.confidence_boost += delta < 0 ? 3 : -2;
        econ.totals.rate_changes = (econ.totals.rate_changes || 0) + 1;
        const dir = delta > 0 ? `hiked by ${delta.toFixed(2)}%` : `cut by ${Math.abs(delta).toFixed(2)}%`;
        ledger.push({ kind: "rate_change", text: `${nameOf(econ, issuer)} ${dir}` });
      } else if (ev.type === "stimulus") {
        const issuer = agentHandle(econ, ev.issuer); if (!issuer || !byGroupHandle[issuer]) continue;
        const amount = clamp(Number(ev.amount) || 0.5, 0, 3);
        micro.gdp_boost += amount; micro.confidence_boost += amount * 3;
        ledger.push({ kind: "stimulus", text: `${nameOf(econ, issuer)} issued $${(amount * 100).toFixed(0)}B stimulus` });
      } else if (ev.type === "subsidize") {
        const issuer = agentHandle(econ, ev.issuer); if (!issuer || !byGroupHandle[issuer]) continue;
        const sector = ev.sector || "all sectors";
        const amount = clamp(Number(ev.amount) || 0.3, 0, 2);
        micro.gdp_boost += amount * 0.5; micro.confidence_boost += amount * 2;
        ledger.push({ kind: "subsidize", text: `${nameOf(econ, issuer)} subsidized ${sector}` });
      } else if (ev.type === "bailout") {
        const issuer = agentHandle(econ, ev.issuer); if (!issuer || !byGroupHandle[issuer]) continue;
        const v = findVenture(econ, ev.venture); if (!v) continue;
        micro.confidence_boost += 4; micro.stocks_shock += 1.5;
        ledger.push({ kind: "bailout", text: `${nameOf(econ, issuer)} bailed out ${v.name}` });
      } else if (ev.type === "regulate") {
        const issuer = agentHandle(econ, ev.issuer); if (!issuer || !byGroupHandle[issuer]) continue;
        const action = ev.action || "audit";
        if (action === "close") {
          const v = findVenture(econ, ev.target); if (!v) continue;
          for (const wh of [...v.employees]) { const w = econ.agents[wh]; if (w) { w.status = "seeking"; w.employer = null; w.seeking = true; } micro.layoffs++; }
          const f = econ.agents[v.founder]; if (f && !f.deceased) { f.status = "seeking"; f.employer = null; f.seeking = true; }
          micro.closes++; econ.totals.closes++;
          ledger.push({ kind: "regulate", text: `${nameOf(econ, issuer)} shut down ${v.name}` });
          delete econ.ventures[v.id];
        } else {
          const target = ev.target ? (findVenture(econ, ev.target)?.name || ev.target) : "market";
          micro.confidence_boost -= 2;
          econ.totals.regulates = (econ.totals.regulates || 0) + 1;
          ledger.push({ kind: "regulate", text: `${nameOf(econ, issuer)} issued ${action} against ${target}` });
        }
      } else if (ev.type === "spending_bill") {
        const issuer = agentHandle(econ, ev.issuer); if (!issuer || !byGroupHandle[issuer]) continue;
        const amount = clamp(Number(ev.amount) || 0.5, 0, 4);
        const sector = ev.sector || "general";
        micro.gdp_boost += amount * 0.7; micro.confidence_boost += amount * 4;
        econ.totals.spending_bills = (econ.totals.spending_bills || 0) + 1;
        ledger.push({ kind: "spending_bill", text: `${nameOf(econ, issuer)} passed $${(amount * 100).toFixed(0)}B ${sector} spending bill` });
      } else if (ev.type === "tax_cut") {
        const issuer = agentHandle(econ, ev.issuer); if (!issuer || !byGroupHandle[issuer]) continue;
        const amount = clamp(Number(ev.amount) || 0.5, 0, 3);
        micro.gdp_boost += amount * 0.3; micro.confidence_boost += amount * 5;
        econ.totals.tax_actions = (econ.totals.tax_actions || 0) + 1;
        ledger.push({ kind: "tax_cut", text: `${nameOf(econ, issuer)} passed a $${(amount * 100).toFixed(0)}B tax cut` });
      } else if (ev.type === "tax_hike") {
        const issuer = agentHandle(econ, ev.issuer); if (!issuer || !byGroupHandle[issuer]) continue;
        const amount = clamp(Number(ev.amount) || 0.5, 0, 3);
        micro.gdp_boost -= amount * 0.2; micro.confidence_boost -= amount * 3;
        econ.totals.tax_actions = (econ.totals.tax_actions || 0) + 1;
        ledger.push({ kind: "tax_hike", text: `${nameOf(econ, issuer)} raised taxes by $${(amount * 100).toFixed(0)}B` });
      } else if (ev.type === "safety_net") {
        const issuer = agentHandle(econ, ev.issuer); if (!issuer || !byGroupHandle[issuer]) continue;
        const amount = clamp(Number(ev.amount) || 0.3, 0, 2);
        micro.gdp_boost += amount * 0.2; micro.confidence_boost += amount * 3;
        econ.totals.spending_bills = (econ.totals.spending_bills || 0) + 1;
        ledger.push({ kind: "safety_net", text: `${nameOf(econ, issuer)} expanded the social safety net` });
      } else if (ev.type === "acquire") {
        const acquirer = agentHandle(econ, ev.acquirer || ev.buyer);
        const target = findVenture(econ, ev.venture || ev.target);
        if (!acquirer || !byGroupHandle[acquirer] || !target) continue;
        const prevFounder = target.founder;
        target.founder = acquirer;
        const f = econ.agents[prevFounder]; if (f && !f.deceased) { f.status = "employed"; f.employer = target.id; }
        micro.confidence_boost -= 1; micro.stocks_shock += 0.5;
        ledger.push({ kind: "acquire", text: `${nameOf(econ, acquirer)} acquired ${target.name}` });
      } else if (ev.type === "birth") {
        const parentH = agentHandle(econ, ev.parent);
        if (parentH && econ.agents[parentH]?.deceased) continue;
        const nm = (ev.name && String(ev.name).trim()) || "New Child";
        const emoji = ev.emoji || "👶";
        const handle = nm.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/__+/g, "_").replace(/^_|_$/g, "") + "_" + econ.seq++;
        const bio = `Child of ${parentH ? nameOf(econ, parentH) : "unknown"}. Growing up during this economy — will enter the workforce in ${AGING_CYCLES} cycles.`;
        econ.dynamicPersonas[handle] = { handle, name: nm, emoji, bio };
        econ.agents[handle] = { handle, status: "child", employer: null, seeking: false, married_to: null, deceased: false, born_tick: tick, parent: parentH };
        micro.births++; econ.totals.births++;
        ledger.push({ kind: "birth", text: `${nm} was born${parentH ? " to " + nameOf(econ, parentH) : ""}` });
      } else if (ev.type === "death") {
        const ph = agentHandle(econ, ev.person || ev.handle); if (!ph) continue;
        const a = econ.agents[ph]; if (!a || a.deceased) continue;
        const cause = ev.cause || "natural";
        leave(ph);
        if (a.married_to && econ.agents[a.married_to]) econ.agents[a.married_to].married_to = null;
        a.deceased = { cause, tick }; a.status = "deceased"; a.seeking = false; a.employer = null;
        micro.deaths++; econ.totals.deaths++;
        const causeLabel = { crime: "by crime", natural: "of natural causes", self: "by their own hand" }[cause] || cause;
        ledger.push({ kind: `death_${cause}`, text: `${nameOf(econ, ph)} died ${causeLabel}` });
      }
    } catch (_) { /* skip malformed event */ }
  }
  return { ledger, micro };
}

function applyMicroToMacro(v, micro) {
  const jobLoss = micro.layoffs;
  const nv = { ...v };
  nv.rate += micro.rate_delta;
  nv.unemployment += 0.2 * jobLoss - 0.22 * micro.hires;
  nv.confidence += 1.6 * micro.hires + 2.2 * micro.launches + 0.5 * micro.deals + 1.0 * micro.invests
    - 1.4 * jobLoss - 2.5 * micro.deaths + 0.3 * micro.marriages
    + 0.1 * micro.buys + 0.3 * micro.purchases + micro.confidence_boost;
  nv.gdp += 0.12 * micro.launches + 0.05 * micro.deals + 0.05 * micro.invests - 0.12 * jobLoss
    + 0.01 * micro.buys + 0.08 * micro.purchases + micro.gdp_boost;
  nv.stocks *= (1 + 0.0025 * micro.launches + 0.001 * micro.deals + 0.002 * micro.invests)
    * (micro.stocks_shock ? 1 + micro.stocks_shock / 100 : 1);
  for (const k of Object.keys(BOUNDS)) nv[k] = clamp(nv[k], BOUNDS[k][0], BOUNDS[k][1]);
  return nv;
}

/* ---------- LLM layer ---------- */
function rosterText(econ) {
  const personaLines = [...PERSONAS, ...Object.values(econ.dynamicPersonas || {})].map((p) => {
    const a = econ.agents[p.handle];
    if (!a) return null;
    if (a.deceased) return `@${p.handle} — DECEASED (${a.deceased.cause}, cycle ${a.deceased.tick})`;
    if (a.status === "child") return `@${p.handle} — Child (born cycle ${a.born_tick}, enters workforce cycle ${a.born_tick + AGING_CYCLES})`;
    const emp = a.employer && econ.ventures[a.employer] ? ` @ ${econ.ventures[a.employer].name}` : "";
    const st = STATUS_META[a.status] ? STATUS_META[a.status].label : a.status;
    const married = a.married_to ? ` 💍 @${a.married_to}` : "";
    return `@${p.handle} — ${st}${emp}${married}`;
  }).filter(Boolean);
  const groupLines = GROUPS.map((g) => {
    const gkm = GROUP_KIND_META[g.kind] || {};
    const v = Object.values(econ.ventures).find((vv) => vv.founder === g.handle);
    return `@${g.handle} — ${gkm.label || g.kind}${v ? ` (runs ${v.name}, staff: ${v.employees.length})` : ""}`;
  });
  return [...personaLines, "", "INSTITUTIONS:", ...groupLines].join("\n");
}
function venturesText(econ) {
  const vs = Object.values(econ.ventures);
  if (!vs.length) return "(none — the field is open)";
  return vs.map((v) => {
    const founderSuffix = econ.agents[v.founder]?.deceased ? " (deceased)" : "";
    return `${v.name} (${v.sector}) — founder @${v.founder}${founderSuffix} — staff: ${v.employees.length ? v.employees.map((h) => nameOf(econ, h)).join(", ") : "none"}`;
  }).join("\n");
}

function buildPrompt(vitals, deltas, tick, mood, recent, econ) {
  const lines = INDICATORS.map((m) => {
    const dv = deltas ? deltas[m.key] : 0;
    const arrow = dv > 1e-4 ? "▲" : dv < -1e-4 ? "▼" : "▪";
    const d = deltas ? ` (${arrow} ${fmtDelta(m.key, dv)})` : "";
    return `- ${m.label}: ${fmt(m.key, vitals[m.key])}${m.unit}${d}`;
  }).join("\n");
  const mi = sentInfo(mood);
  const allAliveAdults = [...PERSONAS, ...Object.values(econ.dynamicPersonas || {})].filter((p) => {
    const a = econ.agents[p.handle]; return a && !a.deceased && a.status !== "child";
  });
  const people = allAliveAdults.map((p, i) => `${i + 1}. @${p.handle} — ${p.name}: ${p.bio}`).join("\n");
  const groupList = GROUPS.map((g) => `@${g.handle} — ${g.name}: ${g.bio}`).join("\n");
  const recentStr = recent && recent.length ? recent.map((r) => `@${r.handle}: "${r.post}"`).join("\n") : "(none yet — first cycle)";

  return `You are the world model for an economic simulation. PULSE is a social network and marketplace where people and institutions live their economic and personal lives. You have FULL AGENCY — you decide what actually happens this cycle. Let outcomes follow naturally from the conditions.

CURRENT ECONOMY (after this cycle's macro move):
${lines}
Cycle ${tick} of ${MAX_TICKS} (${cycleLabel(tick)}). Public mood last cycle: ${mi.label} (${mood.toFixed(2)}).

THE PEOPLE (alive adults — each must post this cycle):
${people}

INSTITUTIONS (post when they take action; otherwise may stay silent):
${groupList}

CURRENT STATUS:
${rosterText(econ)}

ACTIVE VENTURES:
${venturesText(econ)}

RECENT POSTS (oldest → newest):
${recentStr}

DECIDE THIS CYCLE. Return a JSON object with two keys:

"posts": one per alive adult person, plus optional posts from institutions when they act. Short post (max 25 words, distinct voice), "sentiment" from -1.0 to 1.0, optional "action" tag. Institutions speak in formal policy language; omit sentiment for them (default 0).

"events": concrete events this cycle. Most cycles should have mundane consumer activity (buy/purchase) alongside larger events. Use institutional actions when economic conditions justify them. Each event:
PERSON EVENTS:
- {"type":"launch","founder":"@handle","venture":"Name","sector":"tech|food|logistics|services|retail|real estate|..."}
- {"type":"hire","worker":"@handle","venture":"Name","role":"..."}
- {"type":"layoff","venture":"Name","worker":"@handle"}
- {"type":"quit","worker":"@handle","venture":"Name"}
- {"type":"close","venture":"Name"}
- {"type":"deal","buyer":"@handle","seller":"@handle","what":"..."}
- {"type":"invest","investor":"@handle","venture":"Name"}
- {"type":"buy","buyer":"@handle","what":"groceries|gas|coffee|medicine|takeout|etc","where":"store name"} — everyday consumable
- {"type":"purchase","buyer":"@handle","what":"car|laptop|furniture|appliance|home|etc"} — major durable (when income allows)
- {"type":"marry","partner1":"@handle","partner2":"@handle"} — two unattached adults; use sparingly
- {"type":"birth","parent":"@handle","name":"Full Name","emoji":"single emoji"} — child enters workforce after ${AGING_CYCLES} cycles
- {"type":"death","person":"@handle","cause":"crime|natural|self"} — permanent exit; only when genuinely warranted
MONETARY & REGULATORY EVENTS (issuer must be a group handle):
- {"type":"rate_change","issuer":"@federal_reserve","delta":0.25} — rate hike (positive) or cut (negative); max ±0.5 per cycle
- {"type":"stimulus","issuer":"@federal_reserve|@sec_regulator","amount":0.5} — monetary stimulus (amount in index points)
- {"type":"subsidize","issuer":"@sec_regulator","sector":"tech|food|...","amount":0.3} — sector subsidy
- {"type":"bailout","issuer":"@federal_reserve","venture":"Name"} — rescue a distressed venture
- {"type":"regulate","issuer":"@sec_regulator","target":"VentureName|market","action":"fine|audit|close"} — regulatory action
- {"type":"acquire","acquirer":"@megacorp_industries","venture":"Name"} — MegaCorp absorbs a venture
GOVERNMENT FISCAL EVENTS (issuer must be @us_congress):
- {"type":"spending_bill","issuer":"@us_congress","amount":1.0,"sector":"infrastructure|defense|healthcare|education|social"} — spending bill; GDP and confidence boost
- {"type":"tax_cut","issuer":"@us_congress","amount":0.5} — tax reduction; confidence boost, mild GDP lift
- {"type":"tax_hike","issuer":"@us_congress","amount":0.5} — tax increase; confidence penalty, fiscal tightening
- {"type":"safety_net","issuer":"@us_congress","amount":0.3} — expand unemployment benefits or social programs; cushions confidence during downturns
POLITICAL RULES:
- @us_congress acts ONLY when public confidence is visibly falling, unemployment is rising, or the population is losing faith. It does not act in good times.
- Individuals and corporations may post political opinions and express frustration or support — that is normal speech. There is NO "lobby" event type; corporate influence is expressed only through posts, not direct action.
Keep events mutually consistent. Institutions act rarely but decisively when conditions are extreme.

Return ONLY the JSON object, no markdown fences:
{"posts":[{"handle":"rustbelt_marcus","post":"...","sentiment":-0.3,"action":"Job hunting"},{"handle":"federal_reserve","post":"The Committee voted to hold rates...","sentiment":0}],"events":[{"type":"buy","buyer":"@rustbelt_marcus","what":"groceries","where":"Kroger"}]}`;
}

function parseTurn(raw, econ) {
  let t = (raw || "").trim().replace(/```json/gi, "").replace(/```/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b !== -1) t = t.slice(a, b + 1);
  const o = JSON.parse(t);
  const posts = Array.isArray(o.posts) ? o.posts.map((p) => ({
    handle: norm(p.handle), post: String(p.post || "").trim(),
    sentiment: clamp(Number(p.sentiment) || 0, -1, 1),
    action: p.action ? String(p.action).trim() : null,
  })).filter((p) => {
    const h = p.handle; if (!p.post) return false;
    if (byHandle[h] || byGroupHandle[h]) return true;
    const a = econ.agents[h]; return a && !a.deceased && a.status !== "child";
  }) : [];
  const events = Array.isArray(o.events) ? o.events.filter((e) => e && typeof e === "object" && e.type) : [];
  return { posts, events };
}

async function fetchTurn(vitals, deltas, tick, mood, recent, econ) {
  const res = await fetch("/api/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1600, messages: [{ role: "user", content: buildPrompt(vitals, deltas, tick, mood, recent, econ) }] }),
  });
  if (!res.ok) throw new Error(`Model request failed (${res.status})`);
  const data = await res.json();
  const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const { posts, events } = parseTurn(text, econ);
  posts.sort((x, y) => {
    const ix = idxOf(x.handle), iy = idxOf(y.handle);
    if (ix >= 0 && iy >= 0) return ix - iy;
    if (ix >= 0) return -1; if (iy >= 0) return 1;
    return x.handle.localeCompare(y.handle);
  });
  if (!posts.length) throw new Error("Couldn't read the crowd this cycle.");
  return { posts, events };
}

/* ---------- UI bits ---------- */
function PulseLine({ history, mood }) {
  const W = 300, H = 64, pad = 4;
  const pts = history.length ? history : [{ tick: 0, mood: 0 }];
  const n = Math.max(pts.length, 2);
  const x = (i) => pad + (i * (W - 2 * pad)) / (n - 1);
  const y = (m) => H / 2 - m * (H / 2 - pad);
  const poly = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.mood).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1], lc = sentInfo(mood).color;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="pulse-svg" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="#2A335A" strokeWidth="1" strokeDasharray="3 4" />
      <polyline points={poly} fill="none" stroke={lc} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(pts.length - 1)} cy={y(last.mood)} r="3.5" fill={lc}>
        <animate attributeName="r" values="3.5;6;3.5" dur="1.6s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}

function Vital({ m, value, delta }) {
  let dir = "flat", col = "#8A8F9E";
  if (delta > 1e-4) dir = "up"; else if (delta < -1e-4) dir = "down";
  if (m.good) { const ok = (m.good === "down" && dir === "down") || (m.good === "up" && dir === "up"); if (dir !== "flat") col = ok ? "#3FB8A0" : "#D9544D"; }
  else if (dir !== "flat") col = "#E8A13A";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "▪";
  return (
    <div className="vital">
      <div className="vital-label">{m.label}</div>
      <div className="vital-row">
        <span className="vital-val">{fmt(m.key, value)}<span className="vital-unit">{m.unit}</span></span>
        <span className="vital-delta" style={{ color: col }}>{arrow} {fmtDelta(m.key, delta)}</span>
      </div>
    </div>
  );
}

function Post({ p }) {
  if (p.type === "system") {
    const meta = EVENT_META[p.kind] || { icon: "•", color: "#8A8F9E" };
    return (
      <div className="sys-post" style={{ borderColor: meta.color }}>
        <span className="sys-ic">{meta.icon}</span><span className="sys-text">{p.text}</span><span className="sys-cycle">C{p.tick}</span>
      </div>
    );
  }
  const group = byGroupHandle[p.handle];
  const gkm = group ? (GROUP_KIND_META[group.kind] || { label: group.kind, color: "#8A8F9E" }) : null;
  const si = sentInfo(p.sentiment);
  const borderColor = gkm ? gkm.color : si.color;
  const emoji = p._emoji || byHandle[p.handle]?.emoji || group?.emoji || "👤";
  const name = p._name || byHandle[p.handle]?.name || group?.name || p.handle;
  return (
    <article className={"post" + (group ? " group-post" : "")} style={{ borderLeftColor: borderColor }}>
      <div className="post-head">
        <span className="post-avatar">{emoji}</span>
        <span className="post-name">{name}</span>
        <span className="post-handle">@{p.handle}</span>
        {gkm && <span className="act-chip inst-chip" style={{ color: gkm.color, borderColor: gkm.color + "55", background: gkm.color + "18" }}>{gkm.label}</span>}
        {!group && p.action && <span className="act-chip">{p.action}</span>}
        <span className="post-cycle">· C{p.tick}</span>
      </div>
      <p className="post-body">{p.post}</p>
      {!group && (
        <div className="post-foot">
          <span />
          <span className="post-mood" style={{ color: si.color }}><span className="dot" style={{ background: si.color }} /> {si.label} {p.sentiment.toFixed(2)}</span>
        </div>
      )}
    </article>
  );
}

function VentureCard({ v, econView }) {
  const fp = byHandle[v.founder] || byGroupHandle[v.founder] || econView?.dynamicPersonas?.[v.founder];
  const dead = econView?.agents?.[v.founder]?.deceased;
  return (
    <div className="venture">
      <div className="venture-top"><span className="venture-name">{v.name}</span></div>
      <div className="venture-meta">
        <span className="sector">{v.sector}</span>
        <span className="founder" style={dead ? { color: "#4A4A6A" } : {}}>
          {fp ? fp.emoji + " " + fp.name.split(" ")[0] : v.founder}{dead ? " †" : ""}
        </span>
        <span className="staff">👥 {v.employees.length}</span>
      </div>
    </div>
  );
}

/* ================================================================== */
export default function App() {
  const [scenarioKey, setScenarioKey] = useState("soft_landing");
  const [vitals, setVitals] = useState(SCENARIOS.soft_landing.init);
  const [deltas, setDeltas] = useState(null);
  const [tick, setTick] = useState(0);
  const [feed, setFeed] = useState([]);
  const [mood, setMood] = useState(0);
  const [history, setHistory] = useState([]);
  const [playing, setPlaying] = useState(false);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [speed, setSpeed] = useState("normal");
  const [econView, setEconView] = useState(initEconomy());

  const sim = useRef({ vitals: SCENARIOS.soft_landing.init, tick: 0, mood: 0 });
  const econRef = useRef(initEconomy());
  const recentRef = useRef([]);
  const ticking = useRef(false);
  const playRef = useRef(false);
  const timer = useRef(null);
  const speedRef = useRef("normal");
  const DELAY = { fast: 350, normal: 1100, slow: 2400 };

  useEffect(() => () => clearTimeout(timer.current), []);

  function resetTo(key) {
    clearTimeout(timer.current);
    playRef.current = false; ticking.current = false;
    const init = SCENARIOS[key].init;
    sim.current = { vitals: init, tick: 0, mood: 0 };
    econRef.current = initEconomy(); recentRef.current = [];
    setEconView(econRef.current);
    setVitals(init); setDeltas(null); setTick(0); setFeed([]);
    setMood(0); setHistory([]); setPlaying(false); setStatus("idle"); setError("");
  }
  function onScenario(e) { setScenarioKey(e.target.value); resetTo(e.target.value); }

  async function runTick() {
    if (ticking.current || sim.current.tick >= MAX_TICKS) return;
    ticking.current = true; setStatus("ticking"); setError("");
    const prev = sim.current;
    const nextTick = prev.tick + 1;
    let nv = stepMacro(prev.vitals, scenarioKey, nextTick, prev.mood);
    setVitals(nv); setTick(nextTick);
    try {
      const dzPre = {}; for (const m of INDICATORS) dzPre[m.key] = nv[m.key] - prev.vitals[m.key];
      const { posts, events } = await fetchTurn(nv, dzPre, nextTick, prev.mood, recentRef.current, econRef.current);
      const { ledger, micro } = applyEvents(econRef.current, events, nv, nextTick);
      nv = applyMicroToMacro(nv, micro);
      const dz = {}; for (const m of INDICATORS) dz[m.key] = nv[m.key] - prev.vitals[m.key];

      // Age children who've reached adulthood
      const comingOfAge = [];
      for (const [h, a] of Object.entries(econRef.current.agents)) {
        if (a.status === "child" && a.born_tick !== null && (nextTick - a.born_tick) >= AGING_CYCLES) {
          a.status = "seeking"; a.seeking = true;
          const p = econRef.current.dynamicPersonas[h];
          if (p) comingOfAge.push({ kind: "birth", type: "system", text: `${p.name} came of age and entered the workforce`, tick: nextTick, id: nextTick * 1000 + 200 + comingOfAge.length });
        }
      }

      const avg = posts.reduce((a, p) => a + p.sentiment, 0) / posts.length;
      sim.current = { vitals: nv, tick: nextTick, mood: avg };
      recentRef.current = posts.map((p) => ({ handle: p.handle, post: p.post }));

      const stampedAgents = posts.map((p, i) => {
        const actor = byGroupHandle[p.handle] || personaOf(econRef.current, p.handle);
        return { ...p, tick: nextTick, id: nextTick * 1000 + i, _emoji: actor?.emoji || "👤", _name: actor?.name || p.handle, _group: !!byGroupHandle[p.handle] };
      });
      const stampedSys = [...ledger.map((s, i) => ({ ...s, type: "system", tick: nextTick, id: nextTick * 1000 + 100 + i })), ...comingOfAge];

      setVitals(nv); setDeltas(dz); setMood(avg);
      setEconView({ ...econRef.current, ventures: { ...econRef.current.ventures }, agents: { ...econRef.current.agents }, dynamicPersonas: { ...econRef.current.dynamicPersonas }, totals: { ...econRef.current.totals } });
      setHistory((h) => [...h, { tick: nextTick, mood: avg }].slice(-MAX_TICKS));
      setFeed((f) => [...stampedAgents, ...stampedSys, ...f].slice(0, 260));

      if (nextTick >= MAX_TICKS) { setStatus("done"); playRef.current = false; setPlaying(false); }
      else { setStatus("idle"); if (playRef.current) timer.current = setTimeout(runTick, DELAY[speedRef.current]); }
    } catch (e) {
      setError(e.message || "Something interrupted the simulation.");
      setStatus("error"); playRef.current = false; setPlaying(false);
    } finally { ticking.current = false; }
  }

  function togglePlay() {
    if (status === "done") return;
    if (playing) { playRef.current = false; setPlaying(false); clearTimeout(timer.current); }
    else { playRef.current = true; setPlaying(true); if (!ticking.current) runTick(); }
  }
  function step() { if (!playing && !ticking.current && status !== "done") runTick(); }
  function changeSpeed(s) { setSpeed(s); speedRef.current = s; }

  const sc = SCENARIOS[scenarioKey], mi = sentInfo(mood), busy = status === "ticking";
  const ventures = Object.values(econView.ventures);
  const allPersonas = [...PERSONAS, ...Object.values(econView.dynamicPersonas || {})];
  const seeking = allPersonas.filter((p) => econView.agents[p.handle]?.status === "seeking").length;

  return (
    <div className="pulse-app">
      <style>{CSS}</style>

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">●</span>
          <span className="brand-name">PULSE</span>
          <span className="brand-sub">Sentiment Observatory · Message Bus</span>
        </div>
        <div className="controls">
          <select className="select" value={scenarioKey} onChange={onScenario} disabled={busy} aria-label="Scenario">
            {Object.entries(SCENARIOS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <div className="speed" role="group" aria-label="Speed">
            {["fast", "normal", "slow"].map((s) => <button key={s} className={"speed-btn" + (speed === s ? " on" : "")} onClick={() => changeSpeed(s)}>{s}</button>)}
          </div>
          <button className="btn primary" onClick={togglePlay} disabled={status === "done"}>{playing ? "⏸ Pause" : busy ? "● Running" : "▷ Run"}</button>
          <button className="btn" onClick={step} disabled={playing || busy || status === "done"}>Step</button>
          <button className="btn ghost" onClick={() => resetTo(scenarioKey)}>Reset</button>
        </div>
      </header>

      <div className="scenario-strip">
        <span className="cycle-badge">Cycle {String(tick).padStart(2, "0")}<span className="of">/ {MAX_TICKS}</span></span>
        <span className="cycle-when">{cycleLabel(tick)}</span>
        <span className="scenario-blurb">{sc.blurb}</span>
        {busy && <span className="working"><span className="dot pulsing" /> the world is deciding…</span>}
      </div>

      <main className="grid">
        <aside className="rail">
          <div className="rail-section-title">Macro vitals</div>
          <div className="vitals">
            {INDICATORS.map((m) => <Vital key={m.key} m={m} value={vitals[m.key]} delta={deltas ? deltas[m.key] : 0} />)}
          </div>

          <div className="mood-panel">
            <div className="rail-section-title">Public mood</div>
            <PulseLine history={history} mood={mood} />
            <div className="mood-readout">
              <span className="mood-word" style={{ color: mi.color }}>{tick === 0 ? "—" : mi.label}</span>
              <span className="mood-val" style={{ color: mi.color }}>{tick === 0 ? "" : mood.toFixed(2)}</span>
            </div>
          </div>

          <div className="econ-stats">
            <div className="estat"><span className="estat-n">{ventures.length}</span><span className="estat-l">ventures</span></div>
            <div className="estat"><span className="estat-n" style={{ color: "#2EA66F" }}>{econView.totals.hires}</span><span className="estat-l">hires</span></div>
            <div className="estat"><span className="estat-n" style={{ color: "#3FB8A0" }}>{econView.totals.deals}</span><span className="estat-l">deals</span></div>
            <div className="estat"><span className="estat-n" style={{ color: seeking ? "#E8A13A" : "#8A8F9E" }}>{seeking}</span><span className="estat-l">seeking</span></div>
          </div>

          <div className="rail-section-title mt">Ventures</div>
          <div className="ventures">{ventures.length ? ventures.map((v) => <VentureCard key={v.id} v={v} econView={econView} />) : <div className="muted">No active ventures.</div>}</div>

          <div className="rail-section-title mt">Who's who</div>
          <div className="roster">
            {allPersonas.map((p) => {
              const a = econView.agents[p.handle]; if (!a) return null;
              const sm = STATUS_META[a.status] || { label: a.status, color: "#8A8F9E" };
              const emp = a.employer && econView.ventures[a.employer] ? " · " + econView.ventures[a.employer].name : "";
              const married = a.married_to ? " 💍" : "";
              const deceased = a.deceased;
              return (
                <div className="rmember" key={p.handle} style={deceased ? { opacity: 0.4 } : {}}>
                  <span className="r-emoji">{deceased ? "✝" : p.emoji}</span>
                  <span className="r-name">{p.name.split(" ")[0]}</span>
                  <span className="r-status" style={{ color: sm.color }}>
                    {sm.label}{emp}{married}
                    {deceased && <span style={{ color: "#4A4A6A", marginLeft: 4 }}>({a.deceased.cause})</span>}
                    {a.status === "child" && <span style={{ color: "#3FB8A0", marginLeft: 4 }}>born C{a.born_tick}</span>}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="rail-section-title mt">Institutions</div>
          <div className="roster">
            {GROUPS.map((g) => {
              const gkm = GROUP_KIND_META[g.kind] || { label: g.kind, color: "#8A8F9E" };
              const v = Object.values(econView.ventures).find((vv) => vv.founder === g.handle);
              return (
                <div className="rmember" key={g.handle}>
                  <span className="r-emoji">{g.emoji}</span>
                  <span className="r-name">{g.name.split(" ")[0]}</span>
                  <span className="r-status" style={{ color: gkm.color }}>{gkm.label}{v ? " · " + v.name : ""}</span>
                </div>
              );
            })}
          </div>

          <div className="legend">Macro engine is deterministic; the cast's words, their actions, and institutional decisions — every hire, rate change, bailout, birth, and death — are decided live by Claude. The engine only keeps the books.</div>
        </aside>

        <section className="feed-wrap">
          <div className="feed-head"><span className="feed-title"># the feed</span><span className="feed-count">{feed.length} posts</span></div>

          {error && <div className="banner error">{error} <button className="retry" onClick={step}>Try this cycle again</button></div>}
          {status === "done" && <div className="banner done">Simulation complete — {MAX_TICKS} cycles. {econView.totals.launches} ventures founded · {econView.totals.hires} hires · {econView.totals.deals} deals · {econView.totals.layoffs} layoffs · {econView.totals.closes} closures · {econView.totals.marriages} marriages · {econView.totals.births} births · {econView.totals.deaths} deaths · {econView.totals.purchases} major purchases. Reset to run again.</div>}

          {feed.length === 0 && status !== "ticking" ? (
            <div className="empty">
              <div className="empty-mark">◔</div>
              <h2>An economy that decides for itself.</h2>
              <p>Pick a scenario and press <b>Run</b>. Each cycle the constants move and the model decides what its people do about it — founding businesses, hiring, dealing, laying off, shutting down — and posts it all here. Those choices feed back into the economy.</p>
            </div>
          ) : (
            <div className="feed">
              {busy && feed.length === 0 && <div className="skeleton">Eight people are deciding their next move…</div>}
              {feed.map((p) => <Post key={p.id} p={p} />)}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

/* ---------- styles ---------- */
const CSS = `
.pulse-app{
  --ink:#0C1024; --ink2:#141A33; --ink3:#1B2342; --line:#2A335A;
  --text:#E9ECF5; --dim:#9AA3C4; --amber:#E8A13A; --paper:#F4F1E9; --paperEdge:#E7E1D3;
  font-family:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; color:var(--text);
  background:radial-gradient(1200px 500px at 80% -10%,rgba(232,161,58,.10),transparent 60%),
    radial-gradient(900px 600px at -10% 110%,rgba(63,184,160,.08),transparent 60%),var(--ink);
  min-height:100vh;width:100%;
}
.pulse-app *{box-sizing:border-box}
.vital-val,.vital-delta,.cycle-badge,.mood-val,.post-cycle,.brand-name,.feed-count,.estat-n,.sys-text,.sys-cycle{
  font-family:'SF Mono',ui-monospace,'Cascadia Code',Menlo,Consolas,monospace}

.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px;
  border-bottom:1px solid var(--line);flex-wrap:wrap;background:linear-gradient(180deg,rgba(20,26,51,.9),rgba(12,16,36,.4));
  position:sticky;top:0;z-index:5;backdrop-filter:blur(6px)}
.brand{display:flex;align-items:baseline;gap:10px}
.brand-mark{color:#3FB8A0;font-size:12px;transform:translateY(-1px);animation:beat 1.8s ease-in-out infinite}
.brand-name{font-size:20px;font-weight:700;letter-spacing:.28em}
.brand-sub{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.select{background:var(--ink2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:13px;font-weight:600;cursor:pointer;outline:none}
.select:focus-visible{border-color:var(--amber)}
.speed{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.speed-btn{background:transparent;color:var(--dim);border:none;padding:7px 9px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;cursor:pointer}
.speed-btn.on{background:var(--ink3);color:var(--text)}
.btn{background:var(--ink2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;transition:transform .08s,border-color .15s}
.btn:hover:not(:disabled){border-color:#3b4673;transform:translateY(-1px)}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn.primary{background:linear-gradient(180deg,#E8A13A,#cf8a26);color:#1a1205;border-color:#cf8a26}
.btn.ghost{background:transparent}
.btn:focus-visible,.speed-btn:focus-visible,.retry:focus-visible{outline:2px solid var(--amber);outline-offset:2px}

.scenario-strip{display:flex;align-items:center;gap:14px;padding:10px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap;background:rgba(12,16,36,.5)}
.cycle-badge{font-size:14px;font-weight:700;color:var(--amber)}
.cycle-badge .of{color:var(--dim);font-size:11px;margin-left:4px}
.cycle-when{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.1em}
.scenario-blurb{font-size:13px;color:var(--dim);flex:1;min-width:200px}
.working{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--amber)}

.grid{display:grid;grid-template-columns:320px 1fr}
.rail{padding:18px 16px 28px;border-right:1px solid var(--line);position:sticky;top:64px;max-height:calc(100vh - 64px);overflow:auto}
.rail-section-title{font-size:11px;text-transform:uppercase;letter-spacing:.16em;color:var(--dim);margin:0 0 10px}
.rail-section-title.mt{margin-top:20px}
.muted{font-size:12px;color:var(--dim)}
.vitals{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.vital{background:var(--ink2);border:1px solid var(--line);border-radius:10px;padding:9px 10px}
.vital-label{font-size:10.5px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;white-space:nowrap}
.vital-row{display:flex;align-items:baseline;justify-content:space-between;gap:6px}
.vital-val{font-size:18px;font-weight:700}
.vital-unit{font-size:11px;color:var(--dim);margin-left:1px}
.vital-delta{font-size:11px;font-weight:600;white-space:nowrap}

.mood-panel{margin-top:20px;background:var(--ink2);border:1px solid var(--line);border-radius:12px;padding:14px}
.pulse-svg{width:100%;height:64px;display:block;margin:2px 0 6px}
.mood-readout{display:flex;align-items:baseline;justify-content:space-between}
.mood-word{font-size:17px;font-weight:700}.mood-val{font-size:15px;font-weight:700}

.econ-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:16px}
.estat{background:var(--ink2);border:1px solid var(--line);border-radius:10px;padding:8px 4px;text-align:center}
.estat-n{display:block;font-size:18px;font-weight:700;color:var(--text)}
.estat-l{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}

.ventures{display:flex;flex-direction:column;gap:8px}
.venture{background:var(--ink2);border:1px solid var(--line);border-radius:10px;padding:9px 11px}
.venture-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.venture-name{font-size:13px;font-weight:700}
.venture-meta{display:flex;gap:10px;margin-top:5px;font-size:11px;color:var(--dim)}
.venture-meta .sector{color:#8B6CE6;text-transform:capitalize}

.roster{display:flex;flex-direction:column;gap:5px}
.rmember{display:flex;align-items:center;gap:8px;font-size:12px}
.r-emoji{width:18px;text-align:center}
.r-name{font-weight:600;width:58px;flex:none}
.r-status{color:var(--dim);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.legend{margin-top:18px;font-size:11px;line-height:1.6;color:var(--dim);border-top:1px solid var(--line);padding-top:12px}

.feed-wrap{padding:18px 20px 60px;min-height:60vh}
.feed-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px}
.feed-title{font-size:15px;font-weight:700}.feed-count{font-size:12px;color:var(--dim)}
.feed{display:flex;flex-direction:column;gap:10px;max-width:680px}

.post{background:var(--paper);color:#23211c;border:1px solid var(--paperEdge);border-left:4px solid #8A8F9E;border-radius:12px;padding:13px 15px;box-shadow:0 6px 20px rgba(0,0,0,.18);animation:slideIn .35s ease both}
.post-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.post-avatar{width:24px;height:24px;border-radius:7px;display:grid;place-items:center;font-size:14px;background:#1E2747}
.post-name{font-weight:700;font-size:14px;color:#1c1a15}
.post-handle{font-size:12px;color:#7c7768}
.act-chip{font-size:10.5px;font-weight:700;color:#6b5a2e;background:#efe6cf;border:1px solid #e1d4b2;border-radius:999px;padding:2px 9px}
.post-cycle{font-size:11px;color:#a39d8c;margin-left:auto}
.post-body{margin:8px 0 9px;font-size:14.5px;line-height:1.5;color:#2b2820}
.post-foot{display:flex;align-items:center;justify-content:space-between;gap:10px}
.post-mood{font-size:12px;font-weight:700;display:flex;align-items:center;gap:6px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.dot.pulsing{animation:beat 1.2s ease-in-out infinite;background:var(--amber)}

.group-post{background:#0e1229;border-color:rgba(100,110,170,.35)}
.inst-chip{font-size:10.5px;font-weight:700;border:1px solid;border-radius:999px;padding:2px 9px}
.sys-post{display:flex;align-items:center;gap:9px;background:rgba(20,26,51,.6);border:1px dashed var(--line);border-left:3px solid #8A8F9E;border-radius:9px;padding:8px 12px;max-width:680px;animation:slideIn .35s ease both}
.sys-ic{font-size:14px}
.sys-text{font-size:12.5px;color:var(--text);flex:1}
.sys-cycle{font-size:11px;color:var(--dim)}

.banner{border-radius:10px;padding:11px 14px;font-size:13px;margin-bottom:14px;max-width:680px}
.banner.error{background:rgba(192,57,43,.14);border:1px solid #C0392B;color:#f3b4ac}
.banner.done{background:rgba(63,184,160,.12);border:1px solid #2EA66F;color:#aef0db;line-height:1.6}
.retry{background:transparent;border:1px solid #C0392B;color:#f3b4ac;border-radius:7px;padding:3px 9px;font-size:12px;margin-left:8px;cursor:pointer}

.empty{max-width:580px;margin:40px auto;text-align:center;color:var(--dim)}
.empty-mark{font-size:54px;color:var(--amber);opacity:.8;margin-bottom:6px}
.empty h2{color:var(--text);font-size:22px;margin:6px 0 12px;line-height:1.25}
.empty p{font-size:14px;line-height:1.7}.empty b{color:var(--amber)}
.skeleton{color:var(--dim);font-size:14px;padding:20px;text-align:center}

@keyframes slideIn{from{opacity:0;transform:translateY(-7px)}to{opacity:1;transform:none}}
@keyframes beat{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.5);opacity:.55}}

@media (max-width:860px){
  .grid{grid-template-columns:1fr}
  .rail{position:static;border-right:none;border-bottom:1px solid var(--line);max-height:none}
  .vitals{grid-template-columns:repeat(3,1fr)}
  .feed,.banner,.post,.sys-post{max-width:none}
}
@media (max-width:480px){.vitals{grid-template-columns:1fr 1fr}.brand-sub{display:none}}
@media (prefers-reduced-motion:reduce){*{animation:none !important}}
`;
