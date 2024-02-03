import { Octokit } from "@octokit/rest";
import prettyMilliseconds from "pretty-ms";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const owner = "jakebailey";
const repo = "workflow-trigger-testing";
const workflowId = "do-something.yml";

const start = Date.now();

const uuid = crypto.randomUUID();

await octokit.actions.createWorkflowDispatch({
    owner,
    repo,
    ref: "main",
    workflow_id: workflowId,
    inputs: {
        arg: "this is some info",
        distinct_id: uuid,
    },
});

/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

await sleep(300);

async function find() {
    const created = `>=${new Date(start).toISOString()}`;

    let tries = 0;

    while (true) {
        tries++;

        // const runs = await octokit.actions.listWorkflowRuns({
        //     owner,
        //     repo,
        //     workflow_id: workflowId,
        //     per_page: 100,
        //     created,
        // });

        // If we use this call, we could look for many pipelines at once.
        const runs = await octokit.actions.listWorkflowRunsForRepo({
            owner,
            repo,
            per_page: 100,
            created,
            exclude_pull_requests: true,
        });

        for (const run of runs.data.workflow_runs) {
            if (run.name?.includes(uuid)) {
                console.log("Found it!", run.html_url);
                return { run, tries };
            }
        }

        await sleep(300);
    }
}

const { run, tries } = await find();

console.log(run.html_url);
console.log(`took ${prettyMilliseconds(Date.now() - start)} using ${tries} tries.`);
