const apiURL = "https://www.thesportsdb.com/api/v1/json/1/lookuptable.php?l=4328&s=2025-2026";

async function fetchLeagueData() {
    try {
        const response = await fetch(apiURL);
        const data = await response.json();

        const tableBody = document.querySelector("#league-table tbody");
        tableBody.innerHTML = "";

        data.table.forEach(team => {
            const row = document.createElement("tr");
            row.innerHTML = `
                <td>${team.intRank}</td>
                <td>${team.strTeam}</td>
                <td>${team.intPlayed}</td>
                <td>${team.intWin}</td>
                <td>${team.intDraw}</td>
                <td>${team.intLoss}</td>
                <td>${team.intPoints}</td>
            `;
            tableBody.appendChild(row);
        });
    } catch (error) {
        console.error("Error fetching league data:", error);
        document.querySelector("#league-table tbody").innerHTML = "<tr><td colspan='7'>Failed to load data</td></tr>";
    }
}

fetchLeagueData();