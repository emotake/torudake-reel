import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const API_ROOT = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const POLICY_KEYS = new Set([
  "alert_type",
  "enabled",
  "mechanisms",
  "name",
  "alert_interval",
  "description",
  "filters",
]);

export function buildExternalObservabilityPlan() {
  return {
    externalMutation: false,
    pagesLogs: {
      status: "manual_stream_only",
      action: "Use Pages deployment tail or the deployment Functions log view during an incident.",
    },
    deploymentAlerts: {
      status: "not_applied",
      action: "Inspect eligible Cloudflare alert types, then explicitly apply a reviewed policy file.",
    },
    serverErrors: {
      status: "not_applied",
      action: "Run the independent /api/health synthetic probe every five minutes and alert after two failures.",
    },
    stripe: {
      status: "not_applied",
      action: "Enable failed webhook delivery notifications in Stripe Workbench.",
    },
  };
}

function parseArguments(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    if (["--inspect", "--apply"].includes(argument)) {
      flags.add(argument);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value.`);
    }
    values.set(argument, value);
    index += 1;
  }
  return { flags, values };
}

function credentials() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character lowercase hex account ID.");
  }
  if (token.length < 20) {
    throw new Error("CLOUDFLARE_API_TOKEN is required and must come from the secret store.");
  }
  return { accountId, token };
}

async function cloudflareRequest({ accountId, token }, pathname, init = {}) {
  const response = await fetch(`${API_ROOT}/accounts/${accountId}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) {
    const code = payload?.errors?.[0]?.code ?? response.status;
    throw new Error(`Cloudflare API request failed (code=${code}).`);
  }
  return payload.result;
}

function flattenAvailableAlerts(result) {
  if (!result || typeof result !== "object") return [];
  return Object.values(result)
    .flatMap((items) => (Array.isArray(items) ? items : []))
    .filter((item) => item && typeof item.type === "string");
}

export function validateAlertPolicy(policy, eligibleTypes) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("Policy JSON must be an object.");
  }
  for (const key of Object.keys(policy)) {
    if (!POLICY_KEYS.has(key)) throw new Error(`Unsupported policy key: ${key}`);
  }
  if (typeof policy.name !== "string" || policy.name.trim().length < 8) {
    throw new Error("Policy name must contain at least 8 characters.");
  }
  if (typeof policy.alert_type !== "string" || !eligibleTypes.has(policy.alert_type)) {
    throw new Error("Policy alert_type is not eligible for this Cloudflare account.");
  }
  if (typeof policy.enabled !== "boolean") {
    throw new Error("Policy enabled must be true or false.");
  }
  const mechanisms = policy.mechanisms;
  const destinations = mechanisms && typeof mechanisms === "object"
    ? Object.values(mechanisms).flatMap((items) => (Array.isArray(items) ? items : []))
    : [];
  if (
    destinations.length === 0 ||
    destinations.some(
      (destination) =>
        !destination ||
        typeof destination.id !== "string" ||
        destination.id.length < 3 ||
        /replace|example/i.test(destination.id),
    )
  ) {
    throw new Error("Policy needs at least one real email, webhook, or PagerDuty destination.");
  }
  return policy;
}

async function inspectExternalState(auth) {
  const [availableResult, existingPolicies] = await Promise.all([
    cloudflareRequest(auth, "/alerting/v3/available_alerts"),
    cloudflareRequest(auth, "/alerting/v3/policies"),
  ]);
  const available = flattenAvailableAlerts(availableResult);
  return {
    eligibleAlertTypes: available.map((item) => ({
      type: item.type,
      displayName: item.display_name,
      filterOptions: item.filter_options,
    })),
    existingPolicies: (Array.isArray(existingPolicies) ? existingPolicies : []).map(
      (policy) => ({ id: policy.id, name: policy.name, alertType: policy.alert_type }),
    ),
  };
}

async function main() {
  const { flags, values } = parseArguments(process.argv.slice(2));
  if (!flags.has("--inspect") && !flags.has("--apply")) {
    console.log(JSON.stringify(buildExternalObservabilityPlan(), null, 2));
    return;
  }

  const auth = credentials();
  const state = await inspectExternalState(auth);
  if (!flags.has("--apply")) {
    console.log(JSON.stringify({ externalMutation: false, ...state }, null, 2));
    return;
  }

  const confirmation = values.get("--confirm-account") ?? "";
  if (confirmation !== auth.accountId) {
    throw new Error("--apply requires --confirm-account matching CLOUDFLARE_ACCOUNT_ID.");
  }
  const policyFile = path.resolve(values.get("--policy-file") ?? "");
  if (!/^D:\\/iu.test(policyFile)) {
    throw new Error("The reviewed policy file must be an explicit path on drive D:.");
  }
  const policy = validateAlertPolicy(
    JSON.parse(await readFile(policyFile, "utf8")),
    new Set(state.eligibleAlertTypes.map((item) => item.type)),
  );
  if (state.existingPolicies.some((item) => item.name === policy.name)) {
    throw new Error("A policy with this name already exists; refusing a duplicate or implicit update.");
  }

  const result = await cloudflareRequest(auth, "/alerting/v3/policies", {
    method: "POST",
    body: JSON.stringify(policy),
  });
  console.log(JSON.stringify({ created: true, id: result?.id, name: policy.name }));
}

if (process.argv[1]?.endsWith("configure-cloudflare-alerts.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

