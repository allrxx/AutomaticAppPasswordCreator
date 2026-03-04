const form = document.getElementById("jobForm");
const startBtn = document.getElementById("startBtn");

const jobBadge = document.getElementById("jobBadge");
const jobMeta = document.getElementById("jobMeta");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const logsEl = document.getElementById("logs");
const summaryEl = document.getElementById("summary");
const tableBody = document.querySelector("#resultsTable tbody");
const downloadCsv = document.getElementById("downloadCsv");

let activeJobId = null;
let pollTimer = null;

function formToPayload(formElement) {
  const data = new FormData(formElement);
  return {
    count: Number(data.get("count")),
  };
}

function setBadge(status) {
  jobBadge.className = "badge";
  jobBadge.classList.add(status || "idle");
  jobBadge.textContent = status || "idle";
}

function formatTime(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString();
  } catch (_err) {
    return value;
  }
}

function renderSummary(summary) {
  if (!summary) {
    summaryEl.innerHTML = "";
    return;
  }

  summaryEl.innerHTML = `
    <strong>Summary</strong><br>
    Total: ${summary.total} | Mailboxes: ${summary.mailboxCreated} | App Passwords: ${summary.appPasswords}<br>
    SMTP: ${summary.smtpSent} | IMAP: ${summary.imapVerified} | Success: ${summary.success} | Failed: ${summary.failed}
  `;
}

function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    logsEl.textContent = "No logs yet.";
    return;
  }

  logsEl.textContent = logs
    .map((entry) => {
      const base = `[${entry.ts}] [${entry.level.toUpperCase()}] ${entry.message}`;
      if (entry.details === undefined) {
        return base;
      }

      try {
        const detailText =
          typeof entry.details === "string" ? entry.details : JSON.stringify(entry.details, null, 2);
        return `${base}\n${detailText}`;
      } catch (_error) {
        return `${base}\n[details unavailable]`;
      }
    })
    .join("\n\n");
  logsEl.scrollTop = logsEl.scrollHeight;
}

function boolCell(value) {
  if (value === true) return "YES";
  if (value === false) return "NO";
  return "-";
}

function renderRows(rows) {
  tableBody.innerHTML = "";
  if (!rows || rows.length === 0) {
    return;
  }

  const fragment = document.createDocumentFragment();

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const statusClass = row.status === "SUCCESS" ? "status-success" : row.status === "FAILED" ? "status-failed" : "";

    tr.innerHTML = `
      <td>${row.email || ""}</td>
      <td>${row.password || ""}</td>
      <td>${row.app_password || ""}</td>
      <td>${boolCell(row.mailbox_created)}</td>
      <td>${boolCell(row.smtp_sent)}</td>
      <td>${boolCell(row.imap_verified)}</td>
      <td class="${statusClass}">${row.status || "PENDING"}</td>
      <td>${row.error || ""}</td>
    `;

    fragment.appendChild(tr);
  });

  tableBody.appendChild(fragment);
}

function renderJob(job) {
  if (!job) return;

  setBadge(job.status || "idle");

  const phase = job.progress?.phase || "-";
  const completed = job.progress?.completed || 0;
  const total = job.progress?.total || 0;
  const percent = job.progress?.percent || 0;

  progressBar.style.width = `${percent}%`;
  progressText.textContent = `Progress: ${percent}% (${phase} ${completed}/${total})`;

  jobMeta.textContent = `Job: ${job.id} | Started: ${formatTime(job.startedAt || job.createdAt)} | Updated: ${formatTime(job.updatedAt)} | Finished: ${formatTime(job.finishedAt)}`;

  renderLogs(job.logs || []);
  renderRows(job.rows || []);
  renderSummary(job.summary);

  if (job.csvPath) {
    downloadCsv.href = job.csvPath;
    downloadCsv.classList.remove("hidden");
  } else {
    downloadCsv.classList.add("hidden");
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

  const finishedStates = ["completed", "completed_with_errors", "failed"];
  if (finishedStates.includes(job.status)) {
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
      logsEl.textContent += `\n[client] ${error.message}`;
    });
  }, 1500);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  startBtn.disabled = true;
  summaryEl.innerHTML = "";
  logsEl.textContent = "Starting job...";
  tableBody.innerHTML = "";
  downloadCsv.classList.add("hidden");

  try {
    const payload = formToPayload(form);
    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      const details = data.details ? ` (${data.details.join(", ")})` : "";
      throw new Error(`${data.error || "Unable to start workflow"}${details}`);
    }

    activeJobId = data.jobId;
    jobMeta.textContent = `Job created: ${activeJobId}`;
    setBadge("running");

    await fetchJob();
    startPolling();
  } catch (error) {
    logsEl.textContent = `Failed to start job: ${error.message}`;
    startBtn.disabled = false;
    setBadge("failed");
  }
});
