// Weekly QA Counter app.js - restored v300
// Includes auditor_absences fix and inline fail selector buttons.

const app = document.getElementById("app");

const supabaseClient = supabase.createClient(
  window.SUPABASE_URL,
  window.SUPABASE_ANON_KEY
);

const DAYS = [
  { label: "Mon", full: "Monday", offset: 0 },
  { label: "Tue", full: "Tuesday", offset: 1 },
  { label: "Wed", full: "Wednesday", offset: 2 },
  { label: "Thu", full: "Thursday", offset: 3 },
  { label: "Fri", full: "Friday", offset: 4 }
];

const REMINDERS = [
  "Drink water and take a quick stretch break.",
  "Keep notes short, clear, and audit-friendly.",
  "Double-check fail logic before marking the row done.",
  "Take a 2-minute eye break after a long QA block.",
  "Update counts daily so Friday stays light."
];

let state = {
  user: null,
  allowedUser: null,
  currentQaMember: null,
  isAdmin: false,
  workstreams: [],
  activeWorkstreamId: null,
  weeklySettings: [],
  assignments: [],
  agents: [],
  qaMembers: [],
  absences: [],
  transfers: [],
  currentWeekStart: getMonday(new Date()),
  searchTerm: "",
  qaFilter: "all",
  historyWeek: "",
  historyRows: [],
  historySettings: [],
  historyWeeks: [],
  personalMetrics: { wtd: 0, mtd: 0, ytd: 0 },
  clockTimer: null,
  realtimeChannel: null
};

function dateOnly(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function today() {
  return dateOnly(new Date());
}

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return dateOnly(d);
}

function addDays(dateString, days) {
  const d = new Date(`${dateString}T00:00:00`);
  d.setDate(d.getDate() + days);
  return dateOnly(d);
}

function formatFriendlyDate(dateString) {
  const d = new Date(`${dateString}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function monthStart() {
  const d = new Date();
  return dateOnly(new Date(d.getFullYear(), d.getMonth(), 1));
}

function yearStart() {
  const d = new Date();
  return dateOnly(new Date(d.getFullYear(), 0, 1));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showError(message) {
  const error = document.querySelector(".error");
  if (error) {
    error.style.display = "block";
    error.textContent = message;
  } else {
    alert(message);
  }
}

function deterministicHash(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function seededSort(items, seed) {
  return [...items].sort((a, b) => {
    const ha = deterministicHash(`${seed}:${a.id || a.name}`);
    const hb = deterministicHash(`${seed}:${b.id || b.name}`);
    return ha - hb;
  });
}

function reminderForToday() {
  const index = deterministicHash(today()) % REMINDERS.length;
  return REMINDERS[index];
}

async function init() {
  const { data } = await supabaseClient.auth.getSession();
  state.user = data.session?.user || null;

  if (!state.user) {
    renderLogin();
    return;
  }

  await loadAppData();
}

function renderLogin() {
  document.body.classList.remove("admin");
  app.innerHTML = `
    <div class="auth-card">
      <div class="brand-mark">✓</div>
      <h1>Weekly QA Counter</h1>
      <p>Sign in to view your assigned agents and weekly QA progress.</p>
      <div class="error"></div>
      <form id="loginForm" class="form-stack">
        <input id="email" type="email" placeholder="Email" autocomplete="email" required />
        <input id="password" type="password" placeholder="Password" autocomplete="current-password" required />
        <button type="submit">Sign in</button>
      </form>
    </div>
  `;

  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      showError(error.message);
      return;
    }

    state.user = data.user;
    await loadAppData();
  });
}

async function signOut() {
  await supabaseClient.auth.signOut();
  if (state.clockTimer) clearInterval(state.clockTimer);
  if (state.realtimeChannel) await supabaseClient.removeChannel(state.realtimeChannel);
  state.user = null;
  renderLogin();
}

function renderLoading() {
  app.innerHTML = `
    <div class="auth-card">
      <div class="brand-mark">✓</div>
      <h1>Weekly QA Counter</h1>
      <p>Loading your dashboard...</p>
    </div>
  `;
}

async function loadAppData() {
  renderLoading();

  const accessCheck = await supabaseClient
    .from("allowed_users")
    .select("*")
    .ilike("email", state.user.email)
    .maybeSingle();

  if (accessCheck.error || !accessCheck.data) {
    await supabaseClient.auth.signOut();
    app.innerHTML = `
      <div class="auth-card">
        <div class="brand-mark">!</div>
        <h1>Access not allowed</h1>
        <p>Your email is not added to the allowed users list.</p>
        <button onclick="location.reload()" style="margin-top:16px;">Try again</button>
      </div>
    `;
    return;
  }

  state.allowedUser = accessCheck.data;
  state.isAdmin =
    String(accessCheck.data.role || "").toLowerCase() === "admin" ||
    String(accessCheck.data.email || "").toLowerCase() === "admin@admin.com";

  document.body.classList.toggle("admin", state.isAdmin);

  await ensureCurrentWeekExists();
  await processReturningAuditors();
  await refreshData();

  if (!state.activeWorkstreamId && state.workstreams.length) {
    state.activeWorkstreamId = state.workstreams[0].id;
  }

  await loadHistoryWeeks();
  if (!state.historyWeek && state.historyWeeks.length) {
    const previous = state.historyWeeks.find((w) => w.week_start !== state.currentWeekStart);
    state.historyWeek = previous?.week_start || state.historyWeeks[0]?.week_start || "";
  }
  await loadHistoryRows();
  await loadPersonalMetrics();

  renderDashboard();
  subscribeRealtime();
  startClock();
}

function findCurrentQaMember() {
  if (state.isAdmin) return null;
  const allowedName = String(state.allowedUser?.name || "").trim().toLowerCase();
  const emailName = String(state.user?.email || "").split("@")[0].trim().toLowerCase();

  return (
    state.qaMembers.find((m) => String(m.name).trim().toLowerCase() === allowedName) ||
    state.qaMembers.find((m) => String(m.name).trim().toLowerCase() === emailName) ||
    null
  );
}

async function refreshData() {
  const [workstreams, qaMembers, agents, weeklySettings, assignments, absences, transfers] =
    await Promise.all([
      supabaseClient.from("workstreams").select("*").eq("is_active", true).order("name"),
      supabaseClient.from("qa_members").select("*").eq("is_active", true).order("name"),
      supabaseClient.from("agents").select("*, workstreams(name)").eq("is_active", true).order("name"),
      supabaseClient.from("weekly_settings").select("*").eq("week_start", state.currentWeekStart),
      supabaseClient
        .from("weekly_assignments")
        .select(`
          *,
          qa_members(*),
          agents(*),
          workstreams(*),
          qa_counts(*),
          fail_counts(*)
        `)
        .eq("week_start", state.currentWeekStart)
        .order("created_at"),
      supabaseClient
        .from("auditor_absences")
        .select("*")
        .eq("status", "active")
        .order("created_at", { ascending: false }),
      supabaseClient
        .from("assignment_transfers")
        .select("*")
    ]);

  const errors = [workstreams, qaMembers, agents, weeklySettings, assignments, absences, transfers]
    .filter((r) => r.error)
    .map((r) => r.error.message);

  if (errors.length) {
    app.innerHTML = `<div class="auth-card"><h1>Error</h1><p>${escapeHtml(errors.join(" | "))}</p><p>Make sure you ran database-upgrade-v2.sql in Supabase.</p></div>`;
    return;
  }

  state.workstreams = workstreams.data || [];
  state.qaMembers = qaMembers.data || [];
  state.agents = agents.data || [];
  state.weeklySettings = weeklySettings.data || [];
  state.assignments = assignments.data || [];
  state.absences = absences.data || [];
  state.transfers = transfers.data || [];
  state.currentQaMember = findCurrentQaMember();
}

async function ensureCurrentWeekExists() {
  const [workstreamsResult, qaMembersResult, agentsResult] = await Promise.all([
    supabaseClient.from("workstreams").select("*").eq("is_active", true),
    supabaseClient.from("qa_members").select("*").eq("is_active", true).order("name"),
    supabaseClient.from("agents").select("*").eq("is_active", true).order("name")
  ]);

  if (workstreamsResult.error || qaMembersResult.error || agentsResult.error) return;

  const workstreams = workstreamsResult.data || [];
  const qaMembers = qaMembersResult.data || [];
  const agents = agentsResult.data || [];

  for (const ws of workstreams) {
    const existing = await supabaseClient
      .from("weekly_settings")
      .select("*")
      .eq("week_start", state.currentWeekStart)
      .eq("workstream_id", ws.id)
      .maybeSingle();

    if (!existing.data) {
      const latest = await supabaseClient
        .from("weekly_settings")
        .select("*")
        .eq("workstream_id", ws.id)
        .lt("week_start", state.currentWeekStart)
        .order("week_start", { ascending: false })
        .limit(1)
        .maybeSingle();

      await supabaseClient.from("weekly_settings").insert({
        week_start: state.currentWeekStart,
        workstream_id: ws.id,
        base_target: latest.data?.base_target ?? 5,
        extra_if_fail: latest.data?.extra_if_fail ?? 2
      });
    }
  }

  const currentAssignments = await supabaseClient
    .from("weekly_assignments")
    .select("id")
    .eq("week_start", state.currentWeekStart)
    .limit(1);

  if ((currentAssignments.data || []).length > 0) return;

  const latestWeek = await supabaseClient
    .from("weekly_assignments")
    .select("week_start")
    .lt("week_start", state.currentWeekStart)
    .order("week_start", { ascending: false })
    .limit(1)
    .maybeSingle();

  const previousMap = new Map();

  if (latestWeek.data?.week_start) {
    const previousAssignments = await supabaseClient
      .from("weekly_assignments")
      .select("*")
      .eq("week_start", latestWeek.data.week_start);

    for (const row of previousAssignments.data || []) {
      previousMap.set(`${row.workstream_id}:${row.agent_id}`, row.qa_member_id);
    }
  }

  const rows = [];

  for (const ws of workstreams) {
    const wsAgents = agents.filter((a) => a.workstream_id === ws.id);
    if (!wsAgents.length || !qaMembers.length) continue;

    const shuffledAgents = seededSort(wsAgents, `${state.currentWeekStart}:${ws.id}`);
    const shuffledQas = seededSort(qaMembers, `${state.currentWeekStart}:qa:${ws.id}`);
    const startOffset = deterministicHash(`${state.currentWeekStart}:${ws.id}:offset`) % shuffledQas.length;

    shuffledAgents.forEach((agent, index) => {
      let qa = shuffledQas[(index + startOffset) % shuffledQas.length];
      const previousQaId = previousMap.get(`${ws.id}:${agent.id}`);

      if (shuffledQas.length > 1 && previousQaId === qa.id) {
        qa = shuffledQas[(index + startOffset + 1) % shuffledQas.length];
      }

      rows.push({
        week_start: state.currentWeekStart,
        qa_member_id: qa.id,
        agent_id: agent.id,
        workstream_id: ws.id
      });
    });
  }

  if (rows.length) {
    await supabaseClient.from("weekly_assignments").insert(rows);
  }
}

async function processReturningAuditors() {
  const activeAbsences = await supabaseClient
    .from("auditor_absences")
    .select("*")
    .eq("status", "active")
    .lte("return_date", today());

  if (activeAbsences.error || !activeAbsences.data?.length) return;

  for (const absence of activeAbsences.data) {
    const transferResult = await supabaseClient
      .from("assignment_transfers")
      .select("*")
      .eq("absence_id", absence.id);

    for (const transfer of transferResult.data || []) {
      await supabaseClient
        .from("weekly_assignments")
        .update({ qa_member_id: transfer.original_qa_member_id })
        .eq("id", transfer.assignment_id);
    }

    await supabaseClient
      .from("auditor_absences")
      .update({ status: "completed", updated_at: new Date().toISOString() })
      .eq("id", absence.id);
  }
}

async function applyAbsence(qaMemberId, leaveType, returnDate) {
  if (!state.isAdmin) return;
  if (!qaMemberId || !leaveType || !returnDate) {
    alert("Select auditor, leave type, and return date.");
    return;
  }

  if (returnDate <= today()) {
    alert("Return date must be after today.");
    return;
  }

  const coveringQa = state.qaMembers.find((m) => m.id !== qaMemberId);
  if (!coveringQa) {
    alert("No other auditor found to cover this leave.");
    return;
  }

  const absenceInsert = await supabaseClient
    .from("auditor_absences")
    .insert({
      qa_member_id: qaMemberId,
      covering_qa_member_id: coveringQa.id,
      leave_type: leaveType,
      start_date: today(),
      return_date: returnDate,
      status: "active"
    })
    .select()
    .single();

  if (absenceInsert.error) {
    alert(absenceInsert.error.message);
    return;
  }

  const assignments = state.assignments.filter((a) => a.qa_member_id === qaMemberId);

  for (const assignment of assignments) {
    await supabaseClient.from("assignment_transfers").insert({
      absence_id: absenceInsert.data.id,
      assignment_id: assignment.id,
      original_qa_member_id: qaMemberId,
      covering_qa_member_id: coveringQa.id
    });

    await supabaseClient
      .from("weekly_assignments")
      .update({ qa_member_id: coveringQa.id })
      .eq("id", assignment.id);
  }

  await refreshData();
  await loadPersonalMetrics();
  renderDashboard();
}

async function cancelAbsence(absenceId) {
  if (!state.isAdmin) return;
  const yes = confirm("Cancel this leave and restore transferred agents?");
  if (!yes) return;

  const transfers = await supabaseClient
    .from("assignment_transfers")
    .select("*")
    .eq("absence_id", absenceId);

  for (const transfer of transfers.data || []) {
    await supabaseClient
      .from("weekly_assignments")
      .update({ qa_member_id: transfer.original_qa_member_id })
      .eq("id", transfer.assignment_id);
  }

  await supabaseClient
    .from("auditor_absences")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", absenceId);

  await refreshData();
  await loadPersonalMetrics();
  renderDashboard();
}

async function shuffleThisWeek() {
  if (!state.isAdmin) return;
  const yes = confirm("This removes current week assignments and counts/fails, then shuffles active agents again. Continue?");
  if (!yes) return;

  const rowsToDelete = state.assignments
    .filter((a) => a.week_start === state.currentWeekStart)
    .map((a) => a.id);

  if (rowsToDelete.length) {
    await supabaseClient.from("weekly_assignments").delete().in("id", rowsToDelete);
  }

  await ensureCurrentWeekExists();
  await refreshData();
  await loadPersonalMetrics();
  renderDashboard();
}

function getSetting(workstreamId, settings = state.weeklySettings) {
  return (
    settings.find((s) => s.workstream_id === workstreamId) || {
      base_target: 5,
      extra_if_fail: 2
    }
  );
}

function getAssignmentStats(assignment, settings = state.weeklySettings) {
  const setting = getSetting(assignment.workstream_id, settings);
  const failCount = Number(assignment.fail_counts?.[0]?.fail_count || 0);
  const total = (assignment.qa_counts || []).reduce(
    (sum, item) => sum + Number(item.count || 0),
    0
  );

  const target =
    Number(setting.base_target || 0) +
    (failCount >= 1 ? Number(setting.extra_if_fail || 0) : 0);

  const left = Math.max(target - total, 0);
  const done = total >= target;

  return { failCount, total, target, left, done };
}

function getDayCount(assignment, offset) {
  const qaDate = addDays(state.currentWeekStart, offset);
  const row = (assignment.qa_counts || []).find((c) => c.qa_date === qaDate);
  return Number(row?.count || 0);
}

function activeWorkstream() {
  return state.workstreams.find((w) => w.id === state.activeWorkstreamId) || state.workstreams[0];
}

function visibleAssignments() {
  let rows = state.assignments;

  if (state.activeWorkstreamId) {
    rows = rows.filter((a) => a.workstream_id === state.activeWorkstreamId);
  }

  if (!state.isAdmin) {
    if (!state.currentQaMember) return [];
    rows = rows.filter((a) => a.qa_member_id === state.currentQaMember.id);
  }

  if (state.qaFilter !== "all") {
    rows = rows.filter((a) => a.qa_member_id === state.qaFilter);
  }

  if (state.searchTerm.trim()) {
    const term = state.searchTerm.trim().toLowerCase();
    rows = rows.filter((a) => {
      return (
        String(a.agents?.name || "").toLowerCase().includes(term) ||
        String(a.qa_members?.name || "").toLowerCase().includes(term) ||
        String(a.workstreams?.name || "").toLowerCase().includes(term)
      );
    });
  }

  return [...rows].sort((a, b) => {
    const qaCompare = String(a.qa_members?.name || "").localeCompare(String(b.qa_members?.name || ""));
    if (qaCompare !== 0) return qaCompare;
    return String(a.agents?.name || "").localeCompare(String(b.agents?.name || ""));
  });
}

function dashboardTotals(rows = visibleAssignments()) {
  let total = 0;
  let left = 0;
  let fail = 0;
  let done = 0;
  let target = 0;

  for (const row of rows) {
    const stats = getAssignmentStats(row);
    total += stats.total;
    left += stats.left;
    fail += stats.failCount;
    target += stats.target;
    if (stats.done) done += 1;
  }

  return { total, left, fail, done, agents: rows.length, target };
}

function allWorkstreamTotals() {
  const rows = state.isAdmin ? state.assignments.filter((a) => a.workstream_id === state.activeWorkstreamId) : visibleAssignments();
  const byQa = {};

  for (const row of rows) {
    const name = row.qa_members?.name || "Unknown";
    if (!byQa[name]) byQa[name] = { total: 0, fail: 0, left: 0, done: 0, agents: 0 };
    const stats = getAssignmentStats(row);
    byQa[name].total += stats.total;
    byQa[name].fail += stats.failCount;
    byQa[name].left += stats.left;
    byQa[name].agents += 1;
    if (stats.done) byQa[name].done += 1;
  }

  return byQa;
}

async function loadPersonalMetrics() {
  const qaMemberId = state.isAdmin ? null : state.currentQaMember?.id;

  const startDates = {
    wtd: state.currentWeekStart,
    mtd: monthStart(),
    ytd: yearStart()
  };

  const metrics = { wtd: 0, mtd: 0, ytd: 0 };

  for (const [key, startDate] of Object.entries(startDates)) {
    let query = supabaseClient
      .from("qa_count_logs")
      .select("count_delta, performed_by_qa_member_id, qa_date")
      .gte("qa_date", startDate)
      .lte("qa_date", today());

    if (qaMemberId) {
      query = query.eq("performed_by_qa_member_id", qaMemberId);
    }

    const result = await query;
    if (!result.error) {
      metrics[key] = (result.data || []).reduce((sum, row) => sum + Number(row.count_delta || 0), 0);
    }
  }

  state.personalMetrics = metrics;
}

async function loadHistoryWeeks() {
  const result = await supabaseClient
    .from("weekly_assignments")
    .select("week_start")
    .order("week_start", { ascending: false });

  if (result.error) return;

  const unique = [...new Set((result.data || []).map((r) => r.week_start))]
    .map((week_start) => ({ week_start }))
    .filter((w) => w.week_start);
  state.historyWeeks = unique;
}

async function loadHistoryRows() {
  if (!state.historyWeek) {
    state.historyRows = [];
    state.historySettings = [];
    return;
  }

  const [rows, settings] = await Promise.all([
    supabaseClient
      .from("weekly_assignments")
      .select(`
        *,
        qa_members(*),
        agents(*),
        workstreams(*),
        qa_counts(*),
        fail_counts(*)
      `)
      .eq("week_start", state.historyWeek),
    supabaseClient
      .from("weekly_settings")
      .select("*")
      .eq("week_start", state.historyWeek)
  ]);

  state.historyRows = rows.data || [];
  state.historySettings = settings.data || [];
}

function renderDashboard() {
  const activeWs = activeWorkstream();

  if (!activeWs) {
    app.innerHTML = `<div class="auth-card"><h1>No workstreams found</h1></div>`;
    return;
  }

  state.activeWorkstreamId = activeWs.id;

  const rows = visibleAssignments();
  const setting = getSetting(activeWs.id);
  const totals = dashboardTotals(rows);

  app.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <div class="header-content">
          <div class="brand-line">
            <div class="logo-box">✓</div>
            <div class="title-block">
              <h1>Weekly QA Counter</h1>
              <p>Week of ${escapeHtml(formatFriendlyDate(state.currentWeekStart))} • ${escapeHtml(state.user.email)}</p>
            </div>
          </div>

          <div class="header-actions">
            <div class="clock-card">
              <strong id="liveClock">--:--</strong>
              <span id="liveDate">Loading date</span>
            </div>
            <div class="reminder-card">
              <strong>Quick reminder</strong>
              <span>${escapeHtml(reminderForToday())}</span>
            </div>
            <button class="icon-btn" id="refreshBtn">↻ Refresh</button>
            <button class="danger icon-btn" id="signOutBtn">⎋ Sign out</button>
          </div>
        </div>

        <div class="tabs-row">
          <div class="tabs">
            ${state.workstreams.map((w) => `
              <button class="tab ${w.id === activeWs.id ? "active" : ""}" data-workstream="${w.id}">
                ${w.name === "T2 Privacy - Pilot" ? "🧪" : "🔒"} ${escapeHtml(w.name)}
              </button>
            `).join("")}
          </div>
          <div class="role-chip">${state.isAdmin ? "Admin view: all QA data" : `QA view: ${escapeHtml(state.currentQaMember?.name || "Not mapped")}`}</div>
        </div>
      </header>

      <section class="stats-grid">
        ${statCard("📌", "Total completed", totals.total, "Current visible table")}
        ${statCard("🎯", "Weekly target", totals.target, "After fail adjustment")}
        ${statCard("⏳", "Tickets left", totals.left, "Remaining this week")}
        ${statCard("⚠️", "Failed cases", totals.fail, "Current week")}
        ${statCard("📅", "MTD QA", state.personalMetrics.mtd, state.isAdmin ? "All auditors" : "Your completed count")}
        ${statCard("🗓️", "YTD QA", state.personalMetrics.ytd, state.isAdmin ? "All auditors" : "Your completed count")}
      </section>

      <main class="dashboard-grid">
        <div>
          <section class="panel">
            <div class="panel-header">
              <div>
                <h2>${escapeHtml(activeWs.name)}</h2>
                <p>${state.isAdmin ? "Showing all assigned agents." : "Showing only your assigned agents."}</p>
              </div>
              <span class="workstream-badge">${activeWs.name === "T2 Privacy - Pilot" ? "Pilot" : "Privacy"}</span>
            </div>

            <div class="notice">
              Base target: <strong>${setting.base_target}</strong>. If fail count is 1 or more, target becomes <strong>${Number(setting.base_target) + Number(setting.extra_if_fail)}</strong>. Extra QA is added only once, not per fail.
            </div>

            ${renderToolbar()}
            ${renderTable(rows)}
          </section>

          ${renderHistorySection()}
        </div>

        <aside class="side-stack">
          ${renderUserNote()}
          ${renderReports()}
          ${renderLeaveManager()}
          ${renderSettings(activeWs, setting)}
          ${renderAssignmentEditor(activeWs)}
          ${renderAgentManager(activeWs)}
        </aside>
      </main>

      <footer class="footer">
        <span>Weekly QA Counter • New week starts every Monday, while history stays saved.</span>
        <span>Do not store ticket details, customer info, or sensitive case content here.</span>
      </footer>
    </div>
  `;

  bindDashboardEvents();
  updateClock();
}

function statCard(icon, label, value, sub = "") {
  return `
    <div class="stat-card">
      <div class="stat-icon">${icon}</div>
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(value)}</div>
      ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ""}
    </div>
  `;
}

function renderUserNote() {
  if (state.isAdmin) return "";
  return `
    <section class="side-section user-only-note">
      <h3>👋 Your workspace</h3>
      <p>You are seeing only agents assigned to <strong>${escapeHtml(state.currentQaMember?.name || "your QA profile")}</strong>. Admin can view all data and reports.</p>
    </section>
  `;
}

function renderToolbar() {
  return `
    <div class="table-toolbar">
      <div class="toolbar-left">
        <input class="search-input" id="searchBox" placeholder="Search agent or QA..." value="${escapeHtml(state.searchTerm)}" />
        <select id="qaFilter" class="${state.isAdmin ? "" : "admin-only"}">
          <option value="all">All QAs</option>
          ${state.qaMembers.map((qa) => `
            <option value="${qa.id}" ${state.qaFilter === qa.id ? "selected" : ""}>${escapeHtml(qa.name)}</option>
          `).join("")}
        </select>
      </div>
      <div class="toolbar-left admin-only">
        <button class="secondary icon-btn" id="shuffleBtn">🔀 Shuffle this week</button>
      </div>
    </div>
  `;
}

function renderTable(rows) {
  if (!rows.length) {
    return `
      <div class="empty-state">
        <strong>No assigned agents found</strong>
        Check the selected workstream, search, or admin assignments.
      </div>
    `;
  }

  const body = rows.map((a) => {
    const stats = getAssignmentStats(a);
    const statusClass = stats.done ? "status-done" : stats.left <= 2 ? "status-risk" : "status-pending";
    const statusText = stats.done ? "Done" : stats.left <= 2 ? "Almost" : "Pending";

    return `
      <tr class="${stats.done ? "done" : ""}">
        <td class="name-cell">
          ${escapeHtml(a.agents?.name)}
          <span class="agent-sub">${escapeHtml(a.workstreams?.name || "")}</span>
        </td>
        <td><span class="qa-badge">👤 ${escapeHtml(a.qa_members?.name)}</span></td>
        ${DAYS.map((day) => `
          <td class="day-col">
            <div class="count-control">
              <button type="button" class="small secondary js-action" data-action="dec-count" data-assignment="${a.id}" data-date="${addDays(state.currentWeekStart, day.offset)}">−</button>
              <span class="count-number">${getDayCount(a, day.offset)}</span>
              <button type="button" class="small js-action" data-action="inc-count" data-assignment="${a.id}" data-date="${addDays(state.currentWeekStart, day.offset)}">+</button>
            </div>
          </td>
        `).join("")}
        <td class="metric-strong">${stats.total}</td>
        <td>
          <div class="count-control">
            <button type="button" class="small secondary js-action" data-action="dec-fail" data-assignment="${a.id}">−</button>
            <span class="count-number">${stats.failCount}</span>
            <button type="button" class="small js-action" data-action="inc-fail" data-assignment="${a.id}">+</button>
          </div>
        </td>
        <td class="metric-strong">${stats.target}</td>
        <td class="metric-strong">${stats.left}</td>
        <td><span class="status-pill ${statusClass}">${statusText}</span></td>
      </tr>
    `;
  }).join("");

  return `
    <div class="table-wrap">
      <table class="qa-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>QA</th>
            ${DAYS.map((d) => `<th>${d.label}</th>`).join("")}
            <th>Total</th>
            <th>Fail</th>
            <th>Target</th>
            <th>Left</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function renderReports() {
  const byQa = allWorkstreamTotals();

  return `
    <section class="side-section">
      <h3>📊 Weekly report</h3>
      <p>${state.isAdmin ? "Admin summary for the selected workstream." : "Your weekly summary."}</p>
      <div class="report-list">
        ${Object.keys(byQa).length ? Object.entries(byQa).map(([name, item]) => `
          <div class="mini-card report-card">
            <div>
              <strong>${escapeHtml(name)}</strong>
              <span>${item.done}/${item.agents} agents done • ${item.fail} fails • ${item.left} left</span>
            </div>
            <div class="report-number">${item.total}</div>
          </div>
        `).join("") : `<div class="mini-card">No report data yet.</div>`}
      </div>
    </section>
  `;
}

function renderLeaveManager() {
  if (!state.isAdmin) return "";

  const active = state.absences.filter((a) => a.status === "active");
  return `
    <section class="side-section admin-only">
      <h3>🌴 Vacation / PTO / Sick</h3>
      <p>When an auditor is marked away, their current assigned agents move to the other auditor. Existing QA counts stay with the agent.</p>

      <div class="leave-list">
        ${state.qaMembers.map((qa) => {
          const absence = active.find((a) => a.qa_member_id === qa.id);
          const activeClass = absence ? "active" : "";
          return `
            <div class="leave-card ${activeClass}">
              <div class="leave-grid">
                <label class="check-row">
                  <input type="checkbox" class="leave-toggle" data-qa="${qa.id}" ${absence ? "checked" : ""} />
                  <span>${escapeHtml(qa.name)}</span>
                  ${absence ? `<span class="leave-pill">${escapeHtml(absence.leave_type)} until ${escapeHtml(formatFriendlyDate(absence.return_date))}</span>` : ""}
                </label>
                <div class="leave-fields">
                  <select class="leave-type" data-qa="${qa.id}">
                    <option value="Vacation">Vacation</option>
                    <option value="PTO">PTO</option>
                    <option value="Sick">Sick</option>
                  </select>
                  <input type="date" class="leave-return" data-qa="${qa.id}" min="${addDays(today(), 1)}" />
                </div>
                ${absence ? `<button type="button" class="secondary js-action" data-action="cancel-absence" data-absence="${absence.id}">Restore / cancel leave</button>` : `<button type="button" class="js-action" data-action="apply-absence" data-qa="${qa.id}">Apply leave</button>`}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderSettings(activeWs, setting) {
  return `
    <section class="side-section admin-only">
      <h3>⚙️ Weekly settings</h3>
      <form id="settingsForm" class="side-form">
        <label>
          Weekly QA target
          <input id="baseTarget" type="number" min="0" value="${escapeHtml(setting.base_target)}" />
        </label>
        <label>
          Extra QA if 1+ fail
          <input id="extraIfFail" type="number" min="0" value="${escapeHtml(setting.extra_if_fail)}" />
        </label>
        <button type="submit">Save settings</button>
      </form>
    </section>
  `;
}

function renderAssignmentEditor(activeWs) {
  if (!state.isAdmin) return "";

  const assignedAgentIds = new Set(
    state.assignments
      .filter((a) => a.workstream_id === activeWs.id)
      .map((a) => a.agent_id)
  );

  const agents = state.agents.filter((a) => a.workstream_id === activeWs.id);

  const unassignedOptions = agents
    .filter((a) => !assignedAgentIds.has(a.id))
    .map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`)
    .join("");

  const rows = state.assignments
    .filter((a) => a.workstream_id === activeWs.id)
    .sort((a, b) => String(a.agents?.name || "").localeCompare(String(b.agents?.name || "")))
    .map((a) => `
      <div class="mini-card">
        <div class="mini-card-row">
          <div>
            <strong>${escapeHtml(a.agents?.name)}</strong>
            <span>Assigned to ${escapeHtml(a.qa_members?.name)}</span>
          </div>
          <select class="js-change-qa" data-assignment="${a.id}">
            ${state.qaMembers.map((qa) => `
              <option value="${qa.id}" ${qa.id === a.qa_member_id ? "selected" : ""}>${escapeHtml(qa.name)}</option>
            `).join("")}
          </select>
        </div>
      </div>
    `).join("");

  return `
    <section class="side-section admin-only">
      <h3>🧩 Assignments</h3>
      <p>Move agents between QAs for this week.</p>

      <form id="assignForm" class="side-form">
        <label>
          Agent
          <select id="assignAgent">
            <option value="">Select unassigned agent</option>
            ${unassignedOptions}
          </select>
        </label>
        <label>
          QA
          <select id="assignQa">
            ${state.qaMembers.map((qa) => `<option value="${qa.id}">${escapeHtml(qa.name)}</option>`).join("")}
          </select>
        </label>
        <button type="submit">Assign agent</button>
      </form>

      <div class="assign-list" style="margin-top:12px;">${rows}</div>
    </section>
  `;
}

function renderAgentManager(activeWs) {
  if (!state.isAdmin) return "";

  const agents = state.agents.filter((a) => a.workstream_id === activeWs.id);

  return `
    <section class="side-section admin-only">
      <h3>👥 Agents</h3>
      <form id="addAgentForm" class="side-form">
        <label>
          New agent name
          <input id="newAgentName" placeholder="Example: Sagar" />
        </label>
        <button type="submit">Add agent</button>
      </form>

      <div class="agent-list" style="margin-top:12px;">
        ${agents.map((a) => `
          <div class="mini-card">
            <div class="mini-card-row">
              <div>
                <strong>${escapeHtml(a.name)}</strong>
                <span>${escapeHtml(activeWs.name)}</span>
              </div>
              <button type="button" class="small secondary js-action" data-action="toggle-agent" data-agent="${a.id}">Hide</button>
            </div>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderHistorySection() {
  const rows = state.historyRows
    .filter((r) => r.workstream_id === state.activeWorkstreamId)
    .filter((r) => state.isAdmin || !state.currentQaMember || r.qa_member_id === state.currentQaMember.id);

  let total = 0, target = 0, fail = 0, done = 0;
  for (const row of rows) {
    const stats = getAssignmentStats(row, state.historySettings);
    total += stats.total;
    target += stats.target;
    fail += stats.failCount;
    if (stats.done) done += 1;
  }

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>📚 Previous week summary</h2>
          <p>Select any saved week and review the final summary below the live tracker.</p>
        </div>
      </div>

      <div class="history-grid">
        <div class="side-section">
          <h3>Choose week</h3>
          <select id="historyWeekSelect">
            ${state.historyWeeks.map((w) => `
              <option value="${w.week_start}" ${state.historyWeek === w.week_start ? "selected" : ""}>
                Week of ${escapeHtml(formatFriendlyDate(w.week_start))}
              </option>
            `).join("")}
          </select>
        </div>

        <div>
          <div class="history-summary">
            <div class="history-card"><span>Completed</span><strong>${total}</strong></div>
            <div class="history-card"><span>Target</span><strong>${target}</strong></div>
            <div class="history-card"><span>Fails</span><strong>${fail}</strong></div>
            <div class="history-card"><span>Agents done</span><strong>${done}/${rows.length}</strong></div>
          </div>

          ${renderHistoryTable(rows)}
        </div>
      </div>
    </section>
  `;
}

function renderHistoryTable(rows) {
  if (!rows.length) {
    return `<div class="empty-state"><strong>No previous data found</strong>Select another week or wait until more weekly data is saved.</div>`;
  }

  return `
    <div class="table-wrap">
      <table class="qa-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>QA</th>
            <th>Total</th>
            <th>Fail</th>
            <th>Target</th>
            <th>Left</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => {
            const stats = getAssignmentStats(row, state.historySettings);
            return `
              <tr class="${stats.done ? "done" : ""}">
                <td class="name-cell">${escapeHtml(row.agents?.name)}<span class="agent-sub">${escapeHtml(row.workstreams?.name || "")}</span></td>
                <td><span class="qa-badge">👤 ${escapeHtml(row.qa_members?.name)}</span></td>
                <td class="metric-strong">${stats.total}</td>
                <td class="metric-strong">${stats.failCount}</td>
                <td class="metric-strong">${stats.target}</td>
                <td class="metric-strong">${stats.left}</td>
                <td><span class="status-pill ${stats.done ? "status-done" : "status-pending"}">${stats.done ? "Done" : "Pending"}</span></td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function bindDashboardEvents() {
  document.getElementById("signOutBtn")?.addEventListener("click", signOut);

  document.getElementById("refreshBtn")?.addEventListener("click", async () => {
    await refreshData();
    await loadHistoryWeeks();
    await loadHistoryRows();
    await loadPersonalMetrics();
    renderDashboard();
  });

  document.getElementById("shuffleBtn")?.addEventListener("click", shuffleThisWeek);

  document.querySelectorAll("[data-workstream]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeWorkstreamId = button.dataset.workstream;
      state.searchTerm = "";
      state.qaFilter = "all";
      renderDashboard();
    });
  });

  app.querySelectorAll(".js-action").forEach((button) => {
    button.addEventListener("click", handleActionClick);
  });

  app.querySelectorAll(".js-change-qa").forEach((select) => {
    select.addEventListener("change", handleActionChange);
  });

  app.querySelectorAll(".leave-toggle").forEach((box) => {
    box.addEventListener("change", (e) => {
      const card = e.target.closest(".leave-card");
      if (e.target.checked) card.classList.add("active");
      else card.classList.remove("active");
    });
  });

  document.getElementById("settingsForm")?.addEventListener("submit", saveSettings);
  document.getElementById("assignForm")?.addEventListener("submit", assignAgent);
  document.getElementById("addAgentForm")?.addEventListener("submit", addAgent);

  document.getElementById("searchBox")?.addEventListener("input", (e) => {
    state.searchTerm = e.target.value;
    renderDashboard();
  });

  document.getElementById("qaFilter")?.addEventListener("change", (e) => {
    state.qaFilter = e.target.value;
    renderDashboard();
  });

  document.getElementById("historyWeekSelect")?.addEventListener("change", async (e) => {
    state.historyWeek = e.target.value;
    await loadHistoryRows();
    renderDashboard();
  });
}

async function handleActionClick(e) {
  const button = e.currentTarget;
  const action = button.dataset.action;
  const assignmentId = button.dataset.assignment;

  button.disabled = true;

  try {
    if (action === "inc-count" || action === "dec-count") {
      const qaDate = button.dataset.date;
      const delta = action === "inc-count" ? 1 : -1;
      await changeDailyCount(assignmentId, qaDate, delta);
    }

    if (action === "inc-fail" || action === "dec-fail") {
      const delta = action === "inc-fail" ? 1 : -1;
      await changeFailCount(assignmentId, delta);
    }

    if (action === "toggle-agent") {
      const yes = confirm("Hide this agent from future active lists?");
      if (yes) {
        const result = await supabaseClient.from("agents").update({ is_active: false }).eq("id", button.dataset.agent);
        if (result.error) alert(result.error.message);
        await refreshData();
        await loadPersonalMetrics();
        renderDashboard();
      }
    }

    if (action === "apply-absence") {
      const qaId = button.dataset.qa;
      const card = button.closest(".leave-card");
      const leaveType = card.querySelector(".leave-type")?.value;
      const returnDate = card.querySelector(".leave-return")?.value;
      await applyAbsence(qaId, leaveType, returnDate);
    }

    if (action === "cancel-absence") {
      await cancelAbsence(button.dataset.absence);
    }
  } finally {
    button.disabled = false;
  }
}

async function handleActionChange(e) {
  const select = e.currentTarget;

  const result = await supabaseClient
    .from("weekly_assignments")
    .update({ qa_member_id: select.value })
    .eq("id", select.dataset.assignment);

  if (result.error) alert(result.error.message);

  await refreshData();
  await loadPersonalMetrics();
  renderDashboard();
}

async function getAssignment(assignmentId) {
  const existing = state.assignments.find((a) => a.id === assignmentId);
  if (existing) return existing;

  const result = await supabaseClient
    .from("weekly_assignments")
    .select("*")
    .eq("id", assignmentId)
    .maybeSingle();

  return result.data;
}

async function changeDailyCount(assignmentId, qaDate, delta) {
  if (!assignmentId || !qaDate) return;

  const assignment = await getAssignment(assignmentId);
  if (!assignment) return;

  const performerQaId = state.isAdmin ? assignment.qa_member_id : state.currentQaMember?.id;
  if (!performerQaId) {
    alert("Could not identify QA member for this count.");
    return;
  }

  const existing = await supabaseClient
    .from("qa_counts")
    .select("*")
    .eq("assignment_id", assignmentId)
    .eq("qa_date", qaDate)
    .maybeSingle();

  if (existing.error) {
    alert(existing.error.message);
    return;
  }

  const currentCount = Number(existing.data?.count || 0);
  const newCount = Math.max(currentCount + delta, 0);
  const appliedDelta = newCount - currentCount;

  if (appliedDelta === 0) return;

  if (existing.data) {
    const result = await supabaseClient
      .from("qa_counts")
      .update({ count: newCount, updated_at: new Date().toISOString() })
      .eq("id", existing.data.id);

    if (result.error) {
      alert(result.error.message);
      return;
    }
  } else if (newCount > 0) {
    const result = await supabaseClient.from("qa_counts").insert({
      assignment_id: assignmentId,
      qa_date: qaDate,
      count: newCount
    });

    if (result.error) {
      alert(result.error.message);
      return;
    }
  }

  const logResult = await supabaseClient.from("qa_count_logs").insert({
    assignment_id: assignmentId,
    qa_date: qaDate,
    performed_by_qa_member_id: performerQaId,
    count_delta: appliedDelta
  });

  if (logResult.error) {
    alert(logResult.error.message);
  }

  await refreshData();
  await loadPersonalMetrics();
  renderDashboard();
}

async function changeFailCount(assignmentId, delta) {
  if (!assignmentId) return;

  const existing = await supabaseClient
    .from("fail_counts")
    .select("*")
    .eq("assignment_id", assignmentId)
    .maybeSingle();

  if (existing.error) {
    alert(existing.error.message);
    return;
  }

  const currentCount = Number(existing.data?.fail_count || 0);
  const newCount = Math.max(currentCount + delta, 0);

  if (newCount === currentCount) return;

  if (existing.data) {
    const result = await supabaseClient
      .from("fail_counts")
      .update({ fail_count: newCount, updated_at: new Date().toISOString() })
      .eq("id", existing.data.id);

    if (result.error) {
      alert(result.error.message);
      return;
    }
  } else if (newCount > 0) {
    const result = await supabaseClient.from("fail_counts").insert({
      assignment_id: assignmentId,
      fail_count: newCount
    });

    if (result.error) {
      alert(result.error.message);
      return;
    }
  }

  await refreshData();
  renderDashboard();
}

async function saveSettings(e) {
  e.preventDefault();
  if (!state.isAdmin) return;

  const setting = getSetting(state.activeWorkstreamId);
  const baseTarget = Number(document.getElementById("baseTarget").value || 0);
  const extraIfFail = Number(document.getElementById("extraIfFail").value || 0);

  let result;
  if (setting.id) {
    result = await supabaseClient
      .from("weekly_settings")
      .update({ base_target: baseTarget, extra_if_fail: extraIfFail })
      .eq("id", setting.id);
  } else {
    result = await supabaseClient.from("weekly_settings").insert({
      week_start: state.currentWeekStart,
      workstream_id: state.activeWorkstreamId,
      base_target: baseTarget,
      extra_if_fail: extraIfFail
    });
  }

  if (result.error) alert(result.error.message);

  await refreshData();
  renderDashboard();
}

async function assignAgent(e) {
  e.preventDefault();
  if (!state.isAdmin) return;

  const agentId = document.getElementById("assignAgent").value;
  const qaMemberId = document.getElementById("assignQa").value;

  if (!agentId || !qaMemberId) return;

  const result = await supabaseClient.from("weekly_assignments").insert({
    week_start: state.currentWeekStart,
    agent_id: agentId,
    qa_member_id: qaMemberId,
    workstream_id: state.activeWorkstreamId
  });

  if (result.error) alert(result.error.message);

  await refreshData();
  renderDashboard();
}

async function addAgent(e) {
  e.preventDefault();
  if (!state.isAdmin) return;

  const name = document.getElementById("newAgentName").value.trim();
  if (!name) return;

  const result = await supabaseClient.from("agents").insert({
    name,
    workstream_id: state.activeWorkstreamId,
    is_active: true
  });

  if (result.error) alert(result.error.message);

  await refreshData();
  renderDashboard();
}

function subscribeRealtime() {
  if (state.realtimeChannel) return;

  state.realtimeChannel = supabaseClient
    .channel("qa-counter-v2-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "qa_counts" }, async () => {
      await refreshData(); await loadPersonalMetrics(); renderDashboard();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "fail_counts" }, async () => {
      await refreshData(); renderDashboard();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "weekly_assignments" }, async () => {
      await refreshData(); await loadPersonalMetrics(); renderDashboard();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "weekly_settings" }, async () => {
      await refreshData(); renderDashboard();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "auditor_absences" }, async () => {
      await refreshData(); renderDashboard();
    })
    .subscribe();
}

function updateClock() {
  const clock = document.getElementById("liveClock");
  const date = document.getElementById("liveDate");
  if (!clock || !date) return;

  const now = new Date();
  clock.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  date.textContent = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function startClock() {
  if (state.clockTimer) clearInterval(state.clockTimer);
  updateClock();
  state.clockTimer = setInterval(updateClock, 30000);
}

init();


// ===============================
// Fail selector hotfix - inline
// Build: app-v300-fail-selector
// Replaces Fail +/- with exact buttons: 0, 1, 2, 3+
// Requires Supabase RPC: public.set_fail_count_exact(p_assignment_id uuid, p_fail_count int)
// ===============================
(function () {
  function injectFailSelectorStyle() {
    if (document.getElementById("fail-selector-style")) return;

    const style = document.createElement("style");
    style.id = "fail-selector-style";
    style.textContent = `
      .fail-selector {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px;
        border-radius: 14px;
        background: #f1f5f9;
      }
      .fail-choice {
        min-width: 32px !important;
        min-height: 30px !important;
        padding: 0 8px !important;
        border-radius: 10px !important;
        font-size: 13px !important;
      }
      .fail-choice.active {
        background: #dc2626 !important;
        color: white !important;
        box-shadow: 0 8px 18px rgba(220, 38, 38, .18) !important;
      }
    `;
    document.head.appendChild(style);
  }

  function transformFailControls() {
    injectFailSelectorStyle();

    document.querySelectorAll('button[data-action="inc-fail"]').forEach((incButton) => {
      const control = incButton.closest(".count-control");
      if (!control || control.dataset.failSelectorReady === "true") return;

      const assignmentId = incButton.dataset.assignment;
      if (!assignmentId) return;

      const numberEl = control.querySelector(".count-number");
      const currentValue = Number((numberEl && numberEl.textContent || "0").trim()) || 0;
      const activeValue = currentValue >= 3 ? 3 : currentValue;

      control.classList.remove("count-control");
      control.classList.add("fail-selector");
      control.dataset.failSelectorReady = "true";
      control.innerHTML = [0, 1, 2, 3].map((value) => {
        const label = value === 3 ? "3+" : String(value);
        const active = value === activeValue ? "active" : "";
        return `<button type="button" class="small secondary fail-choice ${active}" data-fail-choice="true" data-assignment="${assignmentId}" data-fail-value="${value}">${label}</button>`;
      }).join("");
    });
  }

  async function setFailCountExact(assignmentId, failValue) {
    if (!assignmentId) return;

    const result = await supabaseClient.rpc("set_fail_count_exact", {
      p_assignment_id: assignmentId,
      p_fail_count: failValue
    });

    if (result.error) {
      alert("Fail update error: " + result.error.message);
      return;
    }

    if (typeof refreshData === "function") {
      await refreshData();
    }

    if (typeof loadPersonalMetrics === "function") {
      await loadPersonalMetrics();
    }

    if (typeof renderDashboard === "function") {
      renderDashboard();
    }

    setTimeout(transformFailControls, 0);
  }

  document.addEventListener("click", async (event) => {
    const button = event.target.closest('button[data-fail-choice="true"]');
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();

    button.disabled = true;

    const assignmentId = button.dataset.assignment;
    const failValue = Number(button.dataset.failValue || "0");

    await setFailCountExact(assignmentId, failValue);

    button.disabled = false;
  }, true);

  const observer = new MutationObserver(() => transformFailControls());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const tryWrapRender = () => {
    if (typeof renderDashboard !== "function" || renderDashboard.__failSelectorWrapped) return;

    const originalRenderDashboard = renderDashboard;
    renderDashboard = function () {
      const result = originalRenderDashboard.apply(this, arguments);
      setTimeout(transformFailControls, 0);
      return result;
    };
    renderDashboard.__failSelectorWrapped = true;
  };

  setInterval(() => {
    tryWrapRender();
    transformFailControls();
  }, 700);

  window.addEventListener("load", () => {
    tryWrapRender();
    transformFailControls();
  });

  console.log("Weekly QA Counter app.js v300 loaded. Fail selector is inline.");
})();
