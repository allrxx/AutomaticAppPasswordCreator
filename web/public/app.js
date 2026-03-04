const form = document.getElementById("jobForm");
const startBtn = document.getElementById("startBtn");

const jobBadge = document.getElementById("jobBadge");
const stageTitle = document.getElementById("stageTitle");
const stageText = document.getElementById("stageText");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const jobMeta = document.getElementById("jobMeta");
const summaryEl = document.getElementById("summary");

const activityFeed = document.getElementById("activityFeed");
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

function friendlyMessage(entry) {
  const message = String(entry?.message || "");

  let match = message.match(/^\[(\d+)\/(\d+)\] Mailbox created: (.+)$/);
  if (match) return `Mailbox ${match[1]} of ${match[2]} created: ${match[3]}`;

  match = message.match(/^\[(\d+)\/(\d+)\] Mailbox create failed: (.+)$/);
  if (match) return `Mailbox ${match[1]} of ${match[2]} failed: ${match[3]}`;

  match = message.match(/^\[(\d+)\/(\d+)\] App password created: (.+)$/);
  if (match) return `App password ${match[1]} of ${match[2]} created for ${match[3]}`;

  match = message.match(/^\[(\d+)\/(\d+)\] App password failed: (.+)$/);
  if (match) return `App password ${match[1]} of ${match[2]} failed: ${match[3]}`;

  match = message.match(/^\[(\d+)\/(\d+)\] SMTP sent: (.+) -> (.+)$/);
  if (match) return `SMTP test ${match[1]} of ${match[2]} sent from ${match[3]} to ${match[4]}`;

  match = message.match(/^\[(\d+)\/(\d+)\] SMTP failed: (.+)$/);
  if (match) return `SMTP test ${match[1]} of ${match[2]} failed: ${match[3]}`;

  if (message === "Job queued") return "Request accepted and queued.";
  if (message === "Workflow started") return "Workflow execution started.";
  if (message.startsWith("Generated ") && message.endsWith(" mailbox records")) {
    return message.replace("Generated", "Prepared");
  }
  if (message === "Receiver app password not provided. IMAP verification skipped.") {
    return "IMAP verification skipped because receiver credentials are not configured.";
  }
  if (message === "VALIDATION_RECEIVER_EMAIL not set. SMTP validation will send each email to itself.") {
    return "Validation receiver email is not set; SMTP checks are running in self-send mode.";
  }
  if (message === "Result CSV written") return "Result file generated and ready for download.";
  if (message.startsWith("Workflow complete.")) return message;
  if (message.startsWith("Workflow failed:")) return message;
  if (message.startsWith("IMAP verification complete:")) return message;

  return message;
}

function renderActivity(logs) {
  if (!logs || logs.length === 0) {
    activityFeed.innerHTML = '<li class="empty-state">No activity yet.</li>';
    return;
  }

  const entries = logs
    .filter((entry) => entry.level !== "debug")
    .slice(-80)
    .map((entry) => {
      const level = entry.level || "info";
      return `
        <li class="activity-item ${escapeHtml(level)}">
          <div class="activity-head">
            <span class="activity-time">${escapeHtml(formatClock(entry.ts))}</span>
            <span class="activity-level">${escapeHtml(level)}</span>
          </div>
          <p class="activity-message">${escapeHtml(friendlyMessage(entry))}</p>
        </li>
      `;
    });

  activityFeed.innerHTML = entries.join("") || '<li class="empty-state">No activity yet.</li>';
  activityFeed.scrollTop = activityFeed.scrollHeight;
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
    logStream.textContent = "No technical logs yet.";
    return;
  }

  const includeDebug = Boolean(showDebugLogs?.checked);
  const entries = logs.filter((entry) => includeDebug || entry.level !== "debug").slice(-240);

  if (entries.length === 0) {
    logStream.textContent = "No technical logs for current filter.";
    return;
  }

  logStream.innerHTML = entries
    .map((entry) => {
      const details = formatDetails(entry.details);
      return `
        <article class="log-line">
          <div class="log-meta">
            <span class="log-time">${escapeHtml(entry.ts || "")}</span>
            <span class="log-level ${escapeHtml(entry.level || "info")}">${escapeHtml(entry.level || "info")}</span>
          </div>
          <p class="log-message">${escapeHtml(entry.message || "")}</p>
          ${
            details
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
  activityFeed.innerHTML = '<li class="empty-state">Preparing workflow...</li>';
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
  renderActivity(job.logs || []);
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
    deployBtn.classList.remove("hidden");
    deployBtn.disabled = false;
  } else {
    deployBtn.classList.add("hidden");
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
    activityFeed.innerHTML = `
      <li class="activity-item error">
        <div class="activity-head">
          <span class="activity-time">${escapeHtml(formatClock(new Date().toISOString()))}</span>
          <span class="activity-level">error</span>
        </div>
        <p class="activity-message">${escapeHtml(error.message)}</p>
      </li>
    `;
    logStream.innerHTML = `
      <article class="log-line">
        <div class="log-meta">
          <span class="log-time">${escapeHtml(new Date().toISOString())}</span>
          <span class="log-level error">error</span>
        </div>
        <p class="log-message">${escapeHtml(error.message)}</p>
      </article>
    `;
  }
});
deployBtn.addEventListener("click", async (event) => {
  event.preventDefault();

  if (!activeJobId) {
    alert("No active job to deploy");
    return;
  }

  deployBtn.disabled = true;
  const originalText = deployBtn.textContent;
  deployBtn.textContent = "Deploying...";

  try {
    const response = await fetch(`/api/jobs/${activeJobId}/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Deployment failed (${response.status})`);
    }

    deployBtn.textContent = "Deployed ✓";
    deployBtn.disabled = true;

    // Add success activity log entry
    const successEntry = `
      <li class="activity-item info">
        <div class="activity-head">
          <span class="activity-time">${escapeHtml(formatClock(new Date().toISOString()))}</span>
          <span class="activity-level">info</span>
        </div>
        <p class="activity-message">${escapeHtml(`Successfully deployed ${data.credentialsCount} credentials to ${data.deployment} backend`)}</p>
      </li>
    `;

    const newHtml = successEntry + activityFeed.innerHTML;
    activityFeed.innerHTML = newHtml;
  } catch (error) {
    deployBtn.disabled = false;
    deployBtn.textContent = originalText;

    // Add error activity log entry
    const errorEntry = `
      <li class="activity-item error">
        <div class="activity-head">
          <span class="activity-time">${escapeHtml(formatClock(new Date().toISOString()))}</span>
          <span class="activity-level">error</span>
        </div>
        <p class="activity-message">${escapeHtml(`Deployment failed: ${error.message}`)}</p>
      </li>
    `;

    const newHtml = errorEntry + activityFeed.innerHTML;
    activityFeed.innerHTML = newHtml;
  }
});