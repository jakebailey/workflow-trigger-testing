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
 * @typedef {"MEMBER" | "OWNER" | "COLLABORATOR"} Relationship
 * @typedef {{ fn: CommandFn; relationships: Relationship[]; prOnly: boolean }} Command
 */
void 0;

/** @type {(run: Run) => run is UnresolvedGitHubRun} */
function isUnresolvedGitHubRun(run) {
    return run.kind === "unresolvedGitHub";
}

/**
 * @param {CommandFn} fn
 * @param {Relationship[]} relationships
 * @param {boolean} prOnly
 * @returns {Command}
 */
function createCommand(fn, relationships = ["MEMBER", "OWNER", "COLLABORATOR"], prOnly = true) {
    return { fn, relationships, prOnly };
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

/** @param {{ issue: number; commentId: number; commentBody: string; isPr: boolean; commentUser: string; authorAssociation: Relationship }} request */
async function webhook(request) {
    const lines = request.commentBody.split("\n").map((line) => line.trim());

    const applicableCommands = Array.from(commands.entries()).filter(([, command]) => {
        if (!request.isPr && command.prOnly) {
            return false;
        }
        return command.relationships.includes(request.authorAssociation);
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

    const statusComment = await octokit.rest.issues.createComment({
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
        const comment = await octokit.rest.issues.getComment({
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
await webhook({
    issue: 1,
    commentId: 19250981251,
    commentBody: `
@typescript-bot do something successfully
@typescript-bot do something interesting
@typescript-bot do something failing
@typescript-bot run a pipeline
`,
    isPr: true,
    commentUser: "jakebailey",
    authorAssociation: "OWNER",
});
