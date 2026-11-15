// Chores on the phone: today's chores, gym days, quick add. Same OneDrive files as the PC app.
"use strict";

const L = Logic;
const G = L.GYM;
const GYM_DEFAULTS = { goal: 3, time: "17:00", minutes: 75, prefer: [], done: [], picked: [], skipped: [],
  splits: L.ROUTINE, sessions: {}, weights: {}, weigh_every: 14 };
const DEMO = new URLSearchParams(location.search).has("demo") && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const Store = DEMO ? demoStore() : Cloud;

const S = { tab: "today", tasks: [], gym: { ...GYM_DEFAULTS }, busy: {}, loaded: null, busyNote: "", undo: null,
  shop: { items: [], rotation: [] } };
const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- helpers
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.4"/><path d="M20 4v7h-7"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  bag: '<path d="M5 8.5h14l-1 12H6z"/><path d="M8.5 8.5a3.5 3.5 0 0 1 7 0"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/>',
  dinner: '<path d="M6 3v6a3 3 0 0 0 6 0V3M9 3v18"/><path d="M17 21V3c-2 2-3 4.5-3 8.5h3"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.6 2.2c-.8.5-1.2 1-1.2 1.8M12 17h.01"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M5 20c.8-3.4 3.6-5 7-5s6.2 1.6 7 5"/>',
  gym: '<path d="M7.5 12h9M2.5 9.5v5M21.5 9.5v5"/><rect x="4.5" y="6.5" width="3" height="11" rx="1.2"/><rect x="16.5" y="6.5" width="3" height="11" rx="1.2"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2.5"/><path d="M3 10h18M8 2v4M16 2v4"/>',
  scale: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 9.5a5 5 0 0 1 8 0l-2.2 2.5h-3.6z"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
function icon(name) {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "i"); s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name];
  return s;
}
const bubble = (name) => el("span", { class: "bubble" }, icon(name));
const empty = (name, text) => el("div", { class: "empty" }, bubble(name), el("p", {}, text));
const calm = window.matchMedia("(prefers-reduced-motion: reduce)");

const today = () => L.localToday();
function dayName(iso) {
  const d = L.daysBetween(today(), iso);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  if (d === -1) return "Yesterday";
  const [, m, day] = iso.split("-").map(Number);
  return `${L.NAMES[L.weekday(iso)]} ${day} ${L.MONTHS[m - 1].slice(0, 3)}`;
}
function fmtMinutes(m) {
  if (!m) return "";
  const h = Math.floor(m / 60), mm = m % 60;
  return h && mm ? `${h}h ${mm}m` : h ? `${h}h` : `${mm}m`;
}
function toast(text, undo) {
  const t = $("#toast");
  t.replaceChildren(el("span", {}, text));
  if (undo) t.append(el("button", { onclick: () => { hideToast(); undo(); } }, "Undo"));
  clearTimeout(toast.timer); clearTimeout(toast.gone);
  t.classList.remove("out");
  t.hidden = true; void t.offsetWidth; t.hidden = false;      // replay the entrance when a new message replaces an old one
  toast.timer = setTimeout(hideToast, 5000);
}
function hideToast() {
  const t = $("#toast");
  if (t.hidden) return;
  clearTimeout(toast.timer); clearTimeout(toast.gone);
  t.classList.add("out");
  toast.gone = setTimeout(() => { t.hidden = true; t.classList.remove("out"); }, calm.matches ? 0 : 200);
}
// Saving takes a OneDrive round trip; only dim the page if it is slow, and spin the refresh button meanwhile.
let busyTimer = null;
function busy(on) {
  clearTimeout(busyTimer);
  document.body.classList.toggle("working", on);
  if (on) busyTimer = setTimeout(() => document.body.classList.add("busy"), 600);
  else document.body.classList.remove("busy");
}

async function guard(fn) {
  busy(true);
  try { await fn(); } catch (e) { toast(e.message || String(e)); console.error(e); } finally { busy(false); }
}

// ---------------------------------------------------------------- data
async function load() {
  const [tasks, gym, phone, shop] = await Promise.all([
    Store.readJSON("tasks.json", { version: 1, tasks: [] }),
    Store.readJSON("gym.json", { ...GYM_DEFAULTS }),
    Store.readJSON("phone.json", { busy: {} }),
    Store.readJSON("shopping.json", { items: [], rotation: [] }),
  ]);
  S.shop = { items: [], rotation: [], ...shop.data };
  S.tasks = tasks.data.tasks || [];
  S.gym = { ...GYM_DEFAULTS, ...gym.data };
  S.busy = phone.data.busy || {};
  S.days = phone.data.days || {};
  S.weather = phone.data.weather || null;
  S.generated = phone.data.generated || null;
  const age = S.generated ? (Date.now() - new Date(S.generated).getTime()) / 3.6e6 : Infinity;
  if (age > 3) S.weather = null;            // old "now" weather would mislead; the day's high/low still shows
  S.busyNote = phone.data.generated ? `Calendar from your PC, ${dayName(phone.data.generated.slice(0, 10)).toLowerCase()} ${phone.data.generated.slice(11, 16)}` : "";
  S.loaded = new Date();
  render();
}

async function changeTask(id, fn, text) {
  let before = null;
  await guard(async () => {
    const { data } = await Store.update("tasks.json", { version: 1, tasks: [] }, (d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (!t) throw new Error("That chore was changed on another device. Tap ↻ to refresh.");
      before = JSON.parse(JSON.stringify(t));
      fn(t);
    });
    S.tasks = data.tasks;
    render();
    toast(text, () => guard(async () => {
      const { data: d2 } = await Store.update("tasks.json", { version: 1, tasks: [] }, (d) => {
        const i = d.tasks.findIndex((x) => x.id === id);
        if (i >= 0) d.tasks[i] = before;
      });
      S.tasks = d2.tasks;
      render();
    }));
  });
}

async function changeGym(fn, text) {
  await guard(async () => {
    const { data } = await Store.update("gym.json", { ...GYM_DEFAULTS }, (g) => {
      for (const k of Object.keys(GYM_DEFAULTS)) if (!(k in g)) g[k] = JSON.parse(JSON.stringify(GYM_DEFAULTS[k]));
      fn(g);
    });
    S.gym = { ...GYM_DEFAULTS, ...data };
    render();
    if (text) toast(text);
  });
}

const gymBusy = (iso) => S.busy[iso] || null;
const gymWeek = (monday) => L.planWeek(S.gym, monday, today(), gymBusy);
const cap1 = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const pill = (kind, text) => el("span", { class: `pill ${kind}` }, text);
function sessionLabel(groups) {
  const set = new Set(groups);
  for (const sp of S.gym.splits) if (sp.groups.length === set.size && sp.groups.every((g) => set.has(g))) return sp.name;
  return cap1(groups.join(", "));
}
// {iso: what to train / what was trained} for done and planned gym days from today over n days
function gymLabels(n = 14) {
  const t0 = today(), out = {}, planned = [];
  for (let i = 0; i < n; i++) {
    const x = L.addDays(t0, i), e = gymWeek(L.mondayOf(x))[L.weekday(x)];
    if (e.status === G.DONE && S.gym.sessions[x]) out[x] = sessionLabel(S.gym.sessions[x]);
    if (e.status === G.PLANNED) planned.push(x);
  }
  for (const [x, i] of Object.entries(L.planSplits(S.gym, planned))) if (i >= 0) out[x] = S.gym.splits[i].name;
  for (const [x, gs] of Object.entries(S.gym.sessions)) if (!out[x]) out[x] = sessionLabel(gs);
  return out;
}

// ---------------------------------------------------------------- bottom sheets
function sheet(title, sub, ...body) {
  const vv = window.visualViewport;
  const fit = () => { wrap.style.top = `${vv.offsetTop}px`; wrap.style.height = `${vv.height}px`; };   // stay above the keyboard
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => {
    if (wrap.classList.contains("closing")) return;
    wrap.classList.add("closing");
    document.documentElement.classList.remove("locked");
    document.removeEventListener("keydown", onKey);
    if (vv) { vv.removeEventListener("resize", fit); vv.removeEventListener("scroll", fit); }
    setTimeout(() => wrap.remove(), calm.matches ? 0 : 220);
  };
  const wrap = el("div", { class: "sheet-wrap", onclick: (e) => { if (e.target === wrap) close(); } },
    el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
      el("div", { class: "grab" }), el("h2", {}, title), sub ? el("p", { class: "sub" }, sub) : null, ...body));
  document.body.append(wrap);
  document.documentElement.classList.add("locked");
  document.addEventListener("keydown", onKey);
  if (vv) { fit(); vv.addEventListener("resize", fit); vv.addEventListener("scroll", fit); }
  return close;
}

function sessionSheet(day) {
  const sugg = L.nextSplit(S.gym, day);
  const picked = new Set(S.gym.sessions[day] || []);
  let close;
  const save = (groups, text) => { close(); changeGym((s) => L.gymActions.logSession(s, day, groups), text); };
  const splits = el("div", { class: "split-grid" }, ...S.gym.splits.map((sp, i) =>
    el("button", { class: i === sugg ? "primary" : "", onclick: () => save(sp.groups, `Logged: ${sp.name}.`) },
      sp.name, i === sugg ? el("small", {}, "next up") : null)));
  const chips = el("div", { class: "tog-grid" }, ...L.GROUPS.map((g) => {
    const b = el("button", { class: `tog ${picked.has(g) ? "on" : ""}`, "aria-pressed": String(picked.has(g)), onclick: () => {
      picked.has(g) ? picked.delete(g) : picked.add(g);
      b.classList.toggle("on", picked.has(g)); b.setAttribute("aria-pressed", String(picked.has(g))); } }, cap1(g));
    return b;
  }));
  close = sheet("What did you train?", `${dayName(day)} · tap your session, or pick groups for a mixed day`,
    splits, el("h3", {}, "Or pick muscle groups"), chips,
    el("div", { class: "row end" },
      el("button", { class: "ghost", onclick: () => close() }, "Cancel"),
      el("button", { class: "primary", onclick: () => {
        if (!picked.size) return toast("Pick at least one muscle group.");
        const gs = L.GROUPS.filter((g) => picked.has(g));
        save(gs, `Logged: ${sessionLabel(gs)}.`);
      } }, "Save groups")));
}

function weighSheet() {
  const keys = Object.keys(S.gym.weights).sort(), last = keys.length ? S.gym.weights[keys[keys.length - 1]] : null;
  const input = el("input", { type: "text", inputmode: "decimal", placeholder: last ? last.toFixed(1) : "80.0", "aria-label": "Weight in kilograms" });
  let close;
  const save = () => {
    const m = /^\s*(\d{2,3})(?:[.,](\d))?\s*$/.exec(input.value);
    if (!m) return toast("Type your weight like 82.4.");
    const kg = Number(`${m[1]}.${m[2] || 0}`);
    close();
    changeGym((s) => L.gymActions.logWeight(s, today(), kg), `Weight saved: ${kg.toFixed(1)} kg.`);
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  close = sheet("Weigh in", last ? `Last time: ${last.toFixed(1)} kg, ${dayName(keys[keys.length - 1]).toLowerCase()}` : "Same time of day each time gives fair numbers.",
    el("div", { class: "field kg" }, input, el("span", { class: "unit" }, "kg")),
    el("div", { class: "row end" }, el("button", { class: "ghost", onclick: () => close() }, "Cancel"),
      el("button", { class: "primary", onclick: save }, "Save")));
  setTimeout(() => input.focus(), 50);
}

// ---------------------------------------------------------------- views
function header(title, sub, over) {
  return el("header", {},
    el("div", { class: "grow" }, over ? el("p", { class: "over caps" }, over) : null, el("h1", {}, title), sub ? el("p", { class: "sub" }, sub) : null),
    el("button", { class: "icon", "aria-label": "Refresh", onclick: () => guard(load) }, icon("refresh")));
}
const section = (title, extra) => el("h2", { class: "sec" }, title, extra || null);

function taskSub(t) {
  const bits = [];
  const late = L.daysBetween(t.next_due, today());
  if (late > 0) bits.push(late === 1 ? "1 day late" : `${late} days late`);
  bits.push(L.describeRule(t.rule));
  if (t.minutes) bits.push("about " + fmtMinutes(t.minutes));
  return bits.join(" · ");
}

const WX = { w_sun: "☀️", w_partly: "⛅", w_cloud: "☁️", w_rain: "🌧️", w_snow: "🌨️", w_thunder: "⛈️", w_fog: "🌫️", w_wind: "💨" };
const DINNER_AT = "19:00";
// Same rule as the PC: still at work at dinner time = evening shift.
function shiftKind(a, b) {
  const evening = a < DINNER_AT && b >= DINNER_AT || b < a;
  return !evening ? "lunch shift" : a < "14:00" ? "double shift" : "evening shift";
}
const nowHM = () => { const n = new Date(); return `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`; };
const splitTime = (line) => { const m = /^(\d{1,2}[:.]\d{2})\s+(.*)$/.exec(line); return m ? [m[1].replace(".", ":").padStart(5, "0"), m[2]] : [null, line]; };

function viewToday() {
  const t0 = today();
  const due = S.tasks.filter((t) => t.active && t.next_due <= t0).sort((a, b) => a.next_due.localeCompare(b.next_due));
  const late = due.filter((t) => t.next_due < t0).length;
  const [, m, d] = t0.split("-").map(Number);
  const w = S.weather, wd = (S.days[t0] || {}).weather;
  const wxText = w ? `${WX[w.icon] || ""} ${w.temp}° ${w.text}` : wd ? `${WX[wd.icon] || ""} ${wd.max}° / ${wd.min}°` : "";
  const out = [header(`${d} ${L.MONTHS[m - 1]}`, wxText, L.LONG[L.weekday(t0)])];
  out.push(timeline(t0));

  out.push(section("To do", due.length ? el("span", { class: `count ${late ? "late" : ""}` }, String(due.length)) : null));
  const list = el("section", { class: "card" });
  if (!due.length) list.append(empty("check", "Nothing waiting. Enjoy your day."));
  for (const t of due) {
    const recurring = t.rule.type !== "once";
    list.append(el("div", { class: "task", "data-key": `task:${t.id}`, "data-exit": "" },
      el("div", { class: "title" }, t.name), el("div", { class: `sub ${t.next_due < t0 ? "late" : ""}` }, taskSub(t)),
      el("div", { class: "task-actions" },
        el("button", { class: "ghost sm", onclick: () => changeTask(t.id, (x) => L.snoozeDays(x, 1, today()), `“${t.name}” moved to tomorrow.`) }, "Tomorrow"),
        recurring ? el("button", { class: "ghost sm", onclick: () => changeTask(t.id, (x) => L.complete(x, true, today()), `Skipped “${t.name}” this time.`) }, "Skip") : null,
        el("button", { class: "primary sm", onclick: () => changeTask(t.id, (x) => L.complete(x, false, today()), `Done: ${t.name}`) }, icon("check"), "Done"))));
  }
  out.push(list);
  out.push(section("This week"));
  out.push(thisWeek(t0));
  return out;
}

// Today as a timeline: partner's shift (leaves / home), gym, dinner, your calendar, in time order.
const TL_ICON = { partner: "person", gym: "gym", dinner: "dinner", event: "calendar" };
function timeline(t0) {
  const info = S.days[t0];
  const box = el("section", { class: "card tl" });
  if (!info) {
    box.append(empty("clock", "Open the PC app once today to see shifts and plans here."));
    return box;
  }
  const ev = [];                                   // {at, title, sub, kind, action, done}
  const shifts = info.partner || [];
  const away = shifts.some((x) => x[2]);
  for (const [a, b] of shifts) {
    ev.push({ at: a, title: `Partner ${shiftKind(a, b)}`, sub: `until ${b}`, kind: "partner" });
    ev.push({ at: b, title: "Partner home", kind: "partner end" });
  }
  const g = gymWeek(L.mondayOf(t0))[L.weekday(t0)];
  if (g.status === G.PLANNED || g.status === G.DONE) {
    const n = L.weekCount(S.gym, L.mondayOf(t0));
    const done = g.status === G.DONE;
    const what = gymLabels(1)[t0];
    ev.push({ at: S.gym.time, title: "Gym" + (what ? ` · ${what}` : ""), sub: `${done ? "Done · " : ""}${n} of ${S.gym.goal} this week`, kind: "gym", done,
      action: done
        ? el("button", { class: "ghost sm", onclick: () => changeGym((s) => L.gymActions.markDone(s, t0, false), "Visit removed.") }, "Undo")
        : el("button", { class: "primary sm", onclick: () => sessionSheet(t0) }, "Done") });
  }
  if (info.dinner || away) {
    ev.push({ at: DINNER_AT, title: info.dinner ? `Dinner: ${info.dinner}` : "Dinner", sub: away ? "Eating alone tonight" : "", kind: "dinner" });
  }
  const allDay = [];
  for (const line of info.events || []) {
    const [at, text] = splitTime(line);
    if (at) ev.push({ at, title: text, kind: "event" }); else allDay.push(text);
  }
  ev.sort((x, y) => x.at.localeCompare(y.at));

  let status;
  if (shifts.length) status = away ? ["moon", `Partner on ${shiftKind(shifts[0][0], shifts[shifts.length - 1][1])}`, "away"] : ["dinner", "Partner on lunch shift, home for dinner", "work"];
  else if (info.partner_known) status = ["home", "Partner is off today", "home"];
  else status = ["help", "Partner's schedule isn't out yet", "unknown"];
  box.append(el("div", { class: `well tl-status ${status[2]}` }, bubble(status[0]), el("div", { class: "title grow" }, status[1])));
  if (L.weighStatus(S.gym, t0).due) box.append(el("div", { class: "well tl-weigh", "data-key": "weigh-due" }, bubble("scale"),
    el("div", { class: "grow" }, el("div", { class: "title" }, "Weigh-in day"), el("div", { class: "sub" }, `Every ${S.gym.weigh_every} days`)),
    el("button", { class: "primary sm", onclick: weighSheet }, "Log")));
  for (const t of allDay) box.append(el("div", { class: "tl-allday" }, icon("calendar"), "All day · " + t));

  if (!ev.length) {
    box.append(el("p", { class: "empty plain", style: "margin-top:14px" }, "Nothing planned today."));
    return box;
  }
  const now = nowHM();
  let nowShown = false;
  const nowRow = () => el("div", { class: "tl-now", "aria-label": `Now, ${now}` },
    el("div", { class: "tl-time" }, now), el("div", { class: "tl-node" }, el("span", { class: "dot" })), el("div", { class: "line" }));
  const rail = el("div", { class: "tl-rail" });
  ev.forEach((e, i) => {
    if (!nowShown && e.at > now) { rail.append(nowRow()); nowShown = true; }
    const end = e.kind.includes("end");
    rail.append(el("div", { class: `tl-item ${e.kind} ${e.at <= now ? "past" : ""} ${e.done ? "done" : ""}`, "data-key": `tl:${i}` },
      el("div", { class: "tl-time" }, e.at),
      el("div", { class: "tl-node" }, el("span", { class: "bubble" }, end ? null : icon(e.done ? "check" : TL_ICON[e.kind]))),
      el("div", { class: "grow" }, el("div", { class: "title" }, e.title), e.sub ? el("div", { class: "sub" }, e.sub) : null),
      e.action || null));
  });
  if (!nowShown) rail.append(nowRow());
  box.append(rail);
  box.append(updatedNote());
  return box;
}

// When the PC last sent shifts, calendar and weather; flagged when that is more than a few hours ago.
function updatedNote() {
  if (!S.generated) return null;
  const g = new Date(S.generated), hours = (Date.now() - g.getTime()) / 3.6e6;
  const when = `${dayName(S.generated.slice(0, 10)).toLowerCase()} ${S.generated.slice(11, 16)}`;
  return el("p", { class: `updated ${hours > 6 ? "late" : ""}` },
    hours > 6 ? `From your PC ${when}: may be out of date. Open the PC app to update.` : `Updated from your PC ${when}`);
}

// The next seven days, one compact row each.
function thisWeek(t0) {
  const end = L.addDays(t0, 7);
  const byDay = {};
  for (const t of S.tasks) for (const x of L.occurrences(t, L.addDays(t0, 1), end)) (byDay[x] = byDay[x] || []).push(t.name);
  const box = el("section", { class: "card" });
  const labels = gymLabels(8);
  for (let i = 1; i <= 7; i++) {
    const x = L.addDays(t0, i);
    const gd = gymWeek(L.mondayOf(x))[L.weekday(x)];
    const info = S.days[x] || {};
    const bits = [];
    for (const [a, b, eve] of info.partner || []) bits.push(el("span", { class: "partner" }, `Partner ${shiftKind(a, b)} ${a}–${b}${eve ? " 🌙" : ""}`));
    if (!(info.partner || []).length && info.partner_known) bits.push(el("span", { class: "home" }, "Partner off"));
    if (gd.status === G.PLANNED || gd.status === G.DONE) bits.push(el("span", { class: "gym" }, `Gym ${labels[x] || S.gym.time}`));
    for (const e of info.events || []) bits.push(el("span", { class: "event" }, e));
    if (info.dinner) bits.push(el("span", { class: "dinner" }, info.dinner));
    const chores = byDay[x] || [];
    const wx = info.weather;
    box.append(el("div", { class: "wk", "data-key": `wk:${x}` },
      el("div", { class: "wk-day" }, el("b", {}, L.NAMES[L.weekday(x)]), el("span", {}, `${Number(x.slice(8))}`)),
      el("div", { class: "grow" },
        bits.length ? el("div", { class: "wk-line" }, ...bits) : el("div", { class: "wk-line muted" }, "Nothing planned"),
        chores.length ? el("div", { class: "wk-chores" }, chores.join(", ")) : null),
      wx ? el("div", { class: "wk-wx" }, `${WX[wx.icon] || ""} ${wx.max}°`) : null));
  }
  return box;
}

const STATUS = {
  [G.DONE]: ["Done", "ok"], [G.PLANNED]: [null, "accent"], [G.MISSED]: ["Missed", "late"],
  [G.BUSY]: ["Busy", "muted"], [G.SKIPPED]: ["Not this day", "muted"], [G.REST]: ["Rest", "faint"],
};

function viewGym() {
  const t0 = today();
  const mon = L.mondayOf(t0);
  const n = L.weekCount(S.gym, mon);
  const st = L.streak(S.gym, t0);
  const out = [header("Gym", `${n} of ${S.gym.goal} this week${st ? ` · ${st} week${st === 1 ? "" : "s"} in a row` : ""}`)];
  const labels = gymLabels(14);

  // next session + muscle groups
  const doneToday = S.gym.sessions[t0];
  const upcoming = Object.keys(labels).filter((x) => x >= t0).sort();
  const nextDay = doneToday ? t0 : upcoming.find((x) => !S.gym.sessions[x]);
  const nextName = doneToday ? sessionLabel(doneToday) : nextDay ? labels[nextDay] : (S.gym.splits[L.nextSplit(S.gym, t0)] || {}).name;
  const groupsOf = doneToday || ((S.gym.splits.find((sp) => sp.name === nextName) || {}).groups || []);
  const since = L.groupDays(S.gym, t0);
  out.push(el("section", { class: "card next" },
    el("div", { class: "next-top", "data-key": "next" },
      el("div", { class: "grow" },
        el("div", { class: "caps" }, doneToday ? "Trained today" : "Next session"),
        el("div", { class: "big" }, nextName || "—"),
        el("div", { class: "sub" }, doneToday ? "Nice work." : nextDay ? `${dayName(nextDay)} at ${S.gym.time}` : "Next time you go")),
      ring(n, S.gym.goal)),
    groupsOf.length ? el("div", { class: "pills" }, ...groupsOf.map((g) => pill("gym", cap1(g)))) : null,
    !doneToday ? el("button", { class: "primary wide", onclick: () => sessionSheet(t0) }, "Log today's session") : null));

  out.push(section("Last trained"));
  out.push(el("section", { class: "card" }, el("div", { class: "groups-grid" }, ...L.GROUPS.map((g) => {
    const d = since[g], cls = d === null ? "never" : d <= 4 ? "fresh" : d <= 8 ? "soon" : "due";
    return el("div", { class: `grp ${cls}`, "data-key": `grp:${g}` }, el("b", {}, cap1(g)),
      el("span", {}, d === null ? "not yet" : d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days`));
  }))));

  for (const [offset, title] of [[0, "This week"], [7, "Next week"]]) {
    const plan = gymWeek(L.addDays(mon, offset));
    out.push(section(title));
    const box = el("section", { class: "card" });
    for (const e of plan) {
      const [label, cls] = STATUS[e.status];
      const x = e.date;
      let btn;
      if (e.status === G.DONE) btn = ["Undo", "ghost", () => changeGym((s) => L.gymActions.markDone(s, x, false), "Visit removed.")];
      else if (x <= t0 && [G.PLANNED, G.MISSED, G.REST, G.BUSY].includes(e.status))
        btn = [e.status === G.PLANNED ? "Done" : "I went", e.status === G.PLANNED ? "primary" : "ghost", () => sessionSheet(x)];
      else if (e.status === G.PLANNED) btn = ["Not this day", "ghost", () => changeGym((s) => L.gymActions.skip(s, x), "Moved to another day.")];
      else if (e.status === G.SKIPPED || S.gym.picked.includes(x)) btn = ["Undo", "ghost", () => changeGym((s) => L.gymActions.reset(s, x), "Back to the automatic plan.")];
      else btn = ["Go this day", "ghost", () => changeGym((s) => L.gymActions.pick(s, x), "Gym planned.")];
      const what = (e.status === G.PLANNED || e.status === G.DONE) ? labels[x] : null;
      box.append(el("div", { class: `gday ${x === t0 ? "is-today" : ""}`, "data-key": `gday:${x}` },
        el("div", { class: "when" }, dayName(x)),
        el("div", { class: "grow" },
          el("div", { class: `title ${cls}` }, label || `Gym ${S.gym.time}`),
          what || e.why ? el("div", { class: "sub" }, what || e.why) : null),
        el("button", { class: `${btn[1]} sm`, onclick: btn[2] }, btn[0])));
    }
    out.push(box);
  }

  // body weight
  const wk = Object.keys(S.gym.weights).sort(), ws = L.weighStatus(S.gym, t0);
  out.push(section("Body weight", el("span", { class: `count ${ws.due ? "late" : ""}` }, ws.due ? "due" : `next ${dayName(ws.next).toLowerCase()}`)));
  const body = el("section", { class: "card" });
  if (!wk.length) body.append(empty("scale", `No weigh-ins yet. Log one and you get a reminder every ${S.gym.weigh_every} days.`));
  else {
    const v = (k) => S.gym.weights[k], lastK = wk[wk.length - 1];
    body.append(el("div", { class: "weight", "data-key": "weight" },
      el("div", { class: "grow" }, el("div", { class: "big" }, `${v(lastK).toFixed(1)} kg`),
        el("div", { class: "sub" }, wk.length > 1 ? `${(v(lastK) - v(wk[wk.length - 2])).toFixed(1).replace(/^(?!-)/, "+")} kg since last · ${(v(lastK) - v(wk[0])).toFixed(1).replace(/^(?!-)/, "+")} kg in total` : dayName(lastK))),
      spark(wk.slice(-20).map(v))));
  }
  body.append(el("button", { class: ws.due ? "primary wide" : "ghost wide", onclick: weighSheet }, "Weigh in"));
  out.push(body);

  // stats
  const weeks = [...Array(8)].map((_, i) => L.weekCount(S.gym, L.addDays(mon, -7 * (7 - i))));
  const year = S.gym.done.filter((x) => x.slice(0, 4) === t0.slice(0, 4)).length;
  const top = Math.max(S.gym.goal, ...weeks, 1);
  out.push(section("Stats"));
  out.push(el("section", { class: "card" },
    el("div", { class: "stats", "data-key": "stats" },
      el("div", {}, el("b", {}, String(year)), el("span", {}, `visits in ${t0.slice(0, 4)}`)),
      el("div", {}, el("b", {}, (weeks.slice(-4).reduce((a, b) => a + b, 0) / 4).toFixed(1)), el("span", {}, "per week, last 4")),
      el("div", {}, el("b", {}, String(st)), el("span", {}, "weeks at goal"))),
    el("div", { class: "bars", role: "img", "aria-label": `Visits per week, last 8 weeks: ${weeks.join(", ")}` },
      el("div", { class: "goal", style: `bottom:${Math.round(S.gym.goal / top * 100)}%` }),
      ...weeks.map((c, i) => el("div", { class: `bar ${c >= S.gym.goal ? "ok" : ""} ${i === 7 ? "now" : ""}`,
        style: `height:${Math.max(5, Math.round(c / top * 100))}%` }, el("span", {}, c || "")))),
    el("div", { class: "bars-cap" }, el("span", {}, "8 weeks ago"), el("span", {}, `Goal ${S.gym.goal} a week`), el("span", {}, "This week"))));
  out.push(el("p", { class: "note" }, (S.busyNote ? S.busyNote + ". " : "") + "Goal, time and preferred days are set in the PC app."));
  return out;
}

// Visits this week against the goal.
function ring(n, goal) {
  const C = 2 * Math.PI * 22, part = goal ? Math.min(n / goal, 1) : 0;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 58 58"); svg.setAttribute("class", "ring");
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `${n} of ${goal} visits this week`);
  svg.innerHTML = (part ? `<circle class="arc" cx="29" cy="29" r="22" stroke-dasharray="${(part * C).toFixed(1)} ${C.toFixed(1)}"/>` : "")
    + `<text x="29" y="29">${Number(n)}/${Number(goal)}</text>`;
  return svg;
}

function spark(vals) {
  if (vals.length < 2) return null;
  const W = 124, H = 48, lo = Math.min(...vals), hi = Math.max(...vals), span = Math.max(hi - lo, 1);
  const xy = vals.map((v, i) => [i * (W - 12) / (vals.length - 1) + 6, 6 + (hi - v) / span * (H - 16)]);
  const pts = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lx, ly] = xy[xy.length - 1];
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "spark"); svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = `<defs><linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".22"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>`
    + `<polygon points="${xy[0][0].toFixed(1)},${H} ${pts} ${lx.toFixed(1)},${H}" fill="url(#sparkfill)"/>`
    + `<polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4" fill="currentColor" stroke="var(--bg)" stroke-width="2"/>`;
  return svg;
}

function viewAdd() {
  const input = el("input", { type: "text", placeholder: "e.g. vacuum every saturday", enterkeyhint: "send",
    autocapitalize: "sentences", "aria-label": "New chore" });
  const send = () => guard(async () => {
    const text = input.value.trim();
    if (!text) return;
    await Store.appendLine("inbox.txt", text);
    input.value = "";
    toast("Sent. Your PC adds it within a minute (or when it is next on).");
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
  const ex = ["vacuum every saturday", "water plants every 4 days (10m)", "pay rent on the 1st at 10:00",
    "call dentist tomorrow", "descale kettle monthly"];
  return [header("Add a chore", "Write it like you would say it"),
    el("section", { class: "card" }, el("div", { class: "field" }, input, el("button", { class: "primary", onclick: send }, "Add"))),
    section("Examples"),
    el("section", { class: "card" }, el("div", { class: "chips" },
      ...ex.map((x) => el("button", { class: "chip", onclick: () => { input.value = x; input.focus(); } }, x))))];
}

// ---------------------------------------------------------------- shopping list (shopping.json, shared with the PC app)
// Ticks show at once and are saved in the background, one after another, so it keeps up while you
// walk the aisles. Each change is re-applied to the latest file, so the PC and phone never overwrite each other.
const STAPLES = ["Mjölk", "Bröd", "Smör", "Ägg", "Ost", "Kaffe", "Bananer", "Tomater", "Gurka", "Yoghurt", "Pasta", "Potatis",
  "Gul lök", "Kycklingfilé", "Köttfärs", "Toalettpapper", "Diskmedel", "Hushållspapper", "Kattmat", "Kattsand"];
let shopQueue = Promise.resolve();
function changeShop(fn, text) {
  const local = JSON.parse(JSON.stringify(S.shop));
  fn(local);
  S.shop = local;
  render();
  if (text) toast(text);
  shopQueue = shopQueue.then(async () => {
    try {
      const { data } = await Store.update("shopping.json", { items: [], rotation: [] }, (d) => {
        d.items = d.items || []; d.rotation = d.rotation || [];
        fn(d);
      });
      S.shop = { items: [], rotation: [], ...data };
    } catch (e) {
      console.error(e);
      toast("Couldn't save the list (no signal?). It is reloaded; try again.");
      try { await load(); } catch (_) { /* keep what is shown */ }
    }
  });
}
const shopAdd = (name) => (d) => {           // same rules as chores_home.add_item
  name = name.trim();
  if (!name) return;
  const f = ((d.freq = d.freq || {})[name.toLowerCase()] = d.freq[name.toLowerCase()] || { name, n: 0 });
  f.n += 1;
  if (d.items.some((i) => i.name.toLowerCase() === name.toLowerCase() && !i.done)) return;
  d.items.push({ id: Math.random().toString(16).slice(2, 10).padEnd(8, "0"), name, note: "", done: false, source: null, added: today() });
};
const shopToggle = (id) => (d) => { const i = d.items.find((x) => x.id === id); if (i) i.done = !i.done; };
const shopRemove = (id) => (d) => {          // same as chores_home.remove_item
  const i = d.items.find((x) => x.id === id), src = (i && i.source) || "";
  for (const r of d.rotation) if (src === `rotation:${r.id}`) r.last_bought = today();
  d.items = d.items.filter((x) => x.id !== id);
};
const shopFinish = (d) => {                  // same as chores_home.finish_shop
  for (const i of d.items.filter((x) => x.done)) for (const r of d.rotation) if ((i.source || "") === `rotation:${r.id}`) r.last_bought = today();
  d.items = d.items.filter((x) => !x.done);
};
function shopSuggestions(q) {
  const waiting = new Set(S.shop.items.filter((i) => !i.done).map((i) => i.name.toLowerCase()));
  const own = Object.values(S.shop.freq || {}).sort((a, b) => b.n - a.n).map((v) => v.name);
  const seen = new Set(), pool = [];
  for (const n of own.concat(STAPLES)) { const k = n.toLowerCase(); if (!seen.has(k) && !waiting.has(k)) { seen.add(k); pool.push(n); } }
  q = q.trim().toLowerCase();
  if (!q) return pool.slice(0, 12);
  return pool.filter((n) => n.toLowerCase().startsWith(q) || n.toLowerCase().split(" ").some((w) => w.startsWith(q))).slice(0, 8);
}

function viewShop() {
  const items = S.shop.items, left = items.filter((i) => !i.done), got = items.filter((i) => i.done);
  const sub = items.length ? `${left.length} to buy${got.length ? ` · ${got.length} in the basket` : ""}` : "The list is empty";
  const out = [header("Shopping", sub)];

  const input = el("input", { type: "text", placeholder: "Add an item", enterkeyhint: "done", autocapitalize: "sentences",
    "aria-label": "Add to shopping list" });
  const chips = el("div", { class: "chips" });
  let active = false;                 // suggestions only while adding, so the list stays on top in the shop
  const fill = () => chips.replaceChildren(...(active || input.value ? shopSuggestions(input.value).slice(0, 9) : []).map((n) =>
    el("button", { class: "chip", onpointerdown: (e) => e.preventDefault(), onclick: () => { changeShop(shopAdd(n)); } }, "+ " + n)));
  input.addEventListener("focus", () => { active = true; fill(); });
  input.addEventListener("blur", () => { active = false; setTimeout(fill, 150); });
  const add = () => {
    const name = input.value.trim();
    if (!name) return;
    changeShop(shopAdd(name));
    input.value = "";
    fill();
    input.focus();
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  input.addEventListener("input", fill);
  fill();
  out.push(el("section", { class: "card" }, el("div", { class: "field" }, input, el("button", { class: "primary", onclick: add }, "Add")), chips));

  const row = (i) => el("div", { class: `buy ${i.done ? "got" : ""}`, "data-key": `buy:${i.id}` },
    el("button", { class: "tick", "aria-label": i.done ? `Put ${i.name} back` : `Got ${i.name}`, "aria-pressed": String(!!i.done),
      onclick: () => changeShop(shopToggle(i.id)) },
      el("span", { class: "box" }, i.done ? icon("check") : null),
      el("span", { class: "name" }, i.name, i.note ? el("small", {}, i.note) : null)),
    el("button", { class: "ghost icon-sm", "aria-label": `Remove ${i.name}`, onclick: () => changeShop(shopRemove(i.id), `Removed ${i.name}.`) }, icon("x")));

  out.push(section("To buy", left.length ? el("span", { class: "count" }, String(left.length)) : null));
  out.push(el("section", { class: "card list" }, ...(left.length ? left.map(row) : [empty("bag", got.length ? "Everything is in the basket." : "Nothing to buy. Add something above.")])));
  if (got.length) {
    out.push(section("In the basket", el("span", { class: "count" }, String(got.length))));
    out.push(el("section", { class: "card list" }, ...got.map(row),
      el("button", { class: "primary wide", onclick: () => changeShop(shopFinish, `Shop finished: ${got.length} bought.`) }, icon("check"), "Finish shop")));
  }
  return out;
}

// ---------------------------------------------------------------- render, with gentle motion when things change
const VIEWS = { today: viewToday, gym: viewGym, shop: viewShop, add: viewAdd };
const EASE = "cubic-bezier(.22,.8,.26,1)";

// Where every keyed element sits (relative to its section), so the next paint can glide from there.
function snapshot(main) {
  const map = new Map();
  for (const sec of main.children) {
    const top = sec.getBoundingClientRect().top;
    map.set(`sec:${sec.dataset.sec}`, { top });
    for (const k of sec.querySelectorAll("[data-key]")) {
      const r = k.getBoundingClientRect();
      map.set(k.dataset.key, { top: r.top - top, rect: r, text: k.textContent, node: k });
    }
  }
  return map;
}
function settle(main, before) {
  const seen = new Set();
  const slide = (node, dy) => { if (Math.abs(dy) > 1) node.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 380, easing: EASE }); };
  for (const sec of main.children) {
    const top = sec.getBoundingClientRect().top, old = before.get(`sec:${sec.dataset.sec}`);
    if (old) slide(sec, old.top - top);
    for (const k of sec.querySelectorAll("[data-key]")) {
      const was = before.get(k.dataset.key);
      seen.add(k.dataset.key);
      if (!was) k.animate([{ opacity: 0, transform: "scale(.97)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: EASE });
      else if (Math.abs(was.top - (k.getBoundingClientRect().top - top)) > 1) slide(k, was.top - (k.getBoundingClientRect().top - top));
      else if (was.text !== k.textContent) k.animate([{ opacity: .3 }, { opacity: 1 }], { duration: 320, easing: "ease-out" });
    }
  }
  for (const [key, was] of before) {              // what left fades out where it was
    if (!was.node || seen.has(key) || !was.node.hasAttribute("data-exit")) continue;
    const g = was.node;
    g.classList.add("ghost-out");
    g.style.cssText = `left:${was.rect.left}px;top:${was.rect.top}px;width:${was.rect.width}px`;
    document.body.append(g);
    g.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.96)" }], { duration: 220, easing: "ease-in" })
      .finished.then(() => g.remove(), () => g.remove());
  }
}

let shownTab = null;
function render() {
  const main = $("main");
  const swap = shownTab !== S.tab;
  const before = swap || calm.matches || !main.animate ? null : snapshot(main);
  const kids = VIEWS[S.tab]();
  kids.forEach((k, i) => { k.dataset.sec = i; });
  main.replaceChildren(...kids);
  if (swap) {                      // the whole view rises in only when the tab changes, not after every tap
    main.classList.remove("enter"); void main.offsetWidth; main.classList.add("enter");
    if (shownTab) window.scrollTo(0, 0);
    shownTab = S.tab;
  } else if (before) settle(main, before);
  const tabs = [...document.querySelectorAll("nav button")];
  tabs.forEach((b) => {
    b.classList.toggle("on", b.dataset.tab === S.tab);
    if (b.dataset.tab === S.tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  $("nav").style.setProperty("--i", Math.max(0, tabs.findIndex((b) => b.dataset.tab === S.tab)));
}

function signInScreen(error) {
  $("nav").hidden = true;
  $("main").replaceChildren(el("section", { class: "signin" },
    el("img", { src: "icon-192.png", alt: "", width: 88, height: 88 }),
    el("h1", {}, "Chores"),
    el("p", {}, "Sign in with the Microsoft account whose OneDrive has your Chores folder."),
    error ? el("p", { class: "late" }, error) : null,
    CONFIG.clientId ? el("button", { class: "primary big", onclick: () => Auth.login() }, "Sign in with Microsoft")
      : el("p", { class: "late" }, "Not set up yet: add the app's client ID to config.js.")));
}

// ---------------------------------------------------------------- start
async function start() {
  for (const b of document.querySelectorAll("nav button")) b.addEventListener("click", () => { S.tab = b.dataset.tab; render(); });
  if (!DEMO) {
    try { await Auth.handleRedirect(); } catch (e) { return signInScreen(e.message); }
    if (!Auth.signedIn()) return signInScreen();
  }
  $("nav").hidden = false;
  await firstLoad();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && (!S.loaded || Date.now() - S.loaded > 30000)) guard(load);
  });
}

// First load shows a placeholder, and a retry card if OneDrive can't be reached.
async function firstLoad() {
  const skel = (cls) => el("div", { class: `card skel ${cls || ""}`, "aria-hidden": "true" }, el("i"), el("i"), el("i"));
  $("main").replaceChildren(skel("head"), skel(), skel(), el("p", { class: "loading", role: "status" }, "Loading your chores…"));
  try { await load(); } catch (e) {
    console.error(e);
    $("main").replaceChildren(el("section", { class: "card center" },
      bubble("alert"),
      el("h2", {}, "Couldn't reach OneDrive"), el("p", {}, e.message || String(e)),
      el("button", { class: "primary", onclick: firstLoad }, "Try again")));
  }
}

// ---------------------------------------------------------------- demo data (localhost?demo only)
function demoStore() {
  const t0 = L.localToday();
  const files = {
    "tasks.json": { version: 1, tasks: [
      { id: "a1", name: "Clean fridge", rule: { type: "after", n: 4, unit: "weeks" }, next_due: L.addDays(t0, -2), minutes: 30, active: true, history: [] },
      { id: "a2", name: "Vacuum", rule: { type: "weekdays", days: [5] }, next_due: t0, minutes: 25, active: true, history: [] },
      { id: "a3", name: "Call dentist", rule: { type: "once" }, next_due: t0, active: true, history: [] },
      { id: "a4", name: "Water plants", rule: { type: "every", n: 4, unit: "days", anchor: t0 }, next_due: L.addDays(t0, 2), minutes: 10, active: true, history: [] },
    ] },
    "gym.json": { ...GYM_DEFAULTS, done: [L.addDays(t0, -1), L.addDays(t0, -3), L.addDays(t0, -6), L.addDays(t0, -8)],
      sessions: { [L.addDays(t0, -8)]: ["chest", "triceps"], [L.addDays(t0, -6)]: ["legs", "traps", "core"], [L.addDays(t0, -3)]: ["back", "biceps"], [L.addDays(t0, -1)]: ["chest", "legs"] },
      weights: { [L.addDays(t0, -42)]: 84.1, [L.addDays(t0, -28)]: 83.6, [L.addDays(t0, -14)]: 83.0 } },
    "phone.json": { generated: new Date().toISOString(), busy: { [L.addDays(t0, 3)]: ["hard", "18:00 Dinner"] },
      weather: { temp: 7, text: "Cloudy", icon: "w_cloud", place: "Malmö" },
      days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((i) => [L.addDays(t0, i), {
        partner: i === 0 ? [["11:30", "21:00", true]] : i % 2 ? [["11:30", "16:00", false]] : [],
        partner_known: i < 5, events: i === 3 ? ["18:00 Dinner"] : [], dinner: i === 0 ? "Tacos" : undefined,
        weather: { icon: ["w_rain", "w_cloud", "w_partly", "w_sun"][i % 4], max: 8 - i, min: 3 - i } }])) },
    "inbox.txt": "",
    "shopping.json": { rotation: [], freq: { "mjölk": { name: "Mjölk", n: 5 }, "kattsand": { name: "Kattsand", n: 3 } }, items: [
      { id: "s1", name: "Mjölk", note: "", done: false, source: null, added: t0 },
      { id: "s2", name: "Kycklingfilé", note: "for: Tacos", done: false, source: null, added: t0 },
      { id: "s3", name: "Tortillabröd", note: "", done: true, source: null, added: t0 },
      { id: "s4", name: "Kattmat", note: "", done: false, source: null, added: t0 }] },
  };
  const copy = (x) => JSON.parse(JSON.stringify(x));
  return {
    async readJSON(name, fallback) { return { data: copy(files[name] ?? fallback), etag: "1" }; },
    async update(name, fallback, fn) { const d = copy(files[name] ?? fallback); const result = fn(d); files[name] = d; return { data: copy(d), result }; },
    async appendLine(name, line) { files[name] += line + "\n"; },
  };
}

start();
