// Weekly QA Counter fail button hotfix.
// This overrides the fail +/- function from app.js and uses a Supabase RPC.
// Required SQL function: public.set_fail_count_delta(p_assignment_id uuid, p_delta int)

changeFailCount = async function changeFailCountHotfix(assignmentId, delta) {
  if (!assignmentId) return;

  const result = await supabaseClient.rpc("set_fail_count_delta", {
    p_assignment_id: assignmentId,
    p_delta: delta
  });

  if (result.error) {
    alert("Fail update error: " + result.error.message);
    return;
  }

  await refreshData();
  renderDashboard();
};

console.log("Fail button hotfix loaded.");
