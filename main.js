import { Octokit } from "@octokit/rest";
import prettyMilliseconds from "pretty-ms";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const owner = "jakebailey";
const repo = "workflow-trigger-testing";
const workflowId = "do-something.yml";

const before = new Date();

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

async function find() {
    const created = `>=${before.toISOString()}`;

    let tries = 0;

    while (true) {
        tries++;

        const runs = await octokit.actions.listWorkflowRuns({
            owner,
            repo,
            workflow_id: workflowId,
            per_page: 100,
            created,
        });

        for (const run of runs.data.workflow_runs) {
            if (run.name?.includes(uuid)) {
                console.log("Found it!", run.html_url);
                return { run, tries };
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}

const { run, tries } = await find();

console.log(run.html_url);
console.log(`took ${prettyMilliseconds(Date.now() - before.getUTCMilliseconds())} using ${tries} tries.`);
