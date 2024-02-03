import { Octokit } from "@octokit/rest";
import prettyMilliseconds from "pretty-ms";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const octokit = new Octokit({ auth: GITHUB_TOKEN });

const owner = "jakebailey";
const repo = "workflow-trigger-testing";

/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} workflowId
 * @param {Record<string, unknown>} inputs
 */
async function startGitHubWorkflow(workflowId, inputs) {
    await octokit.actions.createWorkflowDispatch({
        owner,
        repo,
        ref: "main",
        workflow_id: workflowId,
        inputs: inputs,
    });
}

/**
 * @param {string} projectId
 * @param {number} pipelineId
 * @param {Record<string, string>} _inputs
 */
async function startPipelineRun(projectId, pipelineId, _inputs) {
    await sleep(300);
    return `https://example.com/${projectId}/${pipelineId}`;
}

/**
 * @typedef {{ kind: "unresolvedGitHub"; distinctId: string }} UnresolvedGitHubRun
 * @typedef {{ kind: "resolved"; url: string }} ResolvedRun
 * @typedef {UnresolvedGitHubRun | ResolvedRun} Run
 *
 * @typedef {{ distinctId: string }} Context
 * @typedef {(context: Context) => Promise<Run>} CommandFn
 */
void 0;

/** @type {(run: Run) => run is UnresolvedGitHubRun} */
function isUnresolvedGitHubRun(run) {
    return run.kind === "unresolvedGitHub";
}

const start = Date.now();
const created = `>=${new Date(start).toISOString()}`;

/** @type {[name: string, fn: CommandFn][]} */
const commandsToRun = [
    ["do something", async (context) => {
        await startGitHubWorkflow("do-something.yml", {
            arg: "this is some info",
            distinct_id: context.distinctId,
        });
        return { kind: "unresolvedGitHub", distinctId: context.distinctId };
    }],
    ["do something else", async (context) => {
        await startGitHubWorkflow("do-something-else.yml", {
            arg: "this is some info again",
            distinct_id: context.distinctId,
        });
        return { kind: "unresolvedGitHub", distinctId: context.distinctId };
    }],
    ["do a pipeline", async (_context) => {
        const url = await startPipelineRun("my-project", 123, {});
        return { kind: "resolved", url };
    }],
];

const commentNumber = 12345678;

const firstStage = commandsToRun.map(async ([name, fn], index) => {
    const context = { distinctId: `${commentNumber}-${index}` };
    return fn(context);
});

const results = await Promise.all(firstStage);

console.table(results);

while (results.some(isUnresolvedGitHubRun)) {
    await sleep(300);

    const runsResponse = await octokit.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        created,
        exclude_pull_requests: true,
    });
    const runs = runsResponse.data.workflow_runs;

    for (let i = 0; i < results.length; i++) {
        if (isUnresolvedGitHubRun(results[i])) {
            const run = runs.find((run) => run.name?.includes(`${commentNumber}-${i}`));
            if (run) {
                results[i] = { kind: "resolved", url: run.html_url };
            }
        }
    }
}

console.table(results);
