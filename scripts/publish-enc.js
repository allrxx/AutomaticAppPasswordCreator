#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT_DIR = path.join(ROOT_DIR, "web", "output");
const DEFAULT_USERS_TSV_PATH = path.join(ROOT_DIR, "users.tsv");
const REMOTE_ENV_CHOICES = Object.freeze({
  prod: "1",
  staging: "2",
  dev: "3",
  demo: "4",
  cazelabs: "5",
});
const REMOTE_ENV_NAMES_BY_CHOICE = Object.freeze(
  Object.entries(REMOTE_ENV_CHOICES).reduce((acc, [name, choice]) => {
    acc[choice] = name;
    return acc;
  }, {})
);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.trim();

    if (!key) continue;
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function envOrArg(args, argKey, envKey, fallback = "") {
  if (args[argKey] !== undefined) return String(args[argKey]);
  if (process.env[envKey] !== undefined) return String(process.env[envKey]);
  return fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;

  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function parseColumns(raw) {
  return String(raw || "")
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);
}

function normalizeTargetEnv(raw) {
  const input = String(raw || "dev").trim().toLowerCase();
  if (REMOTE_ENV_CHOICES[input]) {
    return { name: input, choice: REMOTE_ENV_CHOICES[input] };
  }

  if (REMOTE_ENV_NAMES_BY_CHOICE[input]) {
    return { name: REMOTE_ENV_NAMES_BY_CHOICE[input], choice: input };
  }

  throw new Error(
    `Invalid target environment: ${raw}. Use one of prod, staging, dev, demo, cazelabs (or choices 1-5).`
  );
}

function ensureFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function listCsvFiles(outputDir) {
  if (!fs.existsSync(outputDir)) return [];
  const entries = fs.readdirSync(outputDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
    .map((entry) => {
      const fullPath = path.join(outputDir, entry.name);
      const stat = fs.statSync(fullPath);
      return { path: fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function resolveCsvPath(requestedPath, outputDir) {
  if (requestedPath) {
    const absolutePath = path.resolve(requestedPath);
    ensureFileExists(absolutePath, "CSV file");
    return absolutePath;
  }

  const csvFiles = listCsvFiles(outputDir);
  if (csvFiles.length === 0) {
    throw new Error(`No CSV files found in ${outputDir}. Run UI automation first.`);
  }
  return csvFiles[0].path;
}

function parseCsv(text) {
  const rows = [];
  let currentRow = [];
  let currentField = "";
  let inQuotes = false;

  const commitField = () => {
    currentRow.push(currentField);
    currentField = "";
  };

  const commitRow = () => {
    const nonEmpty = currentRow.some((value) => String(value).trim() !== "");
    if (nonEmpty) rows.push(currentRow);
    currentRow = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === "\"") {
        if (next === "\"") {
          currentField += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
      continue;
    }

    if (ch === "\"") {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      commitField();
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      commitField();
      commitRow();
      if (ch === "\r" && next === "\n") i += 1;
      continue;
    }

    currentField += ch;
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    commitField();
    commitRow();
  }

  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => String(header).trim());
  const dataRows = rows.slice(1);

  return dataRows.map((cells) => {
    const record = {};
    for (let i = 0; i < headers.length; i += 1) {
      record[headers[i]] = cells[i] !== undefined ? cells[i] : "";
    }
    return record;
  });
}

function isTruthyCell(value) {
  const text = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "y"].includes(text);
}

function sanitizeTsvCell(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\t/g, " ")
    .replace(/\r?\n/g, " ");
}

function buildTsv(rows, columns, includeHeader) {
  const lines = [];
  if (includeHeader) {
    lines.push(columns.join("\t"));
  }

  for (const row of rows) {
    const line = columns.map((column) => sanitizeTsvCell(row[column])).join("\t");
    lines.push(line);
  }

  return `${lines.join("\n")}\n`;
}

function runCommand(command, args, options = {}) {
  const { cwd, dryRun = false, captureOutput = false } = options;
  const rendered = `${command} ${args.join(" ")}`.trim();
  console.log(`$ ${rendered}`);

  if (dryRun) {
    return { status: 0, stdout: "", stderr: "" };
  }

  const result = spawnSync(command, args, {
    cwd,
    stdio: captureOutput ? "pipe" : "inherit",
    encoding: "utf8",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const suffix = stderr ? `\n${stderr}` : "";
    throw new Error(`Command failed (${result.status}): ${rendered}${suffix}`);
  }

  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function replacePlaceholder(text, placeholder, value) {
  return String(text).split(placeholder).join(value);
}

function normalizeRemotePath(raw) {
  return String(raw || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function buildRemoteEncryptCommand(remoteScriptPath, envChoice, decryptKey) {
  const safeScriptPath = normalizeRemotePath(remoteScriptPath);
  const scriptDir = path.posix.dirname(safeScriptPath);
  const scriptFile = path.posix.basename(safeScriptPath);
  const decryptExport = decryptKey
    ? `export EMAIL_POOL_DECRYPT_KEY_BASE64=${shellQuote(decryptKey)}; `
    : "";

  return `cd ${shellQuote(scriptDir)} && ${decryptExport}printf '%s\\n' ${shellQuote(
    envChoice
  )} | bash ${shellQuote(scriptFile)}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    console.log(`Usage:
  node scripts/publish-enc.js [options]

Options:
  --csv <path>                    Specific CSV file (default: latest file in web/output)
  --output-dir <path>             Directory containing CSV files (default: web/output)
  --users-tsv <path>              Generated TSV path (default: users.tsv)
  --columns <csv-columns>         TSV columns from CSV (default: email,app_password)
  --with-header <true|false>      Include TSV header (default: false)
  --only-success <true|false>     Keep only SUCCESS rows with app password (default: true)
  --target-env <env|choice>       prod|staging|dev|demo|cazelabs or 1-5 (default: dev)
  --remote-host <host>            SSH/SCP host alias (default: 247)
  --remote-db-repo <path>         Remote db-mgmt repo path (default: ~/Hire-Sense-Backend-Team/repo-csv/db-mgmt)
  --remote-tsv <path>             Remote TSV path (default: <remote-db-repo>/scripts/user_email_pool.tsv)
  --remote-script <path>          Remote script path (default: <remote-db-repo>/scripts/encrypt_email_pool.sh)
  --remote-enc <path>             Remote ENC path (default: <remote-db-repo>/email-pool/user_email.<env>.enc)
  --decrypt-key-base64 <value>    Optional decrypt key exported remotely before script run
  --local-enc <path>              Local temporary ENC path (default: user_email.<env>.enc)
  --db-repo <path>                Absolute or relative path to db-mgmt repo (required)
  --db-enc-path <path>            ENC target path inside db-mgmt repo (default: email-pool/user_email.<env>.enc)
  --git-user-name <name>          Git user.name for db-mgmt commit (default: automation-bot)
  --git-user-email <email>        Git user.email for db-mgmt commit (default: automation@company.com)
  --commit-message <message>      Commit message (default: chore: update ENC (<UTC timestamp>))
  --no-push                       Skip git push
  --dry-run                       Print commands without executing SSH/SCP/Git side effects
`);
    process.exit(0);
  }

  const dryRun = parseBoolean(args["dry-run"] || process.env.DRY_RUN, false);
  const outputDir = path.resolve(envOrArg(args, "output-dir", "OUTPUT_DIR", DEFAULT_OUTPUT_DIR));
  const csvPath = resolveCsvPath(envOrArg(args, "csv", "CSV_PATH", ""), outputDir);
  const usersTsvPath = path.resolve(envOrArg(args, "users-tsv", "USERS_TSV_PATH", DEFAULT_USERS_TSV_PATH));
  const columns = parseColumns(envOrArg(args, "columns", "USERS_TSV_COLUMNS", "email,app_password"));
  const includeHeader = parseBoolean(envOrArg(args, "with-header", "USERS_TSV_WITH_HEADER", "false"), false);
  const onlySuccess = parseBoolean(envOrArg(args, "only-success", "ONLY_SUCCESS_ROWS", "true"), true);
  const targetEnv = normalizeTargetEnv(envOrArg(args, "target-env", "TARGET_ENV", "dev"));

  if (columns.length === 0) {
    throw new Error("At least one TSV column is required. Use --columns.");
  }

  const remoteHost = envOrArg(args, "remote-host", "REMOTE_HOST", "247");
  const remoteDbRepoPath = normalizeRemotePath(
    envOrArg(args, "remote-db-repo", "REMOTE_DB_MGMT_PATH", "~/Hire-Sense-Backend-Team/repo-csv/db-mgmt")
  );
  const remoteTsvPath = normalizeRemotePath(
    envOrArg(args, "remote-tsv", "REMOTE_TSV_PATH", `${remoteDbRepoPath}/scripts/user_email_pool.tsv`)
  );
  const remoteScriptPath = normalizeRemotePath(
    envOrArg(args, "remote-script", "REMOTE_SCRIPT_PATH", `${remoteDbRepoPath}/scripts/encrypt_email_pool.sh`)
  );
  const remoteEncPath = normalizeRemotePath(
    envOrArg(
      args,
      "remote-enc",
      "REMOTE_ENC_PATH",
      `${remoteDbRepoPath}/email-pool/user_email.${targetEnv.name}.enc`
    )
  );
  const localEncPath = path.resolve(
    envOrArg(
      args,
      "local-enc",
      "LOCAL_ENC_PATH",
      path.join(ROOT_DIR, `user_email.${targetEnv.name}.enc`)
    )
  );
  const decryptKey = envOrArg(args, "decrypt-key-base64", "EMAIL_POOL_DECRYPT_KEY_BASE64", "");
  const remoteEncryptCommand = buildRemoteEncryptCommand(remoteScriptPath, targetEnv.choice, decryptKey);

  const dbRepoPathRaw = envOrArg(args, "db-repo", "DB_MGMT_REPO_PATH", "");
  const dbEncRelativePath = envOrArg(
    args,
    "db-enc-path",
    "DB_MGMT_ENC_RELATIVE_PATH",
    `email-pool/user_email.${targetEnv.name}.enc`
  );
  const dbRepoPath = dbRepoPathRaw ? path.resolve(dbRepoPathRaw) : "";

  if (!dbRepoPath) {
    throw new Error("Missing db-mgmt repository path. Use --db-repo or DB_MGMT_REPO_PATH.");
  }
  if (!fs.existsSync(dbRepoPath)) {
    throw new Error(`db-mgmt repo path not found: ${dbRepoPath}`);
  }

  const gitUserName = envOrArg(args, "git-user-name", "GIT_USER_NAME", "automation-bot");
  const gitUserEmail = envOrArg(args, "git-user-email", "GIT_USER_EMAIL", "automation@company.com");
  const pushEnabled = !args["no-push"] && parseBoolean(envOrArg(args, "git-push", "GIT_PUSH", "true"), true);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const commitMessage = envOrArg(
    args,
    "commit-message",
    "COMMIT_MESSAGE",
    `chore: update user_email.${targetEnv.name}.enc (${now})`
  );

  console.log("Step 1/6: generate users.tsv from workflow CSV");
  console.log(`CSV source: ${csvPath}`);
  console.log(`TSV output: ${usersTsvPath}`);
  const csvRaw = fs.readFileSync(csvPath, "utf8");
  const csvRows = parseCsv(csvRaw);
  if (csvRows.length === 0) {
    throw new Error(`CSV has no rows: ${csvPath}`);
  }

  const missingColumns = columns.filter((column) => !(column in csvRows[0]));
  if (missingColumns.length > 0) {
    throw new Error(`Missing columns in CSV: ${missingColumns.join(", ")}`);
  }

  const filteredRows = csvRows.filter((row) => {
    if (!onlySuccess) return true;
    return String(row.status || "").toUpperCase() === "SUCCESS" && isTruthyCell(row.app_password_generated) && String(row.app_password || "").trim() !== "";
  });

  if (filteredRows.length === 0) {
    throw new Error("No eligible rows for users.tsv after filtering.");
  }

  fs.mkdirSync(path.dirname(usersTsvPath), { recursive: true });
  fs.writeFileSync(usersTsvPath, buildTsv(filteredRows, columns, includeHeader), "utf8");
  console.log(`Generated users.tsv with ${filteredRows.length} row(s).`);

  console.log("Step 2/6: copy users.tsv to remote host");
  runCommand("scp", [usersTsvPath, `${remoteHost}:${remoteTsvPath}`], { dryRun });

  console.log("Step 3/6: run remote ENC generation script");
  runCommand("ssh", [remoteHost, remoteEncryptCommand], { dryRun });

  console.log("Step 4/6: fetch generated ENC file");
  fs.mkdirSync(path.dirname(localEncPath), { recursive: true });
  runCommand("scp", [`${remoteHost}:${remoteEncPath}`, localEncPath], { dryRun });

  console.log("Step 5/6: copy ENC into db-mgmt repo");
  const dbEncAbsolutePath = path.resolve(dbRepoPath, dbEncRelativePath);
  if (!dbEncAbsolutePath.startsWith(dbRepoPath)) {
    throw new Error(`db ENC path escapes db repo: ${dbEncAbsolutePath}`);
  }

  if (!dryRun) {
    ensureFileExists(localEncPath, "Fetched ENC file");
    fs.mkdirSync(path.dirname(dbEncAbsolutePath), { recursive: true });
    fs.copyFileSync(localEncPath, dbEncAbsolutePath);
  }
  console.log(`ENC target in db-mgmt: ${dbEncAbsolutePath}`);

  console.log("Step 6/6: commit and push to GitHub");
  runCommand("git", ["-C", dbRepoPath, "config", "user.name", gitUserName], { dryRun });
  runCommand("git", ["-C", dbRepoPath, "config", "user.email", gitUserEmail], { dryRun });
  runCommand("git", ["-C", dbRepoPath, "add", "--", dbEncRelativePath], { dryRun });

  if (dryRun) {
    console.log("Dry run complete. No commit/push executed.");
    return;
  }

  const status = runCommand("git", ["-C", dbRepoPath, "status", "--porcelain", "--", dbEncRelativePath], {
    captureOutput: true,
  });

  if (!status.stdout.trim()) {
    console.log("No ENC changes detected in db-mgmt. Nothing to commit.");
    return;
  }

  runCommand("git", ["-C", dbRepoPath, "commit", "-m", commitMessage, "--", dbEncRelativePath]);

  if (pushEnabled) {
    runCommand("git", ["-C", dbRepoPath, "push"]);
  } else {
    console.log("Push skipped (--no-push / GIT_PUSH=false).");
  }

  console.log("Pipeline complete.");
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
