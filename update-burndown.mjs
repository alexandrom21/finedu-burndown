import fs from "node:fs";

const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
const token = process.env.PROJECT_TOKEN;

if (!token) {
  console.error("ERROR: Falta el secret PROJECT_TOKEN.");
  process.exit(1);
}

const query = `
query($org: String!, $number: Int!, $after: String) {
  organization(login: $org) {
    projectV2(number: $number) {
      title

      items(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }

        nodes {
          type

          content {
            ... on Issue {
              number
              title
              createdAt

              timelineItems(
                first: 100
                itemTypes: [PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]
              ) {
                nodes {
                  ... on ProjectV2ItemStatusChangedEvent {
                    createdAt
                    previousStatus
                    status

                    project {
                      number
                    }
                  }
                }
              }
            }
          }

          fieldValues(first: 50) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name

                field {
                  ... on ProjectV2FieldCommon {
                    name
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

async function graphql(variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "finedu-burndown"
    },
    body: JSON.stringify({
      query,
      variables
    })
  });

  const body = await response.json();

  if (!response.ok || body.errors) {
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  return body.data;
}

let after = null;
let items = [];
let projectTitle = "";

do {
  const data = await graphql({
    org: config.organization,
    number: config.project_number,
    after
  });

  if (!data.organization) {
    console.error("No se pudo acceder a la organización.");
    process.exit(1);
  }

  const project = data.organization.projectV2;

  if (!project) {
    console.error("No se encontró el Project.");
    process.exit(1);
  }

  projectTitle = project.title;
  items.push(...project.items.nodes);

  after = project.items.pageInfo.hasNextPage
    ? project.items.pageInfo.endCursor
    : null;
} while (after);

const issues = items.filter(item =>
  item.type === "ISSUE" && item.content?.createdAt
);

function localDate(isoDate) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone || "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(isoDate));

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function todayLocal() {
  return localDate(new Date().toISOString());
}

function addDay(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

const creationDates = issues.map(issue => localDate(issue.content.createdAt));
creationDates.sort();
const firstIssueDate = creationDates[0];

if (!firstIssueDate) {
  console.error("No existen Issues en el Project.");
  process.exit(1);
}

function getCurrentStatus(item) {
  for (const field of item.fieldValues.nodes) {
    if (
      field?.field?.name === config.status_field &&
      typeof field?.name === "string"
    ) {
      return field.name;
    }
  }
  return null;
}

function isWithinSprint(dateString) {
  const sprintStart = config.sprint_start || firstIssueDate;
  const sprintEnd = config.sprint_end || todayLocal();
  return dateString >= sprintStart && dateString <= sprintEnd;
}

function getFirstDoneDate(item) {
  const timeline = item.content?.timelineItems?.nodes || [];
  const doneName = config.done_status.trim().toLowerCase();

  const doneEvents = timeline
    .filter(event =>
      event &&
      event.project?.number === config.project_number &&
      (event.status || "").trim().toLowerCase() === doneName
    )
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  if (doneEvents.length > 0) {
    const doneDate = localDate(doneEvents[0].createdAt);
    return isWithinSprint(doneDate) ? doneDate : null;
  }

  const currentStatus = getCurrentStatus(item);
  if ((currentStatus || "").trim().toLowerCase() === doneName) {
    const today = todayLocal();
    return isWithinSprint(today) ? today : null;
  }

  return null;
}

const today = todayLocal();
const sprintStart = config.sprint_start || firstIssueDate;
const sprintEnd = config.sprint_end || today;
const total = config.initial_scope ?? issues.length;

const history = [];
let date = sprintStart;

while (date <= sprintEnd) {
  let done = 0;

  for (const item of issues) {
    const firstDoneDate = getFirstDoneDate(item);
    if (firstDoneDate && firstDoneDate <= date) {
      done++;
    }
  }

  const doneCount = Math.min(total, done);
  const remaining = Math.max(0, total - doneCount);

  history.push({
    date,
    total,
    done: doneCount,
    remaining
  });

  date = addDay(date);
}

const latest = history[history.length - 1];

const data = {
  project: projectTitle,
  organization: config.organization,
  project_number: config.project_number,
  sprint_name: config.sprint_name,
  sprint_start: sprintStart,
  sprint_end: sprintEnd,
  initial_scope: total,
  updated_at: new Date().toISOString(),
  history
};

fs.writeFileSync(
  "site/data.json",
  JSON.stringify(data, null, 2) + "\n",
  "utf8"
);

console.log("");
console.log("===== BURNDOWN =====");
console.log(`Project: ${projectTitle}`);
console.log(`Inicio configurado: ${sprintStart}`);
console.log(`Fin configurado: ${sprintEnd}`);
console.log(`Total: ${latest?.total ?? 0}`);
console.log(`Done: ${latest?.done ?? 0}`);
console.log(`Restantes: ${latest?.remaining ?? 0}`);
