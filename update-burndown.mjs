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

/* =========================================
   OBTENER TODOS LOS ITEMS DEL PROJECT
========================================= */

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


/* =========================================
   SOLO ISSUES
========================================= */

const issues = items.filter(item =>
  item.type === "ISSUE" &&
  item.content?.createdAt
);

console.log(`Issues encontrados: ${issues.length}`);


/* =========================================
   FECHAS
========================================= */

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

  date.setUTCDate(
    date.getUTCDate() + 1
  );

  return date.toISOString().slice(0, 10);

}


/* =========================================
   ENCONTRAR PRIMER ISSUE
========================================= */

const creationDates = issues.map(issue =>
  localDate(issue.content.createdAt)
);

creationDates.sort();

const firstIssueDate = creationDates[0];

if (!firstIssueDate) {
  console.error("No existen Issues en el Project.");
  process.exit(1);
}

console.log(`Primer Issue creado: ${firstIssueDate}`);


/* =========================================
   STATUS ACTUAL
========================================= */

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


/* =========================================
   STATUS QUE TENÍA EN UNA FECHA
========================================= */

function getStatusAtDate(item, date) {

  const timeline =
    item.content?.timelineItems?.nodes || [];

  const events = timeline

    .filter(event =>
      event &&
      event.project?.number === config.project_number &&
      localDate(event.createdAt) <= date
    )

    .sort(
      (a, b) =>
        new Date(a.createdAt) -
        new Date(b.createdAt)
    );


  if (events.length > 0) {

    return events[events.length - 1].status;

  }


  /*
   Si estamos consultando hoy y no existe
   historial, usamos el estado actual.
  */

  if (date === todayLocal()) {

    return getCurrentStatus(item);

  }


  return null;
}


/* =========================================
   RECONSTRUIR BURNDOWN HISTÓRICO
========================================= */

const doneName =
  config.done_status.trim().toLowerCase();

const today = todayLocal();

let lastDate = today;


/*
Si ya terminó el Sprint, no seguimos
dibujando después de la fecha final.
*/

if (
  config.sprint_end &&
  config.sprint_end < today
) {

  lastDate = config.sprint_end;

}


const history = [];

let date = firstIssueDate;


while (date <= lastDate) {

  /*
  Issues que ya existían en ese día
  */

  const existingIssues =
    issues.filter(item =>

      localDate(
        item.content.createdAt
      ) <= date

    );


  let done = 0;


  for (const item of existingIssues) {

    const status =
      getStatusAtDate(item, date);

    if (
      (status || "")
        .trim()
        .toLowerCase() === doneName
    ) {

      done++;

    }

  }


  const total = existingIssues.length;

  const remaining =
    total - done;


  history.push({

    date,
    total,
    done,
    remaining

  });


  date = addDay(date);

}


/* =========================================
   GUARDAR DATA.JSON
========================================= */

const latest =
  history[history.length - 1];


const data = {

  project: projectTitle,

  organization:
    config.organization,

  project_number:
    config.project_number,

  sprint_name:
    config.sprint_name,

  /*
  AHORA LA GRÁFICA EMPIEZA
  DESDE EL PRIMER ISSUE
  */

  sprint_start:
    firstIssueDate,

  sprint_end:
    config.sprint_end,

  /*
  Si defines initial_scope en config.json
  se utiliza ese número.

  Si está en null, usa el total actual.
  */

  initial_scope:
    config.initial_scope ?? issues.length,

  updated_at:
    new Date().toISOString(),

  history

};


fs.writeFileSync(

  "site/data.json",

  JSON.stringify(
    data,
    null,
    2
  ) + "\n",

  "utf8"

);


console.log("");
console.log("===== BURNDOWN =====");

console.log(
  `Project: ${projectTitle}`
);

console.log(
  `Inicio histórico: ${firstIssueDate}`
);

console.log(
  `Total actual: ${latest?.total ?? 0}`
);

console.log(
  `Done: ${latest?.done ?? 0}`
);

console.log(
  `Restantes: ${latest?.remaining ?? 0}`
);
