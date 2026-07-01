const app = document.getElementById("app");

const supabaseClient = supabase.createClient(
  window.SUPABASE_URL,
  window.SUPABASE_ANON_KEY
);

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const DAY_OFFSETS = [0, 1, 2, 3, 4];

let state = {
  user: null,
  allowedUser: null,
  workstreams: [],
  activeWorkstreamId: null,
  weeklySettings: [],
  assignments: [],
  agents: [],
  qaMembers: [],
  currentWeekStart: getMonday(new Date()),
  loading: false
};

function dateOnly(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay(); // Sunday 0, Monday 1
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return dateOnly(d);
}

function addDays(dateString, days) {
  const d = new Date(`${dateString}T00:00:00`);
  d.setDate(d.getDate() + days);
  return dateOnly(d);
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
  app.innerHTML = `
    <div class="center-card">
      <h1>Weekly QA Counter</h1>
      <p>Sign in with the email added in Supabase allowed_users.</p>

      <div class="error"></div>

      <form id="loginForm" class="form-stack">
        <input id="email" type="email" placeholder="Email" required />
        <input id="password" type="password" placeholder="Password" required />
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
  state.user = null;
  renderLogin();
}

async function loadAppData() {
  state.loading = true;
  renderLoading();

  const accessCheck = await supabaseClient
    .from("allowed_users")
    .select("*")
    .eq("email", state.user.email)
    .maybeSingle();

  if (accessCheck.error || !accessCheck.data) {
    await supabaseClient.auth.signOut();
    app.innerHTML = `
      <div class="center-card">
        <h1>Access not allowed</h1>
        <p>Your email is not added to the allowed users list.</p>
        <button onclick="location.reload()">Try again</button>
      </div>
    `;
    return;
  }

  state.allowedUser = accessCheck.data;

  await ensureCurrentWeekExists();
  await refreshData();

  if (!state.activeWorkstreamId && state.workstreams.length) {
    state.activeWorkstreamId = state.workstreams[0].id;
  }

  renderDashboard();
  subscribeRealtime();
}

function renderLoading() {
  app.innerHTML = `
    <div class="center-card">
      <h1>Weekly QA Counter</h1>
      <p>Loading your dashboard...</p>
    </div>
  `;
}

async function refreshData() {
  const [workstreams, qaMembers, agents, weeklySettings, assignments] =
    await Promise.all([
      supabaseClient
        .from("workstreams")
        .select("*")
        .eq("is_active", true)
        .order("name"),
      supabaseClient
        .from("qa_members")
        .select("*")
        .eq("is_active", true)
        .order("name"),
      supabaseClient
        .from("agents")
        .select("*, workstreams(name)")
        .eq("is_active", true)
        .order("name"),
      supabaseClient
        .from("weekly_settings")
        .select("*")
        .eq("week_start", state.currentWeekStart),
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
        .order("created_at")
    ]);

  const errors = [workstreams, qaMembers, agents, weeklySettings, assignments]
    .filter((r) => r.error)
    .map((r) => r.error.message);

  if (errors.length) {
    app.innerHTML = `<div class="center-card"><h1>Error</h1><p>${escapeHtml(errors.join(" | "))}</p></div>`;
    return;
  }

  state.workstreams = workstreams.data || [];
  state.qaMembers = qaMembers.data || [];
  state.agents = agents.data || [];
  state.weeklySettings = weeklySettings.data || [];
  state.assignments = assignments.data || [];
}

async function ensureCurrentWeekExists() {
  const workstreamsResult = await supabaseClient
    .from("workstreams")
    .select("*")
    .eq("is_active", true);

  if (workstreamsResult.error) return;

  for (const ws of workstreamsResult.data || []) {
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

  if ((currentAssignments.data || []).length === 0) {
    const latestWeek = await supabaseClient
      .from("weekly_assignments")
      .select("week_start")
      .lt("week_start", state.currentWeekStart)
      .order("week_start", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestWeek.data?.week_start) {
      const previousAssignments = await supabaseClient
        .from("weekly_assignments")
        .select("*")
        .eq("week_start", latestWeek.data.week_start);

      const rows = (previousAssignments.data || []).map((row) => ({
        week_start: state.currentWeekStart,
        qa_member_id: row.qa_member_id,
        agent_id: row.agent_id,
        workstream_id: row.workstream_id
      }));

      if (rows.length) {
        await supabaseClient.from("weekly_assignments").insert(rows);
      }
    }
  }
}

function getSetting(workstreamId) {
  return (
    state.weeklySettings.find((s) => s.workstream_id === workstreamId) || {
      base_target: 5,
      extra_if_fail: 2
    }
  );
}

function getAssignmentStats(assignment) {
  const setting = getSetting(assignment.workstream_id);
  const failCount = assignment.fail_counts?.[0]?.fail_count ?? 0;
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

function activeAssignments() {
  return state.assignments.filter(
    (a) => a.workstream_id === state.activeWorkstreamId
  );
}

function dashboardTotals() {
  const rows = activeAssignments();
  let total = 0;
  let left = 0;
  let fail = 0;
  let done = 0;

  for (const row of rows) {
    const stats = getAssignmentStats(row);
    total += stats.total;
    left += stats.left;
    fail += stats.failCount;
    if (stats.done) done += 1;
  }

  return { total, left, fail, done, agents: rows.length };
}

function renderDashboard() {
  const activeWs =
    state.workstreams.find((w) => w.id === state.activeWorkstreamId) ||
    state.workstreams[0];

  if (!activeWs) {
    app.innerHTML = `<div class="center-card"><h1>No workstreams found</h1></div>`;
    return;
  }

  state.activeWorkstreamId = activeWs.id;

  const setting = getSetting(activeWs.id);
  const totals = dashboardTotals();

  app.innerHTML = `
    <div class="app-shell">
      <div class="topbar">
        <div class="topbar-main">
          <div class="title-block">
            <h1>Weekly QA Counter</h1>
            <p>Week of ${escapeHtml(state.currentWeekStart)} • Signed in as ${escapeHtml(state.user.email)}</p>
          </div>
          <div>
            <button class="secondary" id="refreshBtn">Refresh</button>
            <button class="danger" id="signOutBtn">Sign out</button>
          </div>
        </div>

        <div class="tabs">
          ${state.workstreams
            .map(
              (w) => `
                <button class="tab ${w.id === activeWs.id ? "active" : ""}" data-workstream="${w.id}">
                  ${escapeHtml(w.name)}
                </button>
              `
            )
            .join("")}
        </div>

        <div class="stat-row">
          <div class="stat-card">
            <div class="label">Total completed</div>
            <div class="value">${totals.total}</div>
          </div>
          <div class="stat-card">
            <div class="label">Tickets left</div>
            <div class="value">${totals.left}</div>
          </div>
          <div class="stat-card">
            <div class="label">Failed cases</div>
            <div class="value">${totals.fail}</div>
          </div>
          <div class="stat-card">
            <div class="label">Agents complete</div>
            <div class="value">${totals.done}/${totals.agents}</div>
          </div>
        </div>
      </div>

      <div class="layout">
        <div class="panel">
          <h2>${escapeHtml(activeWs.name)}</h2>
          <div class="notice">
            Base target: <strong>${setting.base_target}</strong>. If fail count is 1 or more, target becomes <strong>${Number(setting.base_target) + Number(setting.extra_if_fail)}</strong>.
          </div>
          ${renderTable()}
        </div>

        <div class="panel">
          ${renderSettings(activeWs, setting)}
          <div class="section-divider"></div>
          ${renderAssignmentEditor(activeWs)}
          <div class="section-divider"></div>
          ${renderAgentManager(activeWs)}
        </div>
      </div>
    </div>
  `;

  bindDashboardEvents();
}

function renderTable() {
  const rows = activeAssignments();

  if (!rows.length) {
    return `
      <div class="notice">
        No agents assigned for this workstream this week. Use the assignment panel on the right.
      </div>
    `;
  }

  const body = rows
    .map((a) => {
      const stats = getAssignmentStats(a);

      return `
        <tr class="${stats.done ? "done" : ""}">
          <td class="name-cell">${escapeHtml(a.agents?.name)}</td>
          <td><span class="qa-badge">${escapeHtml(a.qa_members?.name)}</span></td>
          ${DAY_OFFSETS.map(
            (offset) => `
              <td>
                <div class="count-control">
                  <button class="small secondary" data-action="dec-count" data-assignment="${a.id}" data-date="${addDays(state.currentWeekStart, offset)}">-</button>
                  <span class="count-number">${getDayCount(a, offset)}</span>
                  <button class="small" data-action="inc-count" data-assignment="${a.id}" data-date="${addDays(state.currentWeekStart, offset)}">+</button>
                </div>
              </td>
            `
          ).join("")}
          <td><strong>${stats.total}</strong></td>
          <td>
            <div class="count-control">
              <button class="small secondary" data-action="dec-fail" data-assignment="${a.id}">-</button>
              <span class="count-number">${stats.failCount}</span>
              <button class="small" data-action="inc-fail" data-assignment="${a.id}">+</button>
            </div>
          </td>
          <td><strong>${stats.target}</strong></td>
          <td><strong>${stats.left}</strong></td>
          <td>
            <span class="status-pill ${stats.done ? "status-done" : "status-pending"}">
              ${stats.done ? "Done" : "Pending"}
            </span>
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="table-wrap">
      <table class="qa-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>QA</th>
            ${DAYS.map((d) => `<th>${d}</th>`).join("")}
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

function renderSettings(activeWs, setting) {
  return `
    <h2>Weekly Settings</h2>
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
  `;
}

function renderAssignmentEditor(activeWs) {
  const assignedAgentIds = new Set(
    state.assignments
      .filter((a) => a.workstream_id === activeWs.id)
      .map((a) => a.agent_id)
  );

  const agents = state.agents.filter((a) => a.workstream_id === activeWs.id);

  const rows = activeAssignments()
    .map(
      (a) => `
      <div class="mini-item">
        <div>
          <strong>${escapeHtml(a.agents?.name)}</strong>
          <span>Assigned to ${escapeHtml(a.qa_members?.name)}</span>
        </div>
        <select data-action="change-qa" data-assignment="${a.id}">
          ${state.qaMembers
            .map(
              (qa) => `
                <option value="${qa.id}" ${qa.id === a.qa_member_id ? "selected" : ""}>
                  ${escapeHtml(qa.name)}
                </option>
              `
            )
            .join("")}
        </select>
      </div>
    `
    )
    .join("");

  const unassignedOptions = agents
    .filter((a) => !assignedAgentIds.has(a.id))
    .map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`)
    .join("");

  return `
    <h2>Assignments</h2>

    <form id="assignForm" class="side-form">
      <label>
        Agent
        <select id="assignAgent">
          <option value="">Select agent</option>
          ${unassignedOptions}
        </select>
      </label>
      <label>
        QA
        <select id="assignQa">
          ${state.qaMembers
            .map((qa) => `<option value="${qa.id}">${escapeHtml(qa.name)}</option>`)
            .join("")}
        </select>
      </label>
      <button type="submit">Assign agent</button>
    </form>

    <div class="mini-list">${rows}</div>
  `;
}

function renderAgentManager(activeWs) {
  const agents = state.agents.filter((a) => a.workstream_id === activeWs.id);

  return `
    <h2>Agents</h2>
    <form id="addAgentForm" class="side-form">
      <label>
        New agent name
        <input id="newAgentName" placeholder="Example: Sagar" />
      </label>
      <button type="submit">Add agent</button>
    </form>

    <div class="mini-list">
      ${agents
        .map(
          (a) => `
            <div class="mini-item">
              <div>
                <strong>${escapeHtml(a.name)}</strong>
                <span>${escapeHtml(activeWs.name)}</span>
              </div>
              <button class="small secondary" data-action="toggle-agent" data-agent="${a.id}">
                Hide
              </button>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function bindDashboardEvents() {
  document.getElementById("signOutBtn").addEventListener("click", signOut);

  document.getElementById("refreshBtn").addEventListener("click", async () => {
    await refreshData();
    renderDashboard();
  });

  document.querySelectorAll("[data-workstream]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeWorkstreamId = button.dataset.workstream;
      renderDashboard();
    });
  });

  document.querySelectorAll("[data-action]").forEach((element) => {
    element.addEventListener("click", handleActionClick);
    element.addEventListener("change", handleActionChange);
  });

  document.getElementById("settingsForm").addEventListener("submit", saveSettings);
  document.getElementById("assignForm").addEventListener("submit", assignAgent);
  document.getElementById("addAgentForm").addEventListener("submit", addAgent);
}

async function handleActionClick(e) {
  const action = e.currentTarget.dataset.action;
  const assignmentId = e.currentTarget.dataset.assignment;

  if (!action) return;

  if (action === "inc-count" || action === "dec-count") {
    const qaDate = e.currentTarget.dataset.date;
    const delta = action === "inc-count" ? 1 : -1;
    await changeDailyCount(assignmentId, qaDate, delta);
  }

  if (action === "inc-fail" || action === "dec-fail") {
    const delta = action === "inc-fail" ? 1 : -1;
    await changeFailCount(assignmentId, delta);
  }

  if (action === "toggle-agent") {
    await supabaseClient
      .from("agents")
      .update({ is_active: false })
      .eq("id", e.currentTarget.dataset.agent);
    await refreshData();
    renderDashboard();
  }
}

async function handleActionChange(e) {
  const action = e.currentTarget.dataset.action;

  if (action === "change-qa") {
    await supabaseClient
      .from("weekly_assignments")
      .update({ qa_member_id: e.currentTarget.value })
      .eq("id", e.currentTarget.dataset.assignment);

    await refreshData();
    renderDashboard();
  }
}

async function changeDailyCount(assignmentId, qaDate, delta) {
  const existing = await supabaseClient
    .from("qa_counts")
    .select("*")
    .eq("assignment_id", assignmentId)
    .eq("qa_date", qaDate)
    .maybeSingle();

  const newCount = Math.max(Number(existing.data?.count || 0) + delta, 0);

  if (existing.data) {
    await supabaseClient
      .from("qa_counts")
      .update({ count: newCount, updated_at: new Date().toISOString() })
      .eq("id", existing.data.id);
  } else if (newCount > 0) {
    await supabaseClient.from("qa_counts").insert({
      assignment_id: assignmentId,
      qa_date: qaDate,
      count: newCount
    });
  }

  await refreshData();
  renderDashboard();
}

async function changeFailCount(assignmentId, delta) {
  const existing = await supabaseClient
    .from("fail_counts")
    .select("*")
    .eq("assignment_id", assignmentId)
    .maybeSingle();

  const newCount = Math.max(Number(existing.data?.fail_count || 0) + delta, 0);

  if (existing.data) {
    await supabaseClient
      .from("fail_counts")
      .update({ fail_count: newCount, updated_at: new Date().toISOString() })
      .eq("id", existing.data.id);
  } else if (newCount > 0) {
    await supabaseClient.from("fail_counts").insert({
      assignment_id: assignmentId,
      fail_count: newCount
    });
  }

  await refreshData();
  renderDashboard();
}

async function saveSettings(e) {
  e.preventDefault();

  const setting = getSetting(state.activeWorkstreamId);
  const baseTarget = Number(document.getElementById("baseTarget").value || 0);
  const extraIfFail = Number(document.getElementById("extraIfFail").value || 0);

  if (setting.id) {
    await supabaseClient
      .from("weekly_settings")
      .update({ base_target: baseTarget, extra_if_fail: extraIfFail })
      .eq("id", setting.id);
  } else {
    await supabaseClient.from("weekly_settings").insert({
      week_start: state.currentWeekStart,
      workstream_id: state.activeWorkstreamId,
      base_target: baseTarget,
      extra_if_fail: extraIfFail
    });
  }

  await refreshData();
  renderDashboard();
}

async function assignAgent(e) {
  e.preventDefault();

  const agentId = document.getElementById("assignAgent").value;
  const qaMemberId = document.getElementById("assignQa").value;

  if (!agentId || !qaMemberId) return;

  await supabaseClient.from("weekly_assignments").insert({
    week_start: state.currentWeekStart,
    agent_id: agentId,
    qa_member_id: qaMemberId,
    workstream_id: state.activeWorkstreamId
  });

  await refreshData();
  renderDashboard();
}

async function addAgent(e) {
  e.preventDefault();

  const name = document.getElementById("newAgentName").value.trim();
  if (!name) return;

  await supabaseClient.from("agents").insert({
    name,
    workstream_id: state.activeWorkstreamId,
    is_active: true
  });

  await refreshData();
  renderDashboard();
}

async function subscribeRealtime() {
  supabaseClient
    .channel("qa-counter-changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "qa_counts" },
      async () => {
        await refreshData();
        renderDashboard();
      }
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "fail_counts" },
      async () => {
        await refreshData();
        renderDashboard();
      }
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "weekly_assignments" },
      async () => {
        await refreshData();
        renderDashboard();
      }
    )
    .subscribe();
}

init();
