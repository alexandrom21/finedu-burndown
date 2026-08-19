async function load() {
  const response = await fetch("./data.json?ts=" + Date.now());
  if (!response.ok) throw new Error("No se pudo cargar data.json");
  const data = await response.json();

  const parseDate = s => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };

  const formatDate = d =>
    new Intl.DateTimeFormat("es-PE", { day: "2-digit", month: "short", timeZone: "UTC" }).format(d);

  const start = parseDate(data.sprint_start);
  const end = parseDate(data.sprint_end);
  const dayMs = 86400000;
  const totalDays = Math.round((end - start) / dayMs);

  const labels = [];
  const ideal = [];
  const actual = [];

  const historyMap = new Map(data.history.map(x => [x.date, x]));
  let lastKnown = null;

  for (let i = 0; i <= totalDays; i++) {
    const date = new Date(start.getTime() + i * dayMs);
    const iso = date.toISOString().slice(0, 10);
    labels.push(formatDate(date));

    const idealValue = Math.max(
      0,
      data.initial_scope * (1 - (totalDays === 0 ? 1 : i / totalDays))
    );
    ideal.push(Number(idealValue.toFixed(2)));

    if (historyMap.has(iso)) {
      lastKnown = historyMap.get(iso).remaining;
      actual.push(lastKnown);
    } else {
      // No inventamos datos históricos. Solo conectamos puntos que sí fueron registrados.
      actual.push(null);
    }
  }

  const latest = [...data.history].sort((a,b) => b.date.localeCompare(a.date))[0];
  if (latest) {
    document.getElementById("total").textContent = latest.total;
    document.getElementById("done").textContent = latest.done;
    document.getElementById("remaining").textContent = latest.remaining;
    const pct = latest.total ? Math.round((latest.done / latest.total) * 100) : 0;
    document.getElementById("progress").textContent = pct + "%";
  }

  document.getElementById("subtitle").textContent =
    `${data.project} · ${data.sprint_name} · ${data.sprint_start} → ${data.sprint_end}`;

  document.getElementById("updated").textContent =
    "Última actualización: " +
    new Intl.DateTimeFormat("es-PE", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Lima"
    }).format(new Date(data.updated_at));

  const ctx = document.getElementById("chart");

  new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Ideal",
          data: ideal,
          borderDash: [8, 6],
          tension: 0,
          spanGaps: false
        },
        {
          label: "Real",
          data: actual,
          tension: 0.2,
          spanGaps: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: "Trabajo restante" }
        },
        x: {
          title: { display: true, text: "Día del sprint" }
        }
      },
      plugins: {
        legend: { position: "top" },
        tooltip: { enabled: true }
      }
    }
  });
}

load().catch(err => {
  document.getElementById("error").textContent =
    "Error al cargar la gráfica:\n" + err.message;
});
