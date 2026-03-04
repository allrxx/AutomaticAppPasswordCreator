"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const crypto = require("crypto");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const nodemailer = require("nodemailer");
const { ImapFlow } = require("imapflow");
const { chromium } = require("playwright");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const OUTPUT_DIR = path.join(__dirname, "output");

const jobs = new Map();
const MAX_LOG_LINES = 5000;
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
const WORKFLOW_STAGES = Object.freeze({
  mailbox: { key: "mailbox", label: "Creating mailboxes", index: 1, total: 3 },
  appPassword: { key: "appPassword", label: "Generating app passwords", index: 2, total: 3 },
  validation: { key: "validation", label: "Validating delivery", index: 3, total: 3 },
});

const DEPLOY_CHOICE_MAP = Object.freeze({
  prod: "1",
  staging: "2",
  dev: "3",
  demo: "4",
  cazelabs: "5",
});

const DB_MGMT_MOUNT = "/mnt/db-mgmt";
const ENCRYPT_SCRIPT = path.join(DB_MGMT_MOUNT, "scripts", "encrypt_email_pool.sh");
const TSV_INPUT_PATH = path.join(DB_MGMT_MOUNT, "scripts", "user_email_pool.tsv");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function nowIso() {
  return new Date().toISOString();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomString(charset, length) {
  const bytes = crypto.randomBytes(length * 2);
  let output = "";
  for (let i = 0; i < bytes.length && output.length < length; i += 1) {
    output += charset[bytes[i] % charset.length];
  }
  return output.slice(0, length);
}

function buildMailboxLocalPart(prefix, randomLength) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `${prefix}${randomString(chars, randomLength)}`;
}

function buildMailboxPassword() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=";
  return `${randomString(chars, 16)}Aa1!`;
}

function buildAppPassword() {
  return `${crypto.randomBytes(8).toString("hex")}Aa1!`;
}

function addLog(job, level, message, details) {
  const safeLevel = LOG_LEVELS.has(level) ? level : "info";
  const entry = { ts: nowIso(), level: safeLevel, message };
  if (details !== undefined) {
    entry.details = details;
  }

  job.logs.push(entry);
  if (job.logs.length > MAX_LOG_LINES) {
    job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
  }
  job.updatedAt = nowIso();

  let line = `[job:${job.id}] [${safeLevel.toUpperCase()}] ${message}`;
  if (details !== undefined) {
    try {
      line += ` | ${typeof details === "string" ? details : JSON.stringify(details)}`;
    } catch (_error) {
      line += " | [unserializable-details]";
    }
  }
  console.log(line);
}

function getStage(stageKey) {
  return WORKFLOW_STAGES[stageKey] || WORKFLOW_STAGES.mailbox;
}

function buildQueuedProgress() {
  return {
    stageKey: "queued",
    stageLabel: "Queued",
    stageCurrent: 0,
    stageTotal: WORKFLOW_STAGES.validation.total,
    detail: "Waiting for worker",
    completed: 0,
    total: 0,
    stagePercent: 0,
    percent: 0,
    phase: "Queued",
  };
}

function setProgress(job, stageKey, completed, total, detail = "") {
  const stage = getStage(stageKey);
  const safeCompleted = Math.max(0, Number(completed) || 0);
  const safeTotal = Math.max(0, Number(total) || 0);
  const stageRatio = safeTotal > 0 ? Math.min(1, safeCompleted / safeTotal) : 1;
  const overallRatio = ((stage.index - 1) + stageRatio) / stage.total;

  job.progress = {
    stageKey: stage.key,
    stageLabel: stage.label,
    stageCurrent: stage.index,
    stageTotal: stage.total,
    detail: detail || "",
    completed: safeCompleted,
    total: safeTotal,
    stagePercent: Math.round(stageRatio * 100),
    percent: Math.round(overallRatio * 100),
    phase: stage.label,
  };
  job.updatedAt = nowIso();
}

function setFailedProgress(job, detail) {
  const existing = job.progress || buildQueuedProgress();
  job.progress = {
    ...existing,
    detail: detail || existing.detail || "Workflow failed",
    phase: "Failed",
    failed: true,
  };
  job.updatedAt = nowIso();
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function formatDurationMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function redactEmail(email) {
  if (!email || !String(email).includes("@")) return "";
  const [local, domain] = String(email).split("@");
  if (!local) return `***@${domain}`;
  const prefix = local.slice(0, 2);
  return `${prefix}***@${domain}`;
}

function sanitizeConfigForLogs(config) {
  return {
    mailcowUrl: config.mailcowUrl,
    domain: config.domain,
    count: config.count,
    localPrefix: config.localPrefix,
    localLength: config.localLength,
    quota: config.quota,
    namePrefix: config.namePrefix,
    webmailUrl: config.webmailUrl,
    appName: config.appName,
    headless: config.headless,
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    smtpUseTls: config.smtpUseTls,
    receiverEmail: redactEmail(config.receiverEmail),
    imapHost: config.imapHost,
    imapPort: config.imapPort,
    hasMailcowApiKey: Boolean(config.mailcowApiKey),
    hasReceiverPassword: Boolean(config.receiverPassword),
  };
}

function serializeError(error) {
  if (!error) return { message: "Unknown error" };
  return {
    name: error.name || "Error",
    message: error.message || "Unknown error",
    stack: error.stack || "",
  };
}

function logStepStart(job, step, details) {
  const startedAtMs = Date.now();
  addLog(job, "debug", `${step} started`, details);
  return startedAtMs;
}

function logStepSuccess(job, step, startedAtMs, details) {
  const duration = Date.now() - startedAtMs;
  addLog(job, "debug", `${step} completed in ${formatDurationMs(duration)}`, details);
}

function logStepFailure(job, step, startedAtMs, error, details) {
  const duration = Date.now() - startedAtMs;
  addLog(job, "error", `${step} failed after ${formatDurationMs(duration)}`, {
    ...(details || {}),
    error: serializeError(error),
  });
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function envString(name, fallback = "") {
  const value = process.env[name];
  if (value === undefined || value === null) {
    return fallback;
  }
  const trimmed = String(value).trim();
  return trimmed === "" ? fallback : trimmed;
}

function normalizeBaseUrl(value) {
  if (!value) {
    return "";
  }
  return String(value).trim().replace(/\/+$/, "");
}

function inferImapHost(emailAddress) {
  const domain = String(emailAddress || "").split("@")[1] || "";
  if (!domain) {
    return "";
  }
  if (domain.includes("gmail.com")) {
    return "imap.gmail.com";
  }
  if (domain.includes("outlook.com") || domain.includes("hotmail.com") || domain.includes("live.com")) {
    return "outlook.office365.com";
  }
  if (domain.includes("yahoo.com")) {
    return "imap.mail.yahoo.com";
  }
  return `mail.${domain}`;
}

function escapeCsvValue(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function rowsToCsv(rows) {
  const columns = [
    "email",
    "password",
    "name",
    "quota",
    "app_password",
    "mailbox_created",
    "app_password_generated",
    "smtp_sent",
    "imap_verified",
    "status",
    "error",
  ];

  const header = columns.join(",");
  const lines = rows.map((row) => {
    return columns
      .map((col) => {
        const value = row[col];
        return escapeCsvValue(value);
      })
      .join(",");
  });

  return [header, ...lines].join("\n");
}

function cloneJobForClient(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    logs: job.logs,
    rows: job.rows,
    summary: job.summary,
    error: job.error,
    csvPath: job.csvPath ? `/api/jobs/${job.id}/csv` : null,
    config: job.configPublic,
  };
}

function summarize(job) {
  const rows = job.rows;
  const total = rows.length;
  const mailboxCreated = rows.filter((r) => r.mailbox_created).length;
  const appPasswords = rows.filter((r) => r.app_password_generated).length;
  const smtpSent = rows.filter((r) => r.smtp_sent).length;
  const imapVerified = rows.filter((r) => r.imap_verified).length;
  const success = rows.filter((r) => r.status === "SUCCESS").length;
  const failed = rows.filter((r) => r.status === "FAILED").length;

  return {
    total,
    mailboxCreated,
    appPasswords,
    smtpSent,
    imapVerified,
    success,
    failed,
  };
}

function updateRowStatus(row, requireImapVerification) {
  const imapRequirementSatisfied = requireImapVerification ? row.imap_verified === true : true;
  const baseSuccess = row.mailbox_created && row.app_password_generated && row.smtp_sent;
  row.status = baseSuccess && imapRequirementSatisfied ? "SUCCESS" : "FAILED";
}

function appendRowError(row, text) {
  if (!text) {
    return;
  }
  if (!row.error) {
    row.error = text;
    return;
  }
  row.error = `${row.error} | ${text}`;
}

async function callJson(url, options) {
  const response = await fetch(url, options);
  const raw = await response.text();

  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (_error) {
      data = raw;
    }
  }

  return { ok: response.ok, status: response.status, data, raw };
}

function parseMailcowApiResult(payload) {
  if (Array.isArray(payload) && payload.length > 0) {
    const type = String(payload[0].type || "").toLowerCase();
    const msg = payload[0].msg || "Mailcow response";
    if (type === "success") {
      return { ok: true, message: msg };
    }
    return { ok: false, message: msg };
  }

  if (payload && typeof payload === "object") {
    const type = String(payload.type || "").toLowerCase();
    const msg = payload.msg || "Mailcow response";
    if (type === "success") {
      return { ok: true, message: msg };
    }
    return { ok: false, message: msg };
  }

  return { ok: false, message: "Unexpected Mailcow response format" };
}

async function createMailboxViaApi(config, row) {
  const endpoint = `${config.mailcowUrl}/api/v1/add/mailbox`;
  const payload = {
    active: 1,
    domain: config.domain,
    local_part: row.email.split("@")[0],
    name: row.name,
    password: row.password,
    password2: row.password,
    quota: row.quota,
    force_pw_update: 0,
    tls_enforce_in: 0,
    tls_enforce_out: 0,
  };

  const result = await callJson(endpoint, {
    method: "POST",
    headers: {
      "X-API-Key": config.mailcowApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!result.ok && result.status >= 400) {
    return { ok: false, message: `HTTP ${result.status}`, httpStatus: result.status };
  }

  return { ...parseMailcowApiResult(result.data), httpStatus: result.status };
}

async function configureAppPasswordProtocols(page) {
  await page.click('button[data-id="protocols"]');
  await page.waitForTimeout(350);

  const unwantedProtocols = ["POP3", "Sieve", "EAS", "CardDAV"];
  for (const protocol of unwantedProtocols) {
    const item = page.locator(`.dropdown-menu.show .dropdown-item:has-text("${protocol}")`).first();
    if ((await item.count()) > 0) {
      const className = (await item.getAttribute("class")) || "";
      if (className.includes("active") || className.includes("selected")) {
        await item.click();
      }
    }
  }

  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
}

async function createAppPasswordInWebmail(config, row, appPassword, browser, trace) {
  const logTrace = typeof trace === "function" ? trace : () => { };
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  let currentStep = "initialize-browser-context";

  try {
    currentStep = "open-login-page";
    logTrace("Opening webmail login page");
    await page.goto(`${config.webmailUrl}/user`, { timeout: 60_000 });

    currentStep = "submit-login-form";
    logTrace("Submitting login form");
    await page.fill("#login_user", row.email, { timeout: 10_000 });
    await page.fill("#pass_user", row.password, { timeout: 10_000 });
    await page.click('button[value="Login"]');

    currentStep = "wait-post-login";
    await page.waitForTimeout(1_300);
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });

    currentStep = "verify-login-state";
    const loginFieldVisible = await page
      .locator("#login_user")
      .first()
      .isVisible()
      .catch(() => false);

    if (loginFieldVisible) {
      return { ok: false, message: "Login failed in webmail" };
    }

    currentStep = "open-user-page";
    logTrace("Opening user settings page");
    await page.goto(`${config.webmailUrl}/user`, { timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { });

    currentStep = "open-app-password-tab";
    const tabButton = page.locator('button[data-bs-target="#AppPasswds"]').first();
    if ((await tabButton.count()) > 0 && (await tabButton.isVisible())) {
      await tabButton.click();
    } else {
      await page.getByText("App passwords", { exact: false }).first().click();
    }

    await page.waitForTimeout(800);

    currentStep = "check-existing-app-password";
    const paneText = await page.locator("#AppPasswds").innerText().catch(() => "");
    if (paneText.toLowerCase().includes(config.appName.toLowerCase())) {
      return { ok: false, message: `App password '${config.appName}' already exists` };
    }

    currentStep = "open-create-app-password-modal";
    const createButton = page.locator('a[data-bs-target="#addAppPasswdModal"]').first();
    if ((await createButton.count()) === 0) {
      return { ok: false, message: "Create app password button not found" };
    }

    await createButton.click();
    await page.waitForSelector("#addAppPasswdModal.show", { state: "visible", timeout: 8_000 });

    currentStep = "fill-app-password-form";
    await page.fill('input[name="app_name"]', config.appName);
    await page.fill('input[name="app_passwd"]', appPassword);
    await page.fill('input[name="app_passwd2"]', appPassword);

    currentStep = "configure-protocols";
    await configureAppPasswordProtocols(page);

    currentStep = "submit-app-password-form";
    await page.click("#addAppPasswdModal button.btn-success");
    await page.waitForSelector("#addAppPasswdModal", { state: "hidden", timeout: 12_000 });

    return { ok: true, message: "App password created" };
  } catch (error) {
    return {
      ok: false,
      message: error.message || "Unknown Playwright error",
      step: currentStep,
    };
  } finally {
    await context.close();
  }
}

async function sendSmtpValidation(config, row, subject, targetEmail, trace) {
  const logTrace = typeof trace === "function" ? trace : () => { };
  const secureConnection = Number(config.smtpPort) === 465;
  logTrace("Creating SMTP transport", {
    host: config.smtpHost,
    port: Number(config.smtpPort),
    secureConnection,
    requireTLS: !secureConnection && Boolean(config.smtpUseTls),
  });

  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: Number(config.smtpPort),
    secure: secureConnection,
    requireTLS: !secureConnection && Boolean(config.smtpUseTls),
    auth: {
      user: row.email,
      pass: row.app_password,
    },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 20_000,
    tls: {
      rejectUnauthorized: false,
    },
  });

  logTrace("Verifying SMTP transport");
  await transport.verify();
  logTrace("SMTP transport verified, sending message");
  await transport.sendMail({
    from: row.email,
    to: targetEmail,
    subject,
    text: `SMTP validation for ${row.email} at ${nowIso()}`,
  });

  logTrace("SMTP message sent, closing transport");
  transport.close();
}

async function getReceiverSubjects(config, sinceDate, trace) {
  const logTrace = typeof trace === "function" ? trace : () => { };
  const client = new ImapFlow({
    host: config.imapHost,
    port: Number(config.imapPort),
    secure: true,
    auth: {
      user: config.receiverEmail,
      pass: config.receiverPassword,
    },
    logger: false,
  });

  const subjects = new Set();

  try {
    logTrace("Connecting to IMAP server", {
      host: config.imapHost,
      port: Number(config.imapPort),
      receiverEmail: redactEmail(config.receiverEmail),
      sinceDate: sinceDate.toISOString(),
    });
    await client.connect();
    logTrace("Connected to IMAP");

    const lock = await client.getMailboxLock("INBOX");
    try {
      logTrace("Mailbox lock acquired for INBOX");
      const messageIds = await client.search({ since: sinceDate });
      logTrace("Fetched IMAP message IDs", { totalIds: messageIds.length });
      for await (const message of client.fetch(messageIds, { envelope: true })) {
        if (message.envelope && message.envelope.subject) {
          subjects.add(message.envelope.subject);
        }
      }
      logTrace("Finished fetching IMAP envelopes", { subjectCount: subjects.size });
    } finally {
      lock.release();
      logTrace("Released mailbox lock");
    }
  } finally {
    logTrace("Logging out from IMAP");
    await client.logout().catch(() => { });
  }

  return subjects;
}

async function writeJobCsv(job) {
  const csv = rowsToCsv(job.rows);
  const filePath = path.join(OUTPUT_DIR, `${job.id}.csv`);
  await fsPromises.writeFile(filePath, csv, "utf8");
  job.csvPath = filePath;
}

async function runWorkflow(job, config) {
  const workflowStart = Date.now();
  job.status = "running";
  job.startedAt = nowIso();
  addLog(job, "info", "Workflow started");
  addLog(job, "info", "Runtime configuration loaded", sanitizeConfigForLogs(config));

  const generationStepStart = logStepStart(job, "record-generation", { requestedCount: config.count });
  const rows = [];
  for (let index = 0; index < config.count; index += 1) {
    const localPart = buildMailboxLocalPart(config.localPrefix, config.localLength);
    rows.push({
      email: `${localPart}@${config.domain}`,
      password: buildMailboxPassword(),
      name: `${config.namePrefix} ${index + 1}`,
      quota: config.quota,
      app_password: "",
      mailbox_created: false,
      app_password_generated: false,
      smtp_sent: false,
      imap_verified: false,
      status: "PENDING",
      error: "",
      smtp_subject: "",
    });
  }
  logStepSuccess(job, "record-generation", generationStepStart, {
    generatedRows: rows.length,
    sampleEmails: rows.slice(0, 3).map((r) => redactEmail(r.email)),
  });

  job.rows = rows;
  addLog(job, "info", `Generated ${rows.length} mailbox records`);

  const mailboxPhaseStart = logStepStart(job, "phase:create-mailboxes", { totalRows: rows.length });
  setProgress(job, "mailbox", 0, rows.length, "Preparing mailbox creation");
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const rowCreateStart = logStepStart(job, "mailbox-create-row", {
      index: i + 1,
      total: rows.length,
      email: row.email,
    });

    const result = await createMailboxViaApi(config, row);
    row.mailbox_created = result.ok;
    if (result.ok) {
      addLog(job, "info", `[${i + 1}/${rows.length}] Mailbox created: ${row.email}`, {
        httpStatus: result.httpStatus,
      });
      logStepSuccess(job, "mailbox-create-row", rowCreateStart, {
        index: i + 1,
        email: row.email,
        httpStatus: result.httpStatus,
      });
    } else {
      appendRowError(row, `Create mailbox failed: ${result.message}`);
      const failureError = new Error(result.message || "Mailbox create failed");
      addLog(job, "error", `[${i + 1}/${rows.length}] Mailbox create failed: ${row.email} (${result.message})`, {
        httpStatus: result.httpStatus,
      });
      logStepFailure(job, "mailbox-create-row", rowCreateStart, failureError, {
        index: i + 1,
        email: row.email,
        httpStatus: result.httpStatus,
      });
    }

    setProgress(job, "mailbox", i + 1, rows.length, `Created ${i + 1} of ${rows.length} mailboxes`);
    await wait(120);
  }
  logStepSuccess(job, "phase:create-mailboxes", mailboxPhaseStart, {
    attempted: rows.length,
    created: rows.filter((r) => r.mailbox_created).length,
    failed: rows.filter((r) => !r.mailbox_created).length,
  });

  const rowsReadyForAppPassword = rows.filter((r) => r.mailbox_created);
  addLog(job, "info", `${rowsReadyForAppPassword.length} mailbox(es) eligible for app password generation`);

  if (rowsReadyForAppPassword.length > 0) {
    const appPasswordPhaseStart = logStepStart(job, "phase:generate-app-passwords", {
      eligibleRows: rowsReadyForAppPassword.length,
      headless: config.headless,
    });
    const browserLaunchStart = logStepStart(job, "playwright-launch-browser", { headless: config.headless });
    const browser = await chromium.launch({ headless: config.headless });
    logStepSuccess(job, "playwright-launch-browser", browserLaunchStart);

    try {
      setProgress(job, "appPassword", 0, rowsReadyForAppPassword.length, "Opening webmail automation");

      for (let i = 0; i < rowsReadyForAppPassword.length; i += 1) {
        const row = rowsReadyForAppPassword[i];
        const appPassword = buildAppPassword();
        const rowAppPasswordStart = logStepStart(job, "app-password-row", {
          index: i + 1,
          total: rowsReadyForAppPassword.length,
          email: row.email,
          appName: config.appName,
        });

        const result = await createAppPasswordInWebmail(config, row, appPassword, browser, (message, details) => {
          addLog(job, "debug", `[${i + 1}/${rowsReadyForAppPassword.length}] ${row.email} :: ${message}`, details);
        });
        row.app_password_generated = result.ok;

        if (result.ok) {
          row.app_password = appPassword;
          addLog(job, "info", `[${i + 1}/${rowsReadyForAppPassword.length}] App password created: ${row.email}`);
          logStepSuccess(job, "app-password-row", rowAppPasswordStart, {
            index: i + 1,
            email: row.email,
          });
        } else {
          appendRowError(row, `App password failed: ${result.message}`);
          const failureError = new Error(result.message || "App password creation failed");
          addLog(job, "error", `[${i + 1}/${rowsReadyForAppPassword.length}] App password failed: ${row.email} (${result.message})`, {
            step: result.step || "unknown",
          });
          logStepFailure(job, "app-password-row", rowAppPasswordStart, failureError, {
            index: i + 1,
            email: row.email,
            step: result.step || "unknown",
          });
        }

        setProgress(
          job,
          "appPassword",
          i + 1,
          rowsReadyForAppPassword.length,
          `Generated ${i + 1} of ${rowsReadyForAppPassword.length} app passwords`
        );
      }
    } finally {
      const browserCloseStart = logStepStart(job, "playwright-close-browser");
      await browser.close();
      logStepSuccess(job, "playwright-close-browser", browserCloseStart);
      logStepSuccess(job, "phase:generate-app-passwords", appPasswordPhaseStart, {
        attempted: rowsReadyForAppPassword.length,
        generated: rows.filter((r) => r.app_password_generated).length,
        failed: rows.filter((r) => r.mailbox_created && !r.app_password_generated).length,
      });
    }
  } else {
    setProgress(job, "appPassword", 0, 0, "Skipped: no mailbox available for app password generation");
    addLog(job, "warn", "No mailboxes qualified for app password generation");
  }

  const rowsReadyForSmtp = rows.filter((r) => r.app_password_generated);
  addLog(job, "info", `${rowsReadyForSmtp.length} mailbox(es) eligible for SMTP validation`);
  const requiresImap = Boolean(config.receiverPassword && config.receiverEmail);

  if (!config.receiverEmail) {
    addLog(
      job,
      "warn",
      "VALIDATION_RECEIVER_EMAIL not set. SMTP validation will send each email to itself."
    );
  }

  const smtpPhaseStart = logStepStart(job, "phase:smtp-validation", {
    eligibleRows: rowsReadyForSmtp.length,
    host: config.smtpHost,
    port: config.smtpPort,
  });
  const validationTotalUnits = requiresImap ? rowsReadyForSmtp.length * 2 : rowsReadyForSmtp.length;
  setProgress(job, "validation", 0, validationTotalUnits, "Preparing SMTP validation");
  const smtpStartDate = new Date();

  for (let i = 0; i < rowsReadyForSmtp.length; i += 1) {
    const row = rowsReadyForSmtp[i];
    const subject = `SMTP Check ${job.id}-${i + 1}-${crypto.randomBytes(3).toString("hex")}`;
    const targetEmail = config.receiverEmail || row.email;
    const smtpRowStart = logStepStart(job, "smtp-row", {
      index: i + 1,
      total: rowsReadyForSmtp.length,
      email: row.email,
      subject,
      targetEmail,
    });

    try {
      await sendSmtpValidation(config, row, subject, targetEmail, (message, details) => {
        addLog(job, "debug", `[${i + 1}/${rowsReadyForSmtp.length}] ${row.email} :: ${message}`, details);
      });
      row.smtp_sent = true;
      row.smtp_subject = subject;
      addLog(job, "info", `[${i + 1}/${rowsReadyForSmtp.length}] SMTP sent: ${row.email} -> ${targetEmail}`);
      logStepSuccess(job, "smtp-row", smtpRowStart, {
        index: i + 1,
        email: row.email,
        targetEmail,
      });
    } catch (error) {
      appendRowError(row, `SMTP send failed: ${error.message || "Unknown SMTP error"}`);
      addLog(job, "error", `[${i + 1}/${rowsReadyForSmtp.length}] SMTP failed: ${row.email} (${error.message})`);
      logStepFailure(job, "smtp-row", smtpRowStart, error, {
        index: i + 1,
        email: row.email,
      });
    }

    setProgress(
      job,
      "validation",
      i + 1,
      validationTotalUnits,
      `SMTP validated ${i + 1} of ${rowsReadyForSmtp.length} accounts`
    );
    await wait(150);
  }
  logStepSuccess(job, "phase:smtp-validation", smtpPhaseStart, {
    attempted: rowsReadyForSmtp.length,
    sent: rows.filter((r) => r.smtp_sent).length,
    failed: rows.filter((r) => r.app_password_generated && !r.smtp_sent).length,
  });

  if (requiresImap) {
    const imapPhaseStart = logStepStart(job, "phase:imap-verification", {
      receiverEmail: redactEmail(config.receiverEmail),
      imapHost: config.imapHost,
      imapPort: config.imapPort,
    });
    addLog(job, "info", "Waiting 20 seconds before IMAP verification");
    await wait(20_000);

    const smtpSubjects = new Set(rowsReadyForSmtp.filter((r) => r.smtp_sent).map((r) => r.smtp_subject));
    setProgress(
      job,
      "validation",
      rowsReadyForSmtp.length,
      validationTotalUnits,
      "Waiting for IMAP verification window"
    );
    addLog(job, "debug", "Prepared IMAP subject correlation set", {
      subjectCount: smtpSubjects.size,
    });

    try {
      const foundSubjects = await getReceiverSubjects(config, smtpStartDate, (message, details) => {
        addLog(job, "debug", `IMAP :: ${message}`, details);
      });
      let verifiedCount = 0;
      let processedCount = 0;

      for (const row of rowsReadyForSmtp) {
        if (!row.smtp_sent) {
          processedCount += 1;
          setProgress(
            job,
            "validation",
            rowsReadyForSmtp.length + processedCount,
            validationTotalUnits,
            `IMAP verified ${verifiedCount} of ${rowsReadyForSmtp.length} accounts`
          );
          continue;
        }

        if (foundSubjects.has(row.smtp_subject)) {
          row.imap_verified = true;
          verifiedCount += 1;
          addLog(job, "debug", `IMAP verified for ${row.email}`, { subject: row.smtp_subject });
        } else {
          row.imap_verified = false;
          appendRowError(row, "Email not found in receiver inbox during IMAP verification");
          addLog(job, "warn", `IMAP could not verify ${row.email}`, { subject: row.smtp_subject });
        }

        processedCount += 1;
        setProgress(
          job,
          "validation",
          rowsReadyForSmtp.length + processedCount,
          validationTotalUnits,
          `IMAP verified ${verifiedCount} of ${rowsReadyForSmtp.length} accounts`
        );
      }

      addLog(job, "info", `IMAP verification complete: ${verifiedCount}/${smtpSubjects.size}`);
      logStepSuccess(job, "phase:imap-verification", imapPhaseStart, {
        verified: verifiedCount,
        expected: smtpSubjects.size,
      });
    } catch (error) {
      addLog(job, "error", `IMAP verification failed: ${error.message}`);
      logStepFailure(job, "phase:imap-verification", imapPhaseStart, error, {
        expectedSubjects: smtpSubjects.size,
      });
      for (const row of rowsReadyForSmtp) {
        if (row.smtp_sent && !row.imap_verified) {
          appendRowError(row, `IMAP verification error: ${error.message}`);
        }
      }
    }
  } else {
    setProgress(job, "validation", rowsReadyForSmtp.length, rowsReadyForSmtp.length, "IMAP skipped (not configured)");
    addLog(job, "warn", "Receiver app password not provided. IMAP verification skipped.");
  }

  const finalizationStart = logStepStart(job, "phase:finalization");
  for (const row of rows) {
    updateRowStatus(row, requiresImap);
  }

  job.summary = summarize(job);
  addLog(job, "debug", "Computed workflow summary", job.summary);
  await writeJobCsv(job);
  addLog(job, "info", "Result CSV written", {
    path: `${job.id}.csv`,
  });

  job.status = job.summary.failed > 0 ? "completed_with_errors" : "completed";
  job.finishedAt = nowIso();
  job.updatedAt = nowIso();
  setProgress(job, "validation", 1, 1, "Workflow completed");
  logStepSuccess(job, "phase:finalization", finalizationStart);

  addLog(
    job,
    "info",
    `Workflow complete. Success: ${job.summary.success}, Failed: ${job.summary.failed}`,
    { totalDuration: formatDurationMs(Date.now() - workflowStart) }
  );
}

function buildRuntimeConfigFromEnv() {
  const mailcowUrl = normalizeBaseUrl(envString("MAILCOW_URL", "https://mail.cazehiresense.com"));
  const receiverEmail = envString("VALIDATION_RECEIVER_EMAIL", "");
  const inferredImapHost = inferImapHost(receiverEmail);

  return {
    mailcowUrl,
    mailcowApiKey: envString("MAILCOW_API_KEY", ""),
    domain: envString("MAIL_DOMAIN", "cazehiresense.com"),
    localPrefix: envString("MAIL_LOCAL_PREFIX", "hs"),
    localLength: Math.max(3, Math.min(16, toInteger(envString("MAIL_LOCAL_LENGTH", "7"), 7))),
    quota: Math.max(0, toInteger(envString("MAILBOX_QUOTA_MB", "0"), 0)),
    namePrefix: envString("MAILBOX_NAME_PREFIX", "User"),
    webmailUrl: normalizeBaseUrl(envString("WEBMAIL_URL", mailcowUrl)),
    appName: envString("APP_PASSWORD_NAME", "hiresense"),
    headless: toBoolean(process.env.PLAYWRIGHT_HEADLESS, true),
    smtpHost: envString("SMTP_HOST", "mail.cazehiresense.com"),
    smtpPort: Math.max(1, toInteger(envString("SMTP_PORT", "587"), 587)),
    smtpUseTls: toBoolean(process.env.SMTP_USE_TLS, true),
    receiverEmail,
    receiverPassword: envString("VALIDATION_RECEIVER_APP_PASSWORD", ""),
    imapHost: envString("IMAP_HOST", inferredImapHost),
    imapPort: Math.max(1, toInteger(envString("IMAP_PORT", "993"), 993)),
  };
}

function validateAndBuildConfig(raw) {
  const runtimeConfig = buildRuntimeConfigFromEnv();
  const deploymentOptions = ["prod", "staging", "dev", "demo", "cazelabs"];
  const rawDeployment = String(raw.deployment || "dev").trim().toLowerCase();
  const deployment = deploymentOptions.includes(rawDeployment) ? rawDeployment : "dev";

  const config = {
    ...runtimeConfig,
    count: toInteger(raw.count, 0),
    deployment,
  };

  const errors = [];
  if (!config.mailcowUrl) errors.push("MAILCOW_URL is missing");
  if (!config.webmailUrl) errors.push("WEBMAIL_URL is missing");
  if (!config.mailcowApiKey) errors.push("MAILCOW_API_KEY is missing");
  if (!config.domain) errors.push("MAIL_DOMAIN is missing");
  if (!config.count || config.count < 1) errors.push("count must be at least 1");
  if (!config.smtpHost) errors.push("SMTP_HOST is missing");

  if (config.receiverPassword && !config.receiverEmail) {
    errors.push("VALIDATION_RECEIVER_EMAIL is required when VALIDATION_RECEIVER_APP_PASSWORD is set");
  }
  if (config.receiverEmail && !config.receiverPassword) {
    errors.push("VALIDATION_RECEIVER_APP_PASSWORD is required when VALIDATION_RECEIVER_EMAIL is set");
  }
  if (config.receiverEmail && config.receiverPassword && !config.imapHost) {
    errors.push("IMAP_HOST is missing (or receiver email domain is invalid)");
  }

  return { config, errors };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, now: nowIso() });
});

app.get("/api/jobs", (_req, res) => {
  const allJobs = Array.from(jobs.values())
    .map((job) => cloneJobForClient(job))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ jobs: allJobs });
});

app.post("/api/jobs", async (req, res) => {
  const incomingCount = toInteger(req?.body?.count, 0);
  console.log(`[api] POST /api/jobs received | count=${incomingCount}`);
  const { config, errors } = validateAndBuildConfig(req.body || {});
  if (errors.length > 0) {
    console.warn(`[api] Job request rejected | errors=${JSON.stringify(errors)}`);
    return res.status(400).json({ error: "Invalid input", details: errors });
  }

  await fsPromises.mkdir(OUTPUT_DIR, { recursive: true });

  const id = crypto.randomUUID();
  const job = {
    id,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    progress: buildQueuedProgress(),
    logs: [],
    rows: [],
    summary: null,
    error: null,
    csvPath: null,
    configPublic: {
      count: config.count,
      deployment: config.deployment,
      domain: config.domain,
      appName: config.appName,
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      receiverEmail: config.receiverEmail || "(self)",
      imapHost: config.imapHost,
      imapVerificationEnabled: Boolean(config.receiverEmail && config.receiverPassword),
    },
  };

  jobs.set(id, job);
  addLog(job, "info", "Job queued", {
    requestCount: incomingCount,
    config: sanitizeConfigForLogs(config),
  });

  runWorkflow(job, config).catch((error) => {
    job.status = "failed";
    job.error = error.message || "Unexpected workflow error";
    job.finishedAt = nowIso();
    job.updatedAt = nowIso();
    setFailedProgress(job, "Workflow failed");
    addLog(job, "error", `Workflow failed: ${job.error}`, {
      error: serializeError(error),
    });
  });

  console.log(`[api] Job accepted | jobId=${id}`);
  return res.status(202).json({ jobId: id });
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  return res.json({ job: cloneJobForClient(job) });
});

app.get("/api/jobs/:jobId/csv", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.csvPath || !fs.existsSync(job.csvPath)) {
    return res.status(404).json({ error: "CSV not available" });
  }

  res.download(job.csvPath, `${job.id}-results.csv`);
});

app.post("/api/jobs/:jobId/deploy", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  const steps = [];
  const addStep = (name, status, detail = "", error = "") => {
    steps.push({ name, status, detail, error });
  };

  // --- Step 1: Validate job data ---
  if (!job.rows || job.rows.length === 0) {
    addStep("Validate job data", "failed", "No workflow data available", "Job has no rows to deploy");
    return res.status(400).json({ error: "No workflow data available for deployment", steps });
  }

  const deployment = String(job.configPublic?.deployment || "dev").toLowerCase();
  const envChoice = DEPLOY_CHOICE_MAP[deployment];
  if (!envChoice) {
    addStep("Validate job data", "failed", `Invalid deployment target: ${deployment}`, `Unknown deployment "${deployment}"`);
    return res.status(400).json({ error: `Invalid deployment target: ${deployment}`, steps });
  }

  if (!fs.existsSync(ENCRYPT_SCRIPT)) {
    addStep("Validate job data", "failed", "Encrypt script not found", `Script not found at ${ENCRYPT_SCRIPT}. Check Docker volume mount.`);
    return res.status(500).json({ error: "Encrypt script not found. Verify the Docker volume mount for /mnt/db-mgmt is configured.", steps });
  }

  const decryptKey = process.env.EMAIL_POOL_DECRYPT_KEY_BASE64 || "";
  if (!decryptKey) {
    addStep("Validate job data", "failed", "Decrypt key missing", "EMAIL_POOL_DECRYPT_KEY_BASE64 is not set in the environment.");
    return res.status(500).json({ error: "EMAIL_POOL_DECRYPT_KEY_BASE64 is not set in the environment.", steps });
  }

  const successRows = job.rows.filter((row) => {
    const hasAppPassword = row.app_password && String(row.app_password).trim() !== "";
    const isSuccess = String(row.status || "").toUpperCase() === "SUCCESS";
    const appPasswordGenerated = row.app_password_generated &&
      ["1", "true", "yes", "y"].includes(String(row.app_password_generated || "").toLowerCase());
    return hasAppPassword && (isSuccess || appPasswordGenerated);
  });

  if (successRows.length === 0) {
    addStep("Validate job data", "failed", "No eligible credentials", "No successfully generated app passwords available for deployment");
    return res.status(400).json({ error: "No successfully generated app passwords available for deployment", steps });
  }

  addStep("Validate job data", "success", `${successRows.length} credential(s) eligible for ${deployment} deployment`);

  // --- Step 2: Build and write TSV file ---
  const tsvLines = [];
  for (const row of successRows) {
    const email = String(row.email || "").replace(/\t/g, " ");
    const appPassword = String(row.app_password || "").replace(/\t/g, " ");
    tsvLines.push(`${email}\t${appPassword}`);
  }
  const tsvData = tsvLines.join("\n") + "\n";

  try {
    const tsvDir = path.dirname(TSV_INPUT_PATH);
    await fsPromises.mkdir(tsvDir, { recursive: true });
    await fsPromises.writeFile(TSV_INPUT_PATH, tsvData, "utf8");
    addStep("Write TSV file", "success", `Wrote ${successRows.length} row(s) to ${path.basename(TSV_INPUT_PATH)}`);
  } catch (tsvError) {
    addStep("Write TSV file", "failed", "Could not write credentials file", tsvError.message);
    console.error(`[api] TSV write error | jobId=${job.id} | error=${tsvError.message}`);
    return res.status(500).json({ error: "Failed to write TSV file", steps });
  }

  // --- Step 3: Execute encrypt script ---
  console.log(`[api] Deploying ${successRows.length} credentials via encrypt script | jobId=${job.id} | deployment=${deployment} | envChoice=${envChoice}`);

  try {
    const scriptResult = await new Promise((resolve) => {
      let stdout = "";
      let stderr = "";

      const proc = spawn("bash", [ENCRYPT_SCRIPT], {
        cwd: DB_MGMT_MOUNT,
        env: {
          ...process.env,
          EMAIL_POOL_DECRYPT_KEY_BASE64: decryptKey,
          PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      });

      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      proc.stdin.write(`${envChoice}\n`);
      proc.stdin.end();

      proc.on("close", (code) => {
        resolve({ code, stdout, stderr });
      });

      proc.on("error", (err) => {
        resolve({ code: -1, stdout, stderr: stderr + err.message });
      });
    });

    console.log(`[api] Script exit code: ${scriptResult.code}`);
    if (scriptResult.stdout) console.log(`[api] Script stdout:\n${scriptResult.stdout}`);
    if (scriptResult.stderr) console.warn(`[api] Script stderr:\n${scriptResult.stderr}`);

    if (scriptResult.code !== 0) {
      addStep("Execute encrypt script", "failed", `Exit code: ${scriptResult.code}`, scriptResult.stderr || scriptResult.stdout || "Script exited with non-zero code");
      return res.status(500).json({
        error: "Encrypt script failed",
        exitCode: scriptResult.code,
        stdout: scriptResult.stdout,
        stderr: scriptResult.stderr,
        steps,
      });
    }

    addStep("Execute encrypt script", "success", "Script completed successfully");

    // --- Step 4: Parse script output for sub-steps ---
    const outputLines = (scriptResult.stdout || "").split("\n").filter((l) => l.trim());
    for (const line of outputLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Detect common meaningful lines from the shell script output
      if (/encrypt/i.test(trimmed)) {
        addStep("Encrypt email pool", "success", trimmed);
      } else if (/git\s+(add|stage)/i.test(trimmed)) {
        addStep("Git stage changes", "success", trimmed);
      } else if (/git\s+commit/i.test(trimmed)) {
        addStep("Git commit", "success", trimmed);
      } else if (/git\s+push/i.test(trimmed)) {
        addStep("Git push", "success", trimmed);
      } else if (/done|complete|success|finished/i.test(trimmed)) {
        addStep("Finalization", "success", trimmed);
      }
    }

    return res.json({
      success: true,
      message: "Credentials encrypted and deployed successfully",
      credentialsCount: successRows.length,
      deployment,
      scriptOutput: scriptResult.stdout,
      steps,
    });
  } catch (error) {
    addStep("Execute encrypt script", "failed", "Unexpected error", error.message);
    console.error(`[api] Deployment error | jobId=${job.id} | error=${error.message}`);
    return res.status(500).json({
      error: "Deployment failed",
      details: error.message,
      steps,
    });
  }
});

process.on("unhandledRejection", (reason) => {
  const payload = reason instanceof Error ? serializeError(reason) : { reason: String(reason) };
  console.error("[global] Unhandled promise rejection", payload);
  for (const job of jobs.values()) {
    if (job.status === "running" || job.status === "queued") {
      addLog(job, "error", "Global unhandled promise rejection observed", payload);
    }
  }
});

process.on("uncaughtException", (error) => {
  const payload = serializeError(error);
  console.error("[global] Uncaught exception", payload);
  for (const job of jobs.values()) {
    if (job.status === "running" || job.status === "queued") {
      addLog(job, "error", "Global uncaught exception observed", payload);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Web UI running at http://localhost:${PORT}`);
});
