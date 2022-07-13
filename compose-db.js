const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');

const teams = {};
const reviewers = {};
const authors = {};
const pulls = [];

const PULLS_PER_PAGE = 100;
let page_count = 1;
let last_cursor = "";

const API_REPOSITORY_ID = `owner:"godotengine" name:"godot"`;
const API_RATE_LIMIT = `
  rateLimit {
    limit
    cost
    remaining
    resetAt
  }
`;

// List of the keywords provided by https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue
const GH_MAGIC_KEYWORDS = [
    "close", "closes", "closed",
    "fix", "fixes", "fixed",
    "resolve", "resolves", "resolved",
];
const GH_MAGIC_RE = RegExp("(" + GH_MAGIC_KEYWORDS.join("|") + ") ([a-z0-9-_]+/[a-z0-9-_]+)?#([0-9]+)", "gi");
const GH_MAGIC_FULL_RE = RegExp("(" + GH_MAGIC_KEYWORDS.join("|") + ") https://github.com/([a-z0-9-_]+/[a-z0-9-_]+)/issues/([0-9]+)", "gi");

async function fetchGithub(query) {
    const init = {};
    init.method = "POST";
    init.headers = {};
    init.headers["Content-Type"] = "application/json";
    init.headers["Accept"] = "application/vnd.github.merge-info-preview+json";
    if (process.env.GITHUB_TOKEN) {
        init.headers["Authorization"] = `token ${process.env.GITHUB_TOKEN}`;
    }

    init.body = JSON.stringify({
        query,
    });

    return await fetch("https://api.github.com/graphql", init);
}

function handleErrors(data) {
    if (typeof data["errors"] === "undefined") {
        return;
    }

    console.warn(`    Server handled the request, but there were errors:`);
    data.errors.forEach((item) => {
       console.log(`    [${item.type}] ${item.message}`);
    });
}

function mapNodes(object) {
    return object.edges.map((item) => item["node"])
}

async function checkRates() {
    try {
        const query = `
        query {
          ${API_RATE_LIMIT}
        }
        `;

        const res = await fetchGithub(query);
        if (res.status !== 200) {
            console.warn(`    Failed to get the API rate limits; server responded with code ${res.status}`);
            return;
        }

        const data = await res.json();
        handleErrors(data);

        const rate_limit = data.data["rateLimit"];
        console.log(`    [$${rate_limit.cost}] Available API calls: ${rate_limit.remaining}/${rate_limit.limit}; resets at ${rate_limit.resetAt}`);
    } catch (err) {
        console.error("    Error checking the API rate limits: " + err);
        return;
    }
}

async function fetchPulls(page) {
    try {
        let after_cursor = "";
        if (last_cursor !== "") {
            after_cursor = `after: "${last_cursor}"`;
        }

        const query = `
        query {
          ${API_RATE_LIMIT}
          repository(${API_REPOSITORY_ID}) {
            pullRequests(first:${PULLS_PER_PAGE} ${after_cursor} states: OPEN) {
              totalCount
              pageInfo {
                endCursor
                hasNextPage
              }
              edges {
                node {
                  id
                  number
                  url
                  title
                  state
                  isDraft
                  mergeable
                  mergeStateStatus
                  createdAt
                  updatedAt
                  
                  bodyText
                  
                  baseRef {
                    name
                  }
                  
                  author {
                    login
                    avatarUrl
                    url
                    
                    ... on User {
                      id
                    }
                  }
                  
                  milestone {
                    id
                    title
                    url
                  }
                  
                  labels (first: 100) {
                    edges {
                      node {
                        id
                        name
                        color
                      }
                    }
                  }
                  
                  reviewRequests(first: 100) {
                    edges {
                      node {
                        id
                        requestedReviewer {
                          __typename
                        
                          ... on Team {
                            id
                            name
                            avatarUrl
                            slug
                            
                            parentTeam {
                              name
                              slug
                            }
                          }
                          
                          ... on User {
                            id
                            login
                            avatarUrl
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        `;

        let page_text = page;
        if (page_count > 1) {
            page_text = `${page}/${page_count}`;
        }
        console.log(`    Requesting page ${page_text} of pull request data.`);
        const res = await fetchGithub(query);
        if (res.status !== 200) {
            console.warn(`    Failed to get pull requests for '${API_REPOSITORY_ID}'; server responded with code ${res.status}`);
            return [];
        }

        const data = await res.json();
        handleErrors(data);

        const rate_limit = data.data["rateLimit"];
        const repository = data.data["repository"];
        const pulls_data = mapNodes(repository.pullRequests);

        console.log(`    [$${rate_limit.cost}] Retrieved ${pulls_data.length} pull requests; processing...`);

        last_cursor = repository.pullRequests.pageInfo.endCursor;
        page_count = Math.ceil(repository.pullRequests.totalCount / PULLS_PER_PAGE);

        return pulls_data;
    } catch (err) {
        console.error("    Error fetching pull request data: " + err);
        return [];
    }
}

function processPulls(pullsRaw) {
    pullsRaw.forEach((item) => {
        // Compile basic information about a PR.
        let pr = {
            "id": item.id,
            "public_id": item.number,
            "url": item.url,
            "diff_url": `${item.url}.diff`,
            "patch_url": `${item.url}.patch`,

            "title": item.title,
            "state": item.state,
            "is_draft": item.isDraft,
            "authored_by": null,
            "created_at": item.createdAt,
            "updated_at": item.updatedAt,

            "target_branch": item.baseRef.name,

            "mergeable_state": item.mergeable,
            "mergeable_reason": item.mergeStateStatus,
            "labels": [],
            "milestone": null,
            "links": [],

            "teams": [],
            "reviewers": [],
        };

        // Compose and link author information.
        const author = {
            "id": item.author.id,
            "user": item.author.login,
            "avatar": item.author.avatarUrl,
            "url": item.author.url,
            "pull_count": 0,
        };
        pr.authored_by = author.id;

        // Store the author if they haven't been stored.
        if (typeof authors[author.id] == "undefined") {
            authors[author.id] = author;
        }
        authors[author.id].pull_count++;

        // Add the milestone, if available.
        if (item.milestone) {
            pr.milestone = {
                "id": item.milestone.id,
                "title": item.milestone.title,
                "url": item.milestone.url,
            };
        }

        // Add labels, if available.
        let labels = mapNodes(item.labels);
        labels.forEach((labelItem) => {
            pr.labels.push({
                "id": labelItem.id,
                "name": labelItem.name,
                "color": "#" + labelItem.color
            });
        });
        pr.labels.sort((a, b) => {
            if (a.name > b.name) return 1;
            if (a.name < b.name) return -1;
            return 0;
        });

        // Look for linked issues in the body.
        pr.links = extractLinkedIssues(item.body);

        // Extract requested reviewers.
        let review_requests = mapNodes(item.reviewRequests).map(it => it.requestedReviewer);

        // Add teams, if available.
        let requested_teams = review_requests.filter(it => it && it["__typename"] === "Team");
        if (requested_teams.length > 0) {
            requested_teams.forEach((teamItem) => {
                const team = {
                    "id": teamItem.id,
                    "name": teamItem.name,
                    "avatar": teamItem.avatarUrl,
                    "slug": teamItem.slug,
                    "full_name": teamItem.name,
                    "full_slug": teamItem.slug,
                    "pull_count": 0,
                };
                // Include parent data into full name and slug.
                if (teamItem.parentTeam) {
                    team.full_name = `${teamItem.parentTeam.name}/${team.name}`;
                    team.full_slug = `${teamItem.parentTeam.slug}/${team.slug}`;
                }

                // Store the team if it hasn't been stored before.
                if (typeof teams[team.id] == "undefined") {
                    teams[team.id] = team;
                }
                teams[team.id].pull_count++;

                // Reference the team.
                pr.teams.push(team.id);
            });
        } else {
            // If there are no teams, use a fake "empty" team to track those PRs as well.
            const team = {
                "id": "",
                "name": "No team assigned",
                "avatar": "",
                "slug": "_",
                "full_name": "No team assigned",
                "full_slug": "_",
                "pull_count": 0,
            };

            // Store the team if it hasn't been stored before.
            if (typeof teams[team.id] == "undefined") {
                teams[team.id] = team;
            }
            teams[team.id].pull_count++;

            // Reference the team.
            pr.teams.push(team.id);
        }

        // Add individual reviewers, if available
        let requested_reviewers = review_requests.filter(it => it && it["__typename"] === "User");
        if (requested_reviewers.length > 0) {
            requested_reviewers.forEach((reviewerItem) => {
                const reviewer = {
                    "id": reviewerItem.id,
                    "name": reviewerItem.login,
                    "avatar": reviewerItem.avatarUrl,
                    "slug": reviewerItem.login,
                    "pull_count": 0,
                };

                // Store the reviewer if it hasn't been stored before.
                if (typeof reviewers[reviewer.id] == "undefined") {
                    reviewers[reviewer.id] = reviewer;
                }
                reviewers[reviewer.id].pull_count++;

                // Reference the reviewer.
                pr.reviewers.push(reviewer.id);
            });
        }

        pulls.push(pr);
    });
}

function extractLinkedIssues(pullBody) {
    const links = [];
    if (!pullBody) {
        return links;
    }

    const matches = [
        ...pullBody.matchAll(GH_MAGIC_RE),
        ...pullBody.matchAll(GH_MAGIC_FULL_RE)
    ];

    matches.forEach((item) => {
        let repository = item[2];
        if (!repository) {
            repository = "godotengine/godot";
        }

        const issue_number = item[3];
        const issue_url = `https://github.com/${repository}/issues/${issue_number}`;

        const exists = links.find((item) => {
            return item.url === issue_url
        });
        if (exists) {
            return;
        }

        let keyword = item[1].toLowerCase();
        if (keyword.startsWith("clo")) {
            keyword = "closes";
        } else if (keyword.startsWith("fix")) {
            keyword = "fixes";
        } else if (keyword.startsWith("reso")) {
            keyword = "resolves";
        }

        links.push({
            "full_match": item[0],
            "keyword": keyword,
            "repo": repository,
            "issue": issue_number,
            "url": issue_url,
        });
    });

    return links;
}

async function main() {
    console.log("[*] Building local pull request database.");

    console.log("[*] Checking the rate limits before.")
    await checkRates();

    console.log("[*] Fetching pull request data from GitHub.");
    // Pages are starting with 1 for better presentation.
    let page = 1;
    while (page <= page_count) {
        const pullsRaw = await fetchPulls(page);
        processPulls(pullsRaw);
        page++;
    }

    console.log("[*] Checking the rate limits after.")
    await checkRates();

    console.log("[*] Finalizing database.")
    const output = {
        "generated_at": Date.now(),
        "teams": teams,
        "reviewers": reviewers,
        "authors": authors,
        "pulls": pulls,
    };
    try {
        console.log("[*] Storing database to file.")
        await fs.writeFile("out/data.json", JSON.stringify(output), {encoding: "utf-8"});
    } catch (err) {
        console.error("Error saving database file: " + err);
    }
}

main();
