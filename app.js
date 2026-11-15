// Chores on the phone: today's chores, gym days, quick add. Same OneDrive files as the PC app.
"use strict";

const L = Logic;
const G = L.GYM;
const GYM_DEFAULTS = { goal: 3, time: "17:00", minutes: 75, prefer: [], done: [], picked: [], skipped: [],
  splits: L.ROUTINE, sessions: {}, weights: {}, weigh_every: 14 };
const DEMO = new URLSearchParams(location.search).has("demo") && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const Store = DEMO ? demoStore() : Cloud;

const S = { tab: "today", tasks: [], gym: { ...GYM_DEFAULTS }, busy: {}, loaded: null, busyNote: "", undo: null };
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
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(hideToast, 5000);
}
function hideToast() { $("#toast").hidden = true; }
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
  const [tasks, gym, phone] = await Promise.all([
    Store.readJSON("tasks.json", { version: 1, tasks: [] }),
    Store.readJSON("gym.json", { ...GYM_DEFAULTS }),
    Store.readJSON("phone.json", { busy: {} }),
  ]);
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
  const close = () => wrap.remove();
  const wrap = el("div", { class: "sheet-wrap", onclick: (e) => { if (e.target === wrap) close(); } },
    el("div", { class: "sheet" }, el("div", { class: "grab" }), el("h2", {}, title), sub ? el("p", { class: "sub" }, sub) : null, ...body));
  document.body.append(wrap);
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
  const chips = el("div", { class: "pills groups" }, ...L.GROUPS.map((g) => {
    const b = el("button", { class: `chip ${picked.has(g) ? "on" : ""}`, onclick: () => {
      picked.has(g) ? picked.delete(g) : picked.add(g); b.classList.toggle("on", picked.has(g)); } }, cap1(g));
    return b;
  }));
  close = sheet("What did you train?", `${dayName(day)} · tap your session, or pick groups for a mixed day`,
    splits, el("h2", { class: "small" }, "Or pick muscle groups"), chips,
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
  const input = el("input", { type: "text", inputmode: "decimal", placeholder: last ? last.toFixed(1) : "80.0", class: "kg" });
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
    el("div", { class: "add" }, input, el("span", { class: "unit" }, "kg")),
    el("div", { class: "row end" }, el("button", { class: "ghost", onclick: () => close() }, "Cancel"),
      el("button", { class: "primary", onclick: save }, "Save")));
  setTimeout(() => input.focus(), 50);
}

// ---------------------------------------------------------------- views
function header(title, sub) {
  return el("header", {},
    el("div", {}, el("h1", {}, title), sub ? el("p", { class: "sub" }, sub) : null),
    el("button", { class: "icon", "aria-label": "Refresh", onclick: () => guard(load) }, "↻"));
}

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
  return !evening ? "lunch shift" : a < "14:00" ? "lunch + evening shift" : "evening shift";
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
  const out = [header(`${L.LONG[L.weekday(t0)]} ${d} ${L.MONTHS[m - 1]}`, wxText)];
  out.push(timeline(t0));

  const list = el("section", { class: "card" },
    el("h2", {}, "To do", due.length ? el("span", { class: `count ${late ? "late" : ""}` }, String(due.length)) : null));
  if (!due.length) list.append(el("p", { class: "empty" }, "Nothing waiting. Enjoy your day."));
  for (const t of due) {
    const recurring = t.rule.type !== "once";
    list.append(el("div", { class: "item stack" },
      el("div", { class: "grow" }, el("div", { class: "title" }, t.name), el("div", { class: `sub ${t.next_due < t0 ? "late" : ""}` }, taskSub(t))),
      el("div", { class: "actions" },
        el("button", { class: "ghost", onclick: () => changeTask(t.id, (x) => L.snoozeDays(x, 1, today()), `“${t.name}” moved to tomorrow.`) }, "Tomorrow"),
        recurring ? el("button", { class: "ghost", onclick: () => changeTask(t.id, (x) => L.complete(x, true, today()), `Skipped “${t.name}” this time.`) }, "Skip") : null,
        el("button", { class: "primary", onclick: () => changeTask(t.id, (x) => L.complete(x, false, today()), `Done: ${t.name}`) }, "Done"))));
  }
  out.push(list);
  out.push(thisWeek(t0));
  return out;
}

// Today as a timeline: partner's shift (leaves / home), gym, dinner, your calendar, in time order.
function timeline(t0) {
  const info = S.days[t0];
  const box = el("section", { class: "card tl" });
  if (!info) {
    box.append(el("p", { class: "empty" }, "Open the PC app once today to see shifts and plans here."));
    return box;
  }
  const ev = [];                                   // {at, title, sub, kind, action, done}
  const shifts = info.partner || [];
  const away = shifts.some((x) => x[2]);
  for (const [a, b] of shifts) {
    ev.push({ at: a, title: `Partner: ${shiftKind(a, b)}`, sub: `until ${b}`, kind: "partner" });
    ev.push({ at: b, title: "Partner home", kind: "partner end" });
  }
  const g = gymWeek(L.mondayOf(t0))[L.weekday(t0)];
  if (g.status === G.PLANNED || g.status === G.DONE) {
    const n = L.weekCount(S.gym, L.mondayOf(t0));
    const done = g.status === G.DONE;
    const what = gymLabels(1)[t0];
    ev.push({ at: S.gym.time, title: (done ? "Gym ✓" : "Gym") + (what ? ` · ${what}` : ""), sub: `${n} of ${S.gym.goal} this week`, kind: "gym", done,
      action: done
        ? el("button", { class: "ghost", onclick: () => changeGym((s) => L.gymActions.markDone(s, t0, false), "Visit removed.") }, "Undo")
        : el("button", { class: "primary", onclick: () => sessionSheet(t0) }, "Done") });
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
  if (shifts.length) status = away ? ["🌙", `Partner on ${shiftKind(shifts[0][0], shifts[shifts.length - 1][1])}`, "away"] : ["🍽️", "Partner on lunch shift, home for dinner", "work"];
  else if (info.partner_known) status = ["🏠", "Partner is off today", "home"];
  else status = ["❔", "Partner's schedule isn't out yet", "unknown"];
  box.append(el("div", { class: `tl-status ${status[2]}` }, el("span", {}, status[0]), status[1]));
  for (const t of allDay) box.append(el("div", { class: "tl-allday" }, "All day · " + t));
  if (L.weighStatus(S.gym, t0).due) box.append(el("div", { class: "tl-weigh" }, el("span", {}, "⚖️"),
    el("div", { class: "grow" }, el("div", { class: "title" }, "Weigh-in day"), el("div", { class: "sub" }, `Every ${S.gym.weigh_every} days`)),
    el("button", { class: "primary", onclick: weighSheet }, "Log")));

  if (!ev.length) {
    box.append(el("p", { class: "empty" }, "Nothing planned today."));
    return box;
  }
  const now = nowHM();
  let nowShown = false;
  const rail = el("div", { class: "tl-rail" });
  for (const e of ev) {
    if (!nowShown && e.at > now) {
      rail.append(el("div", { class: "tl-now" }, el("span", {}, now)));
      nowShown = true;
    }
    rail.append(el("div", { class: `tl-item ${e.kind} ${e.at <= now ? "past" : ""} ${e.done ? "done" : ""}` },
      el("div", { class: "tl-time" }, e.at),
      el("div", { class: "tl-dot" }),
      el("div", { class: "grow" }, el("div", { class: "title" }, e.title), e.sub ? el("div", { class: "sub" }, e.sub) : null),
      e.action || null));
  }
  if (!nowShown) rail.append(el("div", { class: "tl-now" }, el("span", {}, now)));
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
  const box = el("section", { class: "card" }, el("h2", {}, "This week"));
  const labels = gymLabels(8);
  for (let i = 1; i <= 7; i++) {
    const x = L.addDays(t0, i);
    const gd = gymWeek(L.mondayOf(x))[L.weekday(x)];
    const info = S.days[x] || {};
    const bits = [];
    for (const [a, b, eve] of info.partner || []) bits.push(el("span", { class: "partner" }, `Partner ${shiftKind(a, b).replace(" shift", "")} ${a}–${b}${eve ? " 🌙" : ""}`));
    if (!(info.partner || []).length && info.partner_known) bits.push(el("span", { class: "home" }, "Partner off"));
    if (gd.status === G.PLANNED || gd.status === G.DONE) bits.push(el("span", { class: "gym" }, `Gym ${labels[x] || S.gym.time}`));
    for (const e of info.events || []) bits.push(el("span", { class: "event" }, e));
    if (info.dinner) bits.push(el("span", { class: "dinner" }, info.dinner));
    const chores = byDay[x] || [];
    const wx = info.weather;
    box.append(el("div", { class: "wk" },
      el("div", { class: "wk-day" }, el("b", {}, L.NAMES[L.weekday(x)]),
        el("span", {}, `${Number(x.slice(8))}`), wx ? el("span", { class: "wk-wx" }, `${WX[wx.icon] || ""}${wx.max}°`) : null),
      el("div", { class: "grow" },
        bits.length ? el("div", { class: "wk-line" }, ...bits.flatMap((bEl, k) => (k ? [el("i", {}, " · "), bEl] : [bEl]))) : el("div", { class: "wk-line muted" }, "Nothing planned"),
        chores.length ? el("div", { class: "wk-chores" }, chores.join(", ")) : null)));
  }
  return box;
}

const STATUS = {
  [G.DONE]: ["Done ✓", "ok"], [G.PLANNED]: [null, "accent"], [G.MISSED]: ["Missed", "late"],
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
    el("div", { class: "sub caps" }, doneToday ? "Trained today" : "Next session"),
    el("div", { class: "big" }, (nextName || "—") + (doneToday ? " ✓" : "")),
    el("div", { class: "sub" }, doneToday ? "Nice work." : nextDay ? `${dayName(nextDay)} at ${S.gym.time}` : "Next time you go"),
    el("div", { class: "pills" }, ...groupsOf.map((g) => pill("gym", cap1(g)))),
    el("div", { class: "groups-grid" }, ...L.GROUPS.map((g) => {
      const d = since[g], cls = d === null ? "never" : d <= 4 ? "fresh" : d <= 8 ? "soon" : "due";
      return el("div", { class: `grp ${cls}` }, el("b", {}, cap1(g)),
        el("span", {}, d === null ? "not yet" : d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days`));
    })),
    !doneToday ? el("button", { class: "primary wide", onclick: () => sessionSheet(t0) }, "Log today's session") : null));

  for (const [offset, title] of [[0, "This week"], [7, "Next week"]]) {
    const plan = gymWeek(L.addDays(mon, offset));
    const box = el("section", { class: "card" }, el("h2", {}, title));
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
      box.append(el("div", { class: `item ${x === t0 ? "is-today" : ""}` },
        el("div", { class: "when" }, dayName(x)),
        el("div", { class: "grow" },
          el("div", { class: `title ${cls}` }, label || `Gym ${S.gym.time}`),
          what || e.why ? el("div", { class: "sub" }, what || e.why) : null),
        el("button", { class: btn[1], onclick: btn[2] }, btn[0])));
    }
    out.push(box);
  }

  // body weight
  const wk = Object.keys(S.gym.weights).sort(), ws = L.weighStatus(S.gym, t0);
  const body = el("section", { class: "card" }, el("h2", {}, "Body weight",
    el("span", { class: `count ${ws.due ? "late" : ""}` }, ws.due ? "due" : `next ${dayName(ws.next).toLowerCase()}`)));
  if (!wk.length) body.append(el("p", { class: "empty" }, `No weigh-ins yet. Log one and you get a reminder every ${S.gym.weigh_every} days.`));
  else {
    const v = (k) => S.gym.weights[k], lastK = wk[wk.length - 1];
    body.append(el("div", { class: "row" },
      el("div", { class: "grow" }, el("div", { class: "big" }, `${v(lastK).toFixed(1)} kg`),
        el("div", { class: "sub" }, wk.length > 1 ? `${(v(lastK) - v(wk[wk.length - 2])).toFixed(1).replace(/^(?!-)/, "+")} kg since last · ${(v(lastK) - v(wk[0])).toFixed(1).replace(/^(?!-)/, "+")} kg in total` : dayName(lastK))),
      spark(wk.slice(-20).map(v))));
  }
  body.append(el("button", { class: ws.due ? "primary wide" : "ghost wide", onclick: weighSheet }, "Weigh in"));
  out.push(body);

  // stats
  const weeks = [...Array(8)].map((_, i) => L.weekCount(S.gym, L.addDays(mon, -7 * (7 - i))));
  const year = S.gym.done.filter((x) => x.slice(0, 4) === t0.slice(0, 4)).length;
  out.push(el("section", { class: "card" }, el("h2", {}, "Stats"),
    el("div", { class: "stats" },
      el("div", {}, el("b", {}, String(year)), el("span", {}, `visits in ${t0.slice(0, 4)}`)),
      el("div", {}, el("b", {}, (weeks.slice(-4).reduce((a, b) => a + b, 0) / 4).toFixed(1)), el("span", {}, "per week, last 4")),
      el("div", {}, el("b", {}, String(st)), el("span", {}, "weeks at goal"))),
    el("div", { class: "bars" }, ...weeks.map((c, i) => el("div", { class: `bar ${c >= S.gym.goal ? "ok" : ""} ${i === 7 ? "now" : ""}`,
      style: `height:${Math.max(4, Math.round(c / Math.max(S.gym.goal, ...weeks, 1) * 100))}%` }, el("span", {}, c || ""))))));
  out.push(el("p", { class: "note" }, (S.busyNote ? S.busyNote + ". " : "") + "Goal, time and preferred days are set in the PC app."));
  return out;
}

function spark(vals) {
  if (vals.length < 2) return null;
  const W = 120, H = 44, lo = Math.min(...vals), hi = Math.max(...vals), span = Math.max(hi - lo, 1);
  const pts = vals.map((v, i) => `${(i * (W - 8) / (vals.length - 1) + 4).toFixed(1)},${(4 + (hi - v) / span * (H - 8)).toFixed(1)}`).join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "spark");
  svg.innerHTML = `<polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  return svg;
}

function viewAdd() {
  const input = el("input", { type: "text", placeholder: "e.g. vacuum every saturday", enterkeyhint: "send",
    autocapitalize: "sentences" });
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
    el("section", { class: "card" }, el("div", { class: "add" }, input, el("button", { class: "primary", onclick: send }, "Add")),
      el("h2", { class: "small" }, "Examples"),
      ...ex.map((x) => el("button", { class: "chip", onclick: () => { input.value = x; input.focus(); } }, x)))];
}

let shownTab = null;
function render() {
  const main = $("main");
  main.replaceChildren(...({ today: viewToday, gym: viewGym, add: viewAdd }[S.tab])());
  if (shownTab !== S.tab) {        // animate only when the view changes, not after every tap
    main.classList.remove("enter"); void main.offsetWidth; main.classList.add("enter");
    shownTab = S.tab;
  }
  for (const b of document.querySelectorAll("nav button")) b.classList.toggle("on", b.dataset.tab === S.tab);
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
  $("main").replaceChildren(el("section", { class: "card" }, el("p", { class: "empty" }, "Loading your chores…")));
  try { await load(); } catch (e) {
    console.error(e);
    $("main").replaceChildren(el("section", { class: "card" },
      el("h2", {}, "Couldn't reach OneDrive"), el("p", { class: "empty" }, e.message || String(e)),
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
  };
  const copy = (x) => JSON.parse(JSON.stringify(x));
  return {
    async readJSON(name, fallback) { return { data: copy(files[name] ?? fallback), etag: "1" }; },
    async update(name, fallback, fn) { const d = copy(files[name] ?? fallback); const result = fn(d); files[name] = d; return { data: copy(d), result }; },
    async appendLine(name, line) { files[name] += line + "\n"; },
  };
}

start();
