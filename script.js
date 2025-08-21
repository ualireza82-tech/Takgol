async function fetchMatches() {
  const res = await fetch('/matches');
  const data = await res.json();

  const container = document.getElementById('matches');
  container.innerHTML = '';

  data.matches.forEach(match => {
    const div = document.createElement('div');
    div.classList.add('match');
    div.innerHTML = `${match.homeTeam.name} vs ${match.awayTeam.name} — ${match.score.fullTime.homeTeam}:${match.score.fullTime.awayTeam}`;
    container.appendChild(div);
  });
}

fetchMatches();
setInterval(fetchMatches, 60000); // هر 60 ثانیه آپدیت