const token = "c68ed51ebea54a4d948cbe7b54496815";

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
    });
});

async function fetchData(endpoint, containerId) {
    const url = `https://api.football-data.org/v4/${endpoint}`;
    try {
        const response = await fetch(url, { headers: { 'X-Auth-Token': token } });
        const data = await response.json();
        document.getElementById(containerId).innerHTML = `<pre>${JSON.stringify(data, null, 2)}</pre>`;
    } catch (err) {
        document.getElementById(containerId).innerHTML = "خطا در بارگذاری داده‌ها.";
        console.error(err);
    }
}

// بارگذاری اولیه
fetchData('competitions/IRI/standings', 'leagueTable');
fetchData('competitions/IRI/matches?status=FINISHED', 'matchesResults');
fetchData('competitions/IRI/matches?status=LIVE', 'liveMatches');
fetchData('competitions/IRI/matches?status=SCHEDULED', 'upcomingMatches');