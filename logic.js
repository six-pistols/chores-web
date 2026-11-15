// Chores scheduling logic for the phone: a direct port of chores_core.py / chores_gym.py.
// Dates are ISO strings "YYYY-MM-DD" throughout, so time zones never shift a day.
// tests/test_web_parity.py checks these functions against the Python ones.
"use strict";

const Logic = (() => {
  // ---------------------------------------------------------------- dates
  function toUTC(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  }
  function fromUTC(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }
  function addDays(iso, n) {
    return fromUTC(toUTC(iso) + n * 86400000);
  }
  function weekday(iso) { // 0 = Monday, like Python
    return (new Date(toUTC(iso)).getUTCDay() + 6) % 7;
  }
  function daysBetween(a, b) { // b - a
    return Math.round((toUTC(b) - toUTC(a)) / 86400000);
  }
  function monthDays(y, m) { // m 1..12
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function make(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }

  function addMonths(iso, n, day) {
    const [y0, m0, d0] = iso.split("-").map(Number);
    const mm = m0 - 1 + n;
    const y = y0 + Math.floor(mm / 12);
    const m = ((mm % 12) + 12) % 12 + 1;
    const dd = day || d0;
    return make(y, m, Math.min(dd, monthDays(y, m)));
  }

  function step(iso, n, unit) {
    if (unit === "days") return addDays(iso, n);
    if (unit === "weeks") return addDays(iso, 7 * n);
    if (unit === "months") return addMonths(iso, n);
    if (unit === "years") return addMonths(iso, 12 * n);
    throw new Error("unit " + unit);
  }

  function localToday() {
    const t = new Date();
    return make(t.getFullYear(), t.getMonth() + 1, t.getDate());
  }

  // ---------------------------------------------------------------- rules
  function nextOccurrence(rule, after) {
    const t = rule.type;
    if (t === "weekdays") {
      let x = addDays(after, 1);
      while (!rule.days.includes(weekday(x))) x = addDays(x, 1);
      return x;
    }
    if (t === "monthday") {
      const first = after.slice(0, 8) + "01";
      const x = addMonths(first, 0, rule.day);
      return x > after ? x : addMonths(first, 1, rule.day);
    }
    if (t === "lastwd") {
      let year = Number(after.slice(0, 4));
      for (;;) {
        let x = make(year, rule.month, monthDays(year, rule.month));
        const back = (((weekday(x) - rule.wd) % 7) + 7) % 7; // Python's % is never negative
        x = addDays(x, -back);
        if (x > after) return x;
        year += 1;
      }
    }
    if (t === "every") {
      const anchor = rule.anchor;
      if (anchor > after) return anchor;
      if (rule.unit === "days" || rule.unit === "weeks") {
        const period = rule.n * (rule.unit === "weeks" ? 7 : 1);
        const k = Math.floor(daysBetween(anchor, after) / period) + 1;
        return addDays(anchor, k * period);
      }
      const months = rule.n * (rule.unit === "years" ? 12 : 1);
      const [ay, am] = anchor.split("-").map(Number);
      const [by, bm] = after.split("-").map(Number);
      let k = Math.max(0, Math.floor(((by - ay) * 12 + bm - am) / months) - 1);
      for (;;) {
        const x = addMonths(anchor, k * months);
        if (x > after) return x;
        k += 1;
      }
    }
    return null;
  }

  const NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December"];

  function describeRule(rule) {
    const t = rule.type;
    if (t === "once") return "one-time";
    if (t === "every" || t === "after") {
      const base = rule.n === 1 ? `every ${rule.unit.slice(0, -1)}` : `every ${rule.n} ${rule.unit}`;
      return base + (t === "after" ? " after done" : "");
    }
    if (t === "weekdays") {
      const days = [...rule.days].sort((a, b) => a - b);
      const s = days.join(",");
      if (s === "0,1,2,3,4") return "every weekday";
      if (s === "5,6") return "every weekend";
      if (days.length === 7) return "every day";
      return "every " + days.map((i) => NAMES[i]).join(", ");
    }
    if (t === "lastwd") return `last ${LONG[rule.wd]} of ${MONTHS[rule.month - 1]}`;
    if (t === "monthday") {
      const n = rule.day;
      const suf = n % 100 >= 10 && n % 100 <= 20 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
      return `monthly on the ${n}${suf}`;
    }
    return t;
  }

  // ---------------------------------------------------------------- task ops
  function complete(task, skip, on) {
    const due = task.next_due;
    if (!skip) {
      task.last_done = on;
      task.history = (task.history || []).concat([on]);
    }
    task.snoozed_until = null;
    task.flagged = false;
    const r = task.rule;
    if (r.type === "once") {
      task.active = false;
      return;
    }
    task.next_due = r.type === "after" ? step(on, r.n, r.unit) : nextOccurrence(r, on > due ? on : due);
  }

  function snoozeDays(task, days, today) {
    task.next_due = addDays(today, days);
    task.snoozed_until = null;
  }

  function occurrences(task, start, end) {
    if (!task.active) return [];
    const out = [];
    const r = task.rule;
    let x = task.next_due;
    for (let i = 0; i < 400; i++) {
      if (x === null || x > end) break;
      if (x >= start) out.push(x);
      if (r.type === "once") break;
      x = r.type === "after" ? step(x, r.n, r.unit) : nextOccurrence(r, x);
    }
    return out;
  }

  // ---------------------------------------------------------------- gym
  const GYM = { DONE: "done", PLANNED: "planned", MISSED: "missed", BUSY: "busy", SKIPPED: "skipped", REST: "rest" };

  function mondayOf(iso) { return addDays(iso, -weekday(iso)); }

  function combinations(arr, n) {
    const out = [];
    (function rec(start, combo) {
      if (combo.length === n) { out.push(combo.slice()); return; }
      for (let i = start; i < arr.length; i++) { combo.push(arr[i]); rec(i + 1, combo); combo.pop(); }
    })(0, []);
    return out;
  }

  function choose(cands, fixed, n, prefer, soft) {
    n = Math.min(n, cands.length);
    if (n <= 0) return [];
    let best = null;
    let bestScore = null;
    for (const combo of combinations(cands, n)) {
      const days = [...new Set(combo.concat(fixed))].sort();
      let score = 0; // whole numbers, same weights as chores_gym._choose
      for (const x of combo) {
        if (prefer.has(weekday(x))) score += 300;
        if (soft.has(x)) score -= 500;
        score -= weekday(x);
      }
      for (let i = 1; i < days.length; i++) if (daysBetween(days[i - 1], days[i]) === 1) score -= 400;
      if (bestScore === null || score > bestScore) { best = combo; bestScore = score; }
    }
    return best.slice().sort();
  }

  // busy: iso -> null | ["hard"|"soft", why]
  function planWeek(state, monday, today, busy) {
    busy = busy || (() => null);
    const days = [...Array(7)].map((_, i) => addDays(monday, i));
    const done = new Set(days.filter((x) => state.done.includes(x)));
    const picked = new Set(days.filter((x) => state.picked.includes(x) && !done.has(x)));
    const skipped = new Set(days.filter((x) => state.skipped.includes(x) && !done.has(x) && !picked.has(x)));
    const marks = Object.fromEntries(days.map((x) => [x, busy(x)]));

    const openDays = days.filter((x) => x >= today && !done.has(x) && !skipped.has(x));
    const fixed = [...picked].filter((x) => x >= today).sort();
    const cands = openDays.filter((x) => !picked.has(x) && !(marks[x] && marks[x][0] === "hard"));
    const need = Math.max(0, state.goal - done.size - fixed.length);
    const soft = new Set(cands.filter((x) => marks[x] && marks[x][0] === "soft"));
    const chosen = new Set(fixed.concat(choose(cands, [...new Set([...done, ...fixed])].sort(), need,
      new Set(state.prefer), soft)));

    return days.map((x) => {
      const mark = marks[x];
      let status, why = "";
      if (done.has(x)) status = GYM.DONE;
      else if (chosen.has(x)) { status = GYM.PLANNED; why = mark ? mark[1] : ""; }
      else if (x < today && (picked.has(x) || state.prefer.includes(weekday(x)))) status = GYM.MISSED;
      else if (skipped.has(x)) status = GYM.SKIPPED;
      else if (mark && mark[0] === "hard") { status = GYM.BUSY; why = mark[1]; }
      else status = GYM.REST;
      return { date: x, status, why };
    });
  }

  function weekCount(state, monday) {
    const end = addDays(monday, 6);
    return state.done.filter((x) => x >= monday && x <= end).length;
  }

  function streak(state, today) {
    let monday = mondayOf(today);
    let n = weekCount(state, monday) >= state.goal ? 1 : 0;
    monday = addDays(monday, -7);
    while (weekCount(state, monday) >= state.goal) { n += 1; monday = addDays(monday, -7); }
    return n;
  }

  function toggle(list, iso, on) {
    const i = list.indexOf(iso);
    if (on && i < 0) { list.push(iso); list.sort(); }
    if (!on && i >= 0) list.splice(i, 1);
  }
  const gymActions = {
    markDone(s, iso, on = true) { toggle(s.done, iso, on); if (on) toggle(s.skipped, iso, false); },
    pick(s, iso) { toggle(s.picked, iso, true); toggle(s.skipped, iso, false); },
    skip(s, iso) { toggle(s.skipped, iso, true); toggle(s.picked, iso, false); },
    reset(s, iso) { toggle(s.picked, iso, false); toggle(s.skipped, iso, false); },
  };

  return {
    addDays, addMonths, step, weekday, daysBetween, localToday, nextOccurrence, describeRule, complete, snoozeDays,
    occurrences, GYM, mondayOf, planWeek, weekCount, streak, gymActions, NAMES, LONG, MONTHS,
  };
})();

if (typeof module !== "undefined") module.exports = Logic;
