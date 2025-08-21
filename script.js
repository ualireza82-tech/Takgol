async function loadStandings() {
  const tbody = document.querySelector('#standings tbody');
  try {
    const res = await fetch('/standings');
    const data = await res.json();
    const tableData = data.standings[0].table; 

    tableData.forEach(team => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${team.position}</td>
        <td>${team.team.name}</td>
        <td>${team.points}</td>
        <td>${team.playedGames}</td>
        <td>${team.won}</td>
        <td>${team.draw}</td>
        <td>${team.lost}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7">Error loading data: ${err.message}</td></tr>`;
  }
}

loadStandings();