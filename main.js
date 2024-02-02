import { Octokit } from "@octokit/rest";

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

const created = `>=${before.toISOString()}`;
// console.log(created);

search:
while (true) {
    const runs = await octokit.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflowId,
        per_page: 100,
        created,
    });

    // console.log(JSON.stringify(runs.data));

    for (const run of runs.data.workflow_runs) {
        const jobs = await octokit.actions.listJobsForWorkflowRun({
            owner,
            repo,
            run_id: run.id,
        });

        // console.log(JSON.stringify(jobs.data));

        for (const job of jobs.data.jobs) {
            for (const step of job.steps ?? []) {
                if (step.name.includes(uuid)) {
                    console.log("Found it!", run.html_url);
                    break search;
                }
            }
        }
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
}
