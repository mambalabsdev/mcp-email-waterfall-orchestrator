#!/usr/bin/env node
/**
 * THIN APIFY API CLIENT. Nothing else belongs in this file.
 *
 * This wrapper carries exactly three things: the tool name, the input schema
 * that mirrors the actor's own public input schema, and the HTTP call to the
 * Apify API. It holds NO waterfall logic, NO chain order, NO parsing rules and
 * NO provider knowledge beyond the provider names the actor's public input
 * schema already exposes to every Store visitor.
 *
 * That logic lives in a private package vendored into the actor. This
 * repository is public. Nothing from it may be copied here in any form.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// How long the actor run itself is allowed to take, in seconds. One value for
// every Mamba Labs wrapper, set 2026-10-05: start and poll exists so a long run
// survives, and a shorter limit would end the long runs it was built for. Past
// this limit the run ends TIMED-OUT and the caller is told so, with the run id.
const ACTOR_RUN_TIMEOUT_SECS = 1800;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it whatever
// the timeout parameter says, so a long run reads as a timeout even though the
// actor goes on to finish. Starting the run, polling it to a terminal status and
// then reading the dataset is the only way to wait as long as the actor needs.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success. Surfacing it here is what keeps a crashed run from reading
  // as "no results found".
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-email-waterfall-orchestrator",
  version: pkg.version,
});

const contactShape = z
  .object({
    full_name: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    company_domain: z.string().optional(),
    company_name: z.string().optional(),
    linkedin_url: z.string().optional(),
    email: z.string().optional(),
  })
  .passthrough();

// Work Email Waterfall (immutable actor ID OT6xqTFThC0Rjf7Zj)
server.registerTool(
  "find_work_email",
  {
    title: "Find Work Email",
    description:
      "Find a work email address for each contact by running a chain of finder providers on YOUR OWN provider API keys, verify each result, and return real per-provider spend attribution instead of an opaque credit count. This is bring your own key: Mamba Labs supplies no provider keys, never sees your credits, and the run spends from your accounts, so set maxProviderUnits. Supply contacts as an array of objects, each carrying any of full_name, first_name, last_name, company_domain, company_name, linkedin_url and email. More identifiers means a better chance of a hit. Supply your keys in providerKeys by provider name. Every key is validated for free before any paid call, and a provider with no usable key is dropped from the chain and reported rather than failing the run; with no keys at all the run still completes, explains what was unavailable and charges nothing. Verification runs after each finder that returns an address, not once at the end. Every contact gets a row including misses, so you can see what was attempted, and a final summary row carries the run totals and spend. Returns flat Clay-ready JSON. Requires an APIFY_TOKEN and consumes Apify credits per contact submitted and per address found, on top of whatever your own provider keys spend.",
    annotations: {
      title: "Find Work Email",
      // Not read only: the run calls paid finder and verifier endpoints on the
      // caller's own provider accounts and spends their credits.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      // Optional, because the actor's own input schema marks nothing required
      // and defaults contacts to []. Requiring it here made the actor's own
      // prefill input invalid at the tool boundary: the wrapper could not be
      // smoke-called at all in the M1 audit for exactly this reason.
      contacts: z
        .array(contactShape)
        .optional()
        .describe("One object per person. Each may carry full_name, first_name, last_name, company_domain, company_name, linkedin_url and email. A single contact is an array of one. Omit it or pass an empty array and the run returns a summary row explaining that nothing was attempted and nothing was charged."),
      providerKeys: z
        .record(z.string())
        .optional()
        .describe("YOUR own provider API keys, keyed by provider name. Validated for free before any paid call. A provider with no usable key is dropped and reported rather than failing the run."),
      providerOrder: z
        .array(z.string())
        .optional()
        .describe("Registry entry ids in the order you want them called. Leave empty for the actor's default order."),
      verificationOrder: z
        .array(z.string())
        .optional()
        .describe("Verifier entry ids in order. Leave empty for the actor's default order."),
      maxContacts: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Hard ceiling on how many contacts are processed. Leave empty for no ceiling."),
      maxProviderUnits: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Run-level cap on the provider credits this run may consume from YOUR accounts. When it is reached the remaining contacts are skipped with a reason rather than spent on. Strongly recommended."),
      providerRates: z
        .record(z.number())
        .optional()
        .describe("Optional map of provider or provider.endpoint to YOUR cost per unit, for example {\"findymail.search_name\": 0.0198}. Supply it and the run reports dollars at your rate; leave it empty and it reports units only, because your plan tier is not knowable from here."),
      concurrencyHint: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Advisory only. Real pacing comes from each endpoint's own documented rate limits, which are multi-window and per endpoint, so this cannot exceed them."),
    },
  },
  async ({ contacts, providerKeys, providerOrder, verificationOrder, maxContacts, maxProviderUnits, providerRates, concurrencyHint }) => {
    // No local rejection of an empty or absent contacts list. Measured
    // 2026-08-13 against the live actor with its own prefill input: it returns
    // a summary row naming what was unavailable and states that nothing was
    // called and nothing was charged. That answer is more useful than the
    // wrapper refusing to make the call, and it is the actor's answer to give.
    return runActor(
      "OT6xqTFThC0Rjf7Zj",
      "Work Email Waterfall",
      compact({
        contacts,
        providerKeys,
        providerOrder,
        verificationOrder,
        maxContacts,
        maxProviderUnits,
        providerRates,
        concurrencyHint,
      }),
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
