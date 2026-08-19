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
}`;

async function graphql(variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "finedu-burndown"
    },
    body: JSON.stringify({ query, variables })
  });

  const body = await res.json();

  if (!res.ok || body.errors) {
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
    console.error("ERROR: No se pudo acceder a la organización.");
    process.exit(1);
  }

  const project = data.organization.projectV2;
  if (!project) {
    console.error("ERROR: No se encontró el Project indicado o el token no tiene acceso.");
    process.exit(1);
  }

  projectTitle = project.title;
  items.push(...project.items.nodes);
  after = project.items.pageInfo.hasNextPage
    ? project.items.pageInfo.endCursor
    : null;
} while (after);

function getStatus(item) {
  for (const value of item.fieldValues.nodes) {
    if (
      value?.field?.name === config.status_field &&
      typeof value?.name === "string"
    ) {
      return value.name;
    }
  }
  return null;
}

const doneName = config.done_status.trim().toLowerCase();
const total = items.length;
const done = items.filter(item => (getStatus(item) ?? "").trim().toLowerCase() === doneName).length;
const remaining = total - done;

function localDateString(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

const today = localDateString(config.timezone || "America/Lima");
const dataPath = "site/data.json";

let data = {
  project: projectTitle,
  organization: config.organization,
  project_number: config.project_number,
  sprint_name: config.sprint_name,
  sprint_start: config.sprint_start,
  sprint_end: config.sprint_end,
  initial_scope: config.initial_scope,
  updated_at: null,
  history: []
};

if (fs.existsSync(dataPath)) {
  try {
    const previous = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    if (Array.isArray(previous.history)) {
      data.history = previous.history;
    }
    if (previous.initial_scope != null && data.initial_scope == null) {
      data.initial_scope = previous.initial_scope;
    }
  } catch {
    console.warn("Aviso: no se pudo leer el data.json anterior; se recreará.");
  }
}

if (data.initial_scope == null) {
  data.initial_scope = total;
}

const snapshot = { date: today, total, done, remaining };
const existing = data.history.findIndex(x => x.date === today);

if (existing >= 0) {
  data.history[existing] = snapshot;
} else {
  data.history.push(snapshot);
}

data.history.sort((a, b) => a.date.localeCompare(b.date));
data.project = projectTitle;
data.organization = config.organization;
data.project_number = config.project_number;
data.sprint_name = config.sprint_name;
data.sprint_start = config.sprint_start;
data.sprint_end = config.sprint_end;
data.updated_at = new Date().toISOString();

fs.writeFileSync(dataPath, JSON.stringify(data, null, 2) + "\n", "utf8");

console.log(`Project: ${projectTitle}`);
console.log(`Total: ${total}`);
console.log(`Done: ${done}`);
console.log(`Restantes: ${remaining}`);
console.log(`Snapshot: ${today}`);
