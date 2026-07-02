// Weekly QA Counter fail selector hotfix.
// This replaces Fail +/- with exact buttons: 0, 1, 2, 3+.
// It updates fail_counts through RPC public.set_fail_count_exact.

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

  console.log("Fail selector hotfix loaded. Use buttons 0, 1, 2, 3+.");
})();
