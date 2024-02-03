import assert from "node:assert";
import { Octokit } from "octokit";
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
    await octokit.rest.actions.createWorkflowDispatch({
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
 * @typedef {{ kind: "resolved"; distinctId: string; url: string }} ResolvedRun
 * @typedef {{ kind: "error"; distinctId: string; error: string }} ErrorRun
 * @typedef {UnresolvedGitHubRun | ResolvedRun | ErrorRun} Run
 *
 * @typedef {{ args: string; commentId: number; distinctId: string }} Context
 * @typedef {(context: Context) => Promise<Run>} CommandFn
 */
void 0;

/** @type {(run: Run) => run is UnresolvedGitHubRun} */
function isUnresolvedGitHubRun(run) {
    return run.kind === "unresolvedGitHub";
}

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
    ["do a pipeline", async (context) => {
        const url = await startPipelineRun("my-project", 123, {});
        return { kind: "resolved", distinctId: context.distinctId, url };
    }],
];

// Simulated comment
const requestingIssueNumber = 1;
const requestingCommentNumber = 19250981251;

const start = Date.now();
const created = `>=${new Date(start).toISOString()}`;

// Before this, choose the commands.

const commandInfos = commandsToRun.map(([name, fn], index) => {
    return {
        name,
        fn,
        distinctId: `${requestingCommentNumber}-${index}`,
    };
});

const statusCommentBody = `
Starting jobs...

| Command | Status | Results |
| ------- | ------ | ------- |
${
    commandInfos.map(({ name, distinctId }) =>
        `| ${name} | <!--status-${distinctId}--> | <!--result-${distinctId}--> |`
    )
        .join("\n")
}
`.trim();

console.log(statusCommentBody);

const statusComment = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: requestingIssueNumber,
    body: statusCommentBody,
});

const statusCommentNumber = statusComment.data.id;

/** @type {Run[]} */
const startedRuns = await Promise.all(commandInfos.map(async ({ name, fn, distinctId }) => {
    try {
        return await fn({
            args: name,
            commentId: statusCommentNumber,
            distinctId,
        });
    } catch (e) {
        // TODO: short error message
        return { kind: "error", distinctId, error: `${e}` };
    }
}));

const afterStart = Date.now();
console.log(`Started in ${prettyMilliseconds(afterStart - start)}`);

console.table(startedRuns);

async function updateComment() {
    const comment = await octokit.rest.issues.getComment({
        owner,
        repo,
        comment_id: statusCommentNumber,
    });

    let body = comment.data.body;
    assert(body);

    for (const run of startedRuns) {
        const toReplace = `<!--status-${run.distinctId}-->`;
        let replacement;

        switch (run.kind) {
            case "unresolvedGitHub":
                // Do nothing
                break;
            case "resolved":
                replacement = `[started](${run.url})`;
                break;
            case "error":
                replacement = `error: ${run.error}`;
                break;
        }

        if (replacement) {
            body = body.replace(toReplace, replacement);
        }
    }

    await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: statusCommentNumber,
        body,
    });
}

await updateComment();
console.log("Updated comment with build links");

while (startedRuns.some(isUnresolvedGitHubRun)) {
    await sleep(300);

    const response = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        created,
        exclude_pull_requests: true,
    });
    const runs = response.data.workflow_runs;

    for (const [i, run] of startedRuns.entries()) {
        if (isUnresolvedGitHubRun(run)) {
            const match = runs.find((candidate) => candidate.name?.includes(`${requestingCommentNumber}-${i}`));
            if (match) {
                startedRuns[i] = { kind: "resolved", distinctId: run.distinctId, url: match.html_url };
            }
        }
    }
}

const afterFind = Date.now();
console.log(`Found in ${prettyMilliseconds(afterFind - afterStart)}`);
console.table(startedRuns);

await updateComment();
console.log("Updated comment with build links");
