const form = document.getElementById("jobForm");
const startBtn = document.getElementById("startBtn");

const jobBadge = document.getElementById("jobBadge");
const stageTitle = document.getElementById("stageTitle");
const stageText = document.getElementById("stageText");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const jobMeta = document.getElementById("jobMeta");
const summaryEl = document.getElementById("summary");

const showDebugLogs = document.getElementById("showDebugLogs");
const logStream = document.getElementById("logStream");

const tableBody = document.querySelector("#resultsTable tbody");
const downloadCsv = document.getElementById("downloadCsv");
const deployBtn = document.getElementById("deployBtn");

const stageItems = Array.from(document.querySelectorAll(".stage-item"));
const terminalStates = new Set(["completed", "completed_with_errors", "failed"]);

let activeJobId = null;
let pollTimer = null;
let latestJob = null;
let autoDeployTimer = null;
let autoDeploySeconds = 5;

const deployCountdown = document.getElementById("deployCountdown");
const cancelDeployBtn = document.getElementById("cancelDeployBtn");

if (cancelDeployBtn) {
  cancelDeployBtn.addEventListener("click", () => {
    if (autoDeployTimer) clearInterval(autoDeployTimer);
    if (latestJob) latestJob.autoDeployHandled = true;
    cancelDeployBtn.classList.add("hidden");
    deployCountdown.classList.add("hidden");
  });
}

function formToPayload(formElement) {
  const data = new FormData(formElement);
  return {
    count: Number(data.get("count")),
    deployment: String(data.get("deployment") || "dev").trim(),
  };
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch (_err) {
    return value;
  }
}

function formatClock(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleTimeString();
  } catch (_err) {
    return value;
  }
}

function setBadge(status) {
  const safeStatus = status || "idle";
  const labels = {
    idle: "Idle",
    queued: "Queued",
    running: "Running",
    completed: "Completed",
    completed_with_errors: "Completed with Issues",
    failed: "Failed",
  };

  jobBadge.className = "badge";
  jobBadge.classList.add(safeStatus);
  jobBadge.textContent = labels[safeStatus] || safeStatus;
}

function normalizeProgress(progress, status) {
  const stageTotal = Number(progress?.stageTotal) > 0 ? Number(progress.stageTotal) : 3;
  const stageCurrent = Math.max(0, Math.min(stageTotal, Number(progress?.stageCurrent) || 0));
  const completed = Math.max(0, Number(progress?.completed) || 0);
  const total = Math.max(0, Number(progress?.total) || 0);
  const fallbackPercent =
    stageCurrent > 0 ? Math.round(((stageCurrent - 1 + (total > 0 ? completed / total : 1)) / stageTotal) * 100) : 0;
  const percent = Math.max(0, Math.min(100, Number(progress?.percent) || fallbackPercent));

  const stageLabel =
    progress?.stageLabel ||
    progress?.phase ||
    (status === "failed" ? "Workflow failed" : status === "running" ? "Workflow running" : "Waiting");
  const detail = progress?.detail || "";

  return {
    stageTotal,
    stageCurrent,
    stageLabel,
    detail,
    completed,
    total,
    percent,
  };
}

function renderStageTrack(status, progress) {
  stageItems.forEach((item, index) => {
    const itemStage = index + 1;
    item.classList.remove("pending", "active", "done", "error");

    if (progress.stageCurrent === 0) {
      item.classList.add("pending");
      return;
    }

    if (itemStage < progress.stageCurrent) {
      item.classList.add("done");
      return;
    }

    if (itemStage === progress.stageCurrent) {
      if (status === "failed") {
        item.classList.add("error");
      } else if (terminalStates.has(status)) {
        item.classList.add("done");
      } else {
        item.classList.add("active");
      }
      return;
    }

    item.classList.add("pending");
  });
}

function renderSummary(summary) {
  if (!summary) {
    summaryEl.innerHTML = "";
    return;
  }

  const cards = [
    { label: "Total", value: summary.total },
    { label: "Mailboxes", value: summary.mailboxCreated },
    { label: "App Passwords", value: summary.appPasswords },
    { label: "SMTP", value: summary.smtpSent },
    { label: "IMAP", value: summary.imapVerified },
    { label: "Success", value: summary.success },
    { label: "Failed", value: summary.failed },
  ];

  summaryEl.innerHTML = cards
    .map(
      (card) => `
      <article class="summary-card">
        <span class="label">${escapeHtml(card.label)}</span>
        <span class="value">${escapeHtml(card.value)}</span>
      </article>
    `
    )
    .join("");
}

function boolCell(value) {
  if (value === true) return "YES";
  if (value === false) return "NO";
  return "-";
}

function statusPill(status) {
  if (status === "SUCCESS") {
    return '<span class="status-pill success">SUCCESS</span>';
  }
  if (status === "FAILED") {
    return '<span class="status-pill failed">FAILED</span>';
  }
  return '<span class="status-pill pending">PENDING</span>';
}

function renderRows(rows) {
  tableBody.innerHTML = "";
  if (!rows || rows.length === 0) {
    return;
  }

  const fragment = document.createDocumentFragment();

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.email || "")}</td>
      <td>${escapeHtml(row.password || "")}</td>
      <td>${escapeHtml(row.app_password || "")}</td>
      <td>${boolCell(row.mailbox_created)}</td>
      <td>${boolCell(row.smtp_sent)}</td>
      <td>${boolCell(row.imap_verified)}</td>
      <td>${statusPill(row.status)}</td>
      <td>${escapeHtml(row.error || "")}</td>
    `;
    fragment.appendChild(tr);
  });

  tableBody.appendChild(fragment);
}

function formatDetails(details) {
  if (details === undefined) return "";
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details, null, 2);
  } catch (_error) {
    return "[details unavailable]";
  }
}

function renderTechnicalLogs(logs) {
  if (!logs || logs.length === 0) {
    logStream.textContent = "No execution logs yet.";
    return;
  }

  const includeDebug = Boolean(showDebugLogs?.checked);
  const entries = logs.filter((entry) => includeDebug || entry.level !== "debug").slice(-240);

  if (entries.length === 0) {
    logStream.textContent = "No execution logs for current filter.";
    return;
  }

  logStream.innerHTML = entries
    .map((entry) => {
      if (entry.level === "golden") {
        return `
          <article class="log-line golden">
            <div class="log-meta">
              <span class="log-time">${escapeHtml(entry.ts || "")}</span>
              <span class="log-level golden">deploy script</span>
            </div>
            <p class="log-message golden-title">${escapeHtml(entry.message || "")}</p>
            <div class="golden-body">${entry.details || ""}</div>
          </article>
        `;
      }

      const details = formatDetails(entry.details);
      return `
        <article class="log-line ${escapeHtml(entry.level || "info")}">
          <div class="log-meta">
            <span class="log-time">${escapeHtml(entry.ts || "")}</span>
            <span class="log-level ${escapeHtml(entry.level || "info")}">${escapeHtml(entry.level || "info")}</span>
          </div>
          <p class="log-message">${escapeHtml(entry.message || "")}</p>
          ${details
          ? `<details><summary>Details</summary><pre>${escapeHtml(details)}</pre></details>`
          : ""
        }
        </article>
      `;
    })
    .join("");

  logStream.scrollTop = logStream.scrollHeight;
}

function resetView() {
  latestJob = null;
  setBadge("queued");
  stageTitle.textContent = "Workflow queued";
  stageText.textContent = "Stage 0/3";
  progressText.textContent = "0% complete";
  progressBar.style.width = "0%";
  jobMeta.textContent = "Preparing workflow...";
  summaryEl.innerHTML = "";
  tableBody.innerHTML = "";
  downloadCsv.classList.add("hidden");
  deployBtn.classList.add("hidden");
  deployBtn.disabled = false;
  if (cancelDeployBtn) cancelDeployBtn.classList.add("hidden");
  if (deployCountdown) deployCountdown.classList.add("hidden");
  if (autoDeployTimer) clearInterval(autoDeployTimer);
  logStream.textContent = "Waiting for server logs...";

  stageItems.forEach((item) => {
    item.classList.remove("done", "active", "error");
    item.classList.add("pending");
  });
}

function renderJob(job) {
  if (!job) return;
  latestJob = job;

  const progress = normalizeProgress(job.progress || {}, job.status);
  const stagePrefix = progress.stageCurrent > 0 ? `${progress.stageCurrent}/${progress.stageTotal}` : `0/${progress.stageTotal}`;
  const itemPrefix = progress.total > 0 ? ` • ${progress.completed}/${progress.total}` : "";

  setBadge(job.status || "idle");
  stageTitle.textContent = progress.stageLabel;
  stageText.textContent = `Stage ${stagePrefix}${itemPrefix}`;
  progressBar.style.width = `${progress.percent}%`;
  progressText.textContent = `${progress.percent}% complete${progress.detail ? ` • ${progress.detail}` : ""}`;

  const deploymentLabel = job.configPublic?.deployment ? ` | Deployment: ${job.configPublic.deployment}` : "";
  jobMeta.textContent = `Job: ${job.id} | Started: ${formatTime(job.startedAt || job.createdAt)} | Updated: ${formatTime(job.updatedAt)} | Finished: ${formatTime(job.finishedAt)}${deploymentLabel}`;

  renderStageTrack(job.status, progress);
  renderTechnicalLogs(job.logs || []);
  renderRows(job.rows || []);
  renderSummary(job.summary);

  if (job.csvPath) {
    downloadCsv.href = job.csvPath;
    downloadCsv.classList.remove("hidden");
  } else {
    downloadCsv.classList.add("hidden");
  }

  // Show deploy button only if job is completed
  if (terminalStates.has(job.status)) {
    const overallSuccess = job.status === "completed";

    if (overallSuccess && !job.autoDeployHandled) {
      deployBtn.classList.remove("hidden");
      deployBtn.disabled = false;
      cancelDeployBtn.classList.remove("hidden");
      deployCountdown.classList.remove("hidden");

      autoDeploySeconds = 5;
      deployCountdown.textContent = `${autoDeploySeconds}s`;

      autoDeployTimer = setInterval(() => {
        autoDeploySeconds -= 1;
        if (autoDeploySeconds <= 0) {
          clearInterval(autoDeployTimer);
          job.autoDeployHandled = true;
          cancelDeployBtn.classList.add("hidden");
          deployCountdown.classList.add("hidden");
          deployBtn.click();
        } else {
          deployCountdown.textContent = `${autoDeploySeconds}s`;
        }
      }, 1000);

      // Mark handled immediately so we don't start multiple timers on next poll
      job.autoDeployHandled = true;
    } else if (overallSuccess || job.autoDeployHandled) {
      deployBtn.classList.remove("hidden");
      deployBtn.disabled = false;
    }
  } else {
    deployBtn.classList.add("hidden");
    if (cancelDeployBtn) cancelDeployBtn.classList.add("hidden");
    if (deployCountdown) deployCountdown.classList.add("hidden");
  }
}

async function fetchJob() {
  if (!activeJobId) return;

  const response = await fetch(`/api/jobs/${activeJobId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch job ${activeJobId}`);
  }

  const payload = await response.json();
  const job = payload.job;
  renderJob(job);

  if (terminalStates.has(job.status)) {
    clearInterval(pollTimer);
    pollTimer = null;
    startBtn.disabled = false;
  }
}

function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }

  pollTimer = setInterval(() => {
    fetchJob().catch((error) => {
      activityFeed.innerHTML = `
        <li class="activity-item error">
          <div class="activity-head">
            <span class="activity-time">${escapeHtml(formatClock(new Date().toISOString()))}</span>
            <span class="activity-level">error</span>
          </div>
          <p class="activity-message">${escapeHtml(error.message)}</p>
        </li>
      `;
    });
  }, 1500);
}

if (showDebugLogs) {
  showDebugLogs.addEventListener("change", () => {
    renderTechnicalLogs(latestJob?.logs || []);
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  startBtn.disabled = true;
  resetView();

  try {
    const payload = formToPayload(form);
    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      const details = Array.isArray(data.details) ? data.details : [];
      const detailText = details.length > 0 ? ` Missing: ${details.join(", ")}` : "";
      throw new Error(`${data.error || "Unable to start workflow"}.${detailText}`);
    }

    activeJobId = data.jobId;
    await fetchJob();
    startPolling();
  } catch (error) {
    startBtn.disabled = false;
    setBadge("failed");
    stageTitle.textContent = "Could not start workflow";
    stageText.textContent = "Stage 0/3";
    progressText.textContent = "0% complete";
    jobMeta.textContent = "Fix server configuration and try again.";

    // Fallback if there is no job yet
    if (!latestJob) {
      latestJob = { logs: [] };
    }
    latestJob.logs.push({
      ts: new Date().toISOString(),
      level: "error",
      message: "Could not start workflow",
      details: error.message,
    });
    renderTechnicalLogs(latestJob.logs);
  }
});
function renderDeploySteps(steps) {
  if (!steps || steps.length === 0) return "";
  return steps
    .map((step) => {
      const icon = step.status === "success" ? "✅" : step.status === "failed" ? "❌" : "⏭";
      const cls = step.status || "info";
      const errorLine = step.error
        ? `<p class="deploy-step-error">${escapeHtml(step.error)}</p>`
        : "";
      return `
        <div class="deploy-step ${escapeHtml(cls)}">
          <span class="deploy-step-icon">${icon}</span>
          <div class="deploy-step-body">
            <span class="deploy-step-name">${escapeHtml(step.name)}</span>
            <span class="deploy-step-detail">${escapeHtml(step.detail || "")}</span>
            ${errorLine}
          </div>
        </div>
      `;
    })
    .join("");
}

deployBtn.addEventListener("click", async (event) => {
  event.preventDefault();

  if (!activeJobId) {
    alert("No active job to deploy");
    return;
  }

  deployBtn.disabled = true;
  if (cancelDeployBtn) cancelDeployBtn.classList.add("hidden");
  if (deployCountdown) deployCountdown.classList.add("hidden");
  if (autoDeployTimer) clearInterval(autoDeployTimer);

  const originalText = deployBtn.textContent;
  deployBtn.textContent = "Deploying...";

  let data = null;
  let failed = false;

  try {
    const response = await fetch(`/api/jobs/${activeJobId}/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    data = await response.json();

    if (!response.ok) {
      failed = true;
    }
  } catch (error) {
    data = { error: error.message, steps: [] };
    failed = true;
  }

  const steps = data.steps || [];
  const stepsHtml = renderDeploySteps(steps);
  const now = escapeHtml(formatClock(new Date().toISOString()));
  const overallSuccess = !failed;

  // Build raw script output section if available
  let rawOutputHtml = "";
  const rawOutput = data.scriptOutput || data.stdout || "";
  const rawErrors = data.stderr || "";
  if (rawOutput || rawErrors) {
    const combinedOutput = [rawOutput, rawErrors].filter(Boolean).join("\n---\n");
    rawOutputHtml = `
      <details class="deploy-output">
        <summary>Raw script output</summary>
        <pre>${escapeHtml(combinedOutput)}</pre>
      </details>
    `;
  }

  if (overallSuccess) {
    deployBtn.textContent = "Deployed ✓";
    deployBtn.disabled = true;

    if (!latestJob) latestJob = { logs: [] };
    latestJob.logs.push({
      ts: new Date().toISOString(),
      level: "golden",
      message: `Successfully deployed ${data.credentialsCount || 0} credentials to ${data.deployment || "unknown"} backend.`,
      details: `<div class="deploy-log">${stepsHtml}</div>${rawOutputHtml}`,
    });
    renderTechnicalLogs(latestJob.logs);
  } else {
    deployBtn.disabled = false;
    deployBtn.textContent = originalText;

    if (!latestJob) latestJob = { logs: [] };
    latestJob.logs.push({
      ts: new Date().toISOString(),
      level: "golden",
      message: `Deployment failed: ${data.error || "Unknown error"}`,
      details: `<div class="deploy-log">${stepsHtml}</div>${rawOutputHtml}`,
    });
    renderTechnicalLogs(latestJob.logs);
  }
});