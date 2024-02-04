import { createNodeMiddleware, Webhooks } from "@octokit/webhooks";
import assert from "node:assert";
import { createServer } from "node:http";
import { Octokit } from "octokit";
import prettyMilliseconds from "pretty-ms";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const GITHUB_BOT_TOKEN = process.env.GITHUB_BOT_TOKEN;
const botOctokit = new Octokit({ auth: GITHUB_BOT_TOKEN });

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
 * @param {{ distinct_id: string; issue_number: string; status_comment_id: string }} info
 * @param {Record<string, string>} inputs
 */
async function startGitHubWorkflow(workflowId, info, inputs) {
    await octokit.rest.actions.createWorkflowDispatch({
        owner,
        repo,
        ref: "main",
        workflow_id: workflowId,
        inputs: {
            ...info,
            ...inputs,
        },
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
 * @typedef {{
 *     match: RegExpMatchArray;
 *     distinctId: string;
 *     issueNumber: number;
 *     requestingUser: string;
 *     statusCommentId: number;
 * }} Context
 * @typedef {(context: Context) => Promise<Run>} CommandFn
 * @typedef {{ fn: CommandFn; authorAssociations: import("@octokit/webhooks-types").AuthorAssociation[]; prOnly: boolean }} Command
 */
void 0;

/** @type {(run: Run) => run is UnresolvedGitHubRun} */
function isUnresolvedGitHubRun(run) {
    return run.kind === "unresolvedGitHub";
}

/**
 * @param {CommandFn} fn
 * @param {import("@octokit/webhooks-types").AuthorAssociation[]} authorAssociations
 * @param {boolean} prOnly
 * @returns {Command}
 */
function createCommand(fn, authorAssociations = ["MEMBER", "OWNER", "COLLABORATOR"], prOnly = true) {
    return { fn, authorAssociations, prOnly };
}

const commands = (/** @type {Map<RegExp, Command>} */ (new Map()))
    .set(
        /do something (successfully|interesting|failing)/,
        createCommand(async (context) => {
            const args = context.match[1];
            await startGitHubWorkflow(
                "do-something.yml",
                {
                    distinct_id: context.distinctId,
                    issue_number: `${context.issueNumber}`,
                    status_comment_id: `${context.statusCommentId}`,
                },
                {
                    args,
                },
            );
            return { kind: "unresolvedGitHub", distinctId: context.distinctId };
        }),
    )
    .set(
        /run a pipeline/,
        createCommand(async (context) => {
            const url = await startPipelineRun("my-project", 123, {});
            return { kind: "resolved", distinctId: context.distinctId, url };
        }),
    );

/**
 * @param {string} distinctId
 */
function getStatusPlaceholder(distinctId) {
    return `<!--status-${distinctId}-start-->🔄<!--status-${distinctId}-end-->`;
}

/**
 * @param {string} distinctId
 */
function getResultPlaceholder(distinctId) {
    // This string is known to other workflows/pipelines.
    return `<!--result-${distinctId}-->`;
}

const botCall = "@typescript-bot";

/** @param {{ issue: number; commentId: number; commentBody: string; isPr: boolean; commentUser: string; authorAssociation: import("@octokit/webhooks-types").AuthorAssociation }} request */
async function webhook(request) {
    console.log(request);

    const lines = request.commentBody.split("\n").map((line) => line.trim());

    const applicableCommands = Array.from(commands.entries()).filter(([, command]) => {
        if (!request.isPr && command.prOnly) {
            return false;
        }
        return command.authorAssociations.includes(request.authorAssociation);
    });

    if (applicableCommands.length === 0) {
        return;
    }

    let commandsToRun = [];

    for (let line of lines) {
        if (!line.startsWith(botCall)) {
            continue;
        }
        line = line.slice(botCall.length).trim();

        for (const [key, command] of applicableCommands) {
            const match = key.exec(line);
            if (!match) {
                continue;
            }
            commandsToRun.push({ name: line, match, fn: command.fn });
        }
    }

    if (commandsToRun.length === 0) {
        return;
    }

    const start = Date.now();
    const created = `>=${new Date(start).toISOString()}`;

    const commandInfos = commandsToRun.map((obj, index) => ({ ...obj, distinctId: `${request.commentId}-${index}` }));

    const statusCommentBody = `
Starting jobs; this comment will be updated as builds start and complete.

| Command | Status | Results |
| ------- | ------ | ------- |
${
        commandInfos.map(({ name, distinctId }) =>
            `| \`${name}\` | ${getStatusPlaceholder(distinctId)} | ${getResultPlaceholder(distinctId)} |`
        )
            .join("\n")
    }
`.trim();

    console.log(statusCommentBody);

    const statusComment = await botOctokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: request.issue,
        body: statusCommentBody,
    });

    const statusCommentNumber = statusComment.data.id;

    /** @type {Run[]} */
    const startedRuns = await Promise.all(commandInfos.map(async ({ match, fn, distinctId }) => {
        try {
            return await fn({
                match,
                distinctId,
                issueNumber: request.issue,
                statusCommentId: statusCommentNumber,
                requestingUser: request.commentUser,
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
        const comment = await botOctokit.rest.issues.getComment({
            owner,
            repo,
            comment_id: statusCommentNumber,
        });

        const originalBody = comment.data.body;
        let body = comment.data.body;
        assert(body);

        for (const run of startedRuns) {
            const toReplace = getStatusPlaceholder(run.distinctId);
            let replacement;

            switch (run.kind) {
                case "unresolvedGitHub":
                    // Do nothing
                    break;
                case "resolved":
                    replacement = `[✅ Started](${run.url})`;
                    break;
                case "error":
                    replacement = `❌ Error: ${run.error}`;
                    break;
            }

            if (replacement) {
                body = body.replace(toReplace, replacement);
            }
        }

        if (body === originalBody) {
            return;
        }

        await botOctokit.rest.issues.updateComment({
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
                const match = runs.find((candidate) => candidate.name?.includes(run.distinctId));
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
}

// Simulated comment
// await webhook({
//     issue: 1,
//     commentId: 19250981251,
//     commentBody: `
// @typescript-bot do something successfully
// @typescript-bot do something interesting
// @typescript-bot do something failing
// @typescript-bot run a pipeline
// `,
//     isPr: true,
//     commentUser: "jakebailey",
//     authorAssociation: "OWNER",
// });

const webhookSecret = process.env.WEBHOOK_SECRET;
assert(webhookSecret);
const webhooks = new Webhooks({
    secret: webhookSecret,
});

webhooks.onAny(async ({ name, payload }) => {
    console.log(name, "event received");
    const isNewComment = "action" in payload
        && (payload.action === "created" || payload.action === "submitted")
        && ("issue" in payload || "pull_request" in payload);
    if (!isNewComment) {
        return;
    }

    const comment = "comment" in payload ? payload.comment : payload.review;
    if (!comment.body) {
        return;
    }

    const isPr = !!("pull_request" in payload && payload.pull_request)
        || !!("issue" in payload && payload.issue && payload.issue.pull_request);

    const issueNumber = "issue" in payload ? payload.issue.number : payload.pull_request.number;

    await webhook({
        issue: issueNumber,
        commentId: comment.id,
        commentBody: comment.body,
        isPr,
        commentUser: comment.user.login,
        authorAssociation: comment.author_association,
    });
});

createServer(createNodeMiddleware(webhooks)).listen(3000);
