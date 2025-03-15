const express = require('express');
const axios = require('axios');
const app = express();
const port = 3000;

require('dotenv').config();
const TBA_API_KEY = process.env.blueapi;
const TBA_BASE_URL = 'https://www.thebluealliance.com/api/v3';


app.set('view engine', 'ejs');
app.use(express.static(__dirname + '/public'));
app.use(express.urlencoded({ extended: true }));

function formatMatchKey(matchKey) {
  const parts = matchKey.split('_');
  const eventPart = parts[0];
  const matchPart = parts[1];
  const year = eventPart.slice(0, 4);
  const eventCode = eventPart.slice(4);
  const formattedEvent = eventCode.charAt(0).toUpperCase() + eventCode.slice(1).toLowerCase();
  const matchType = matchPart.slice(0, 2);
  const matchDetails = matchPart.slice(2);
  const types = { 'qm': 'Qualifier', 'qf': 'Quarterfinal', 'sf': 'Semifinal', 'f1': 'Final'};
  if (['qf', 'sf', 'f'].includes(matchType) && matchDetails.includes('m')) {
    const setNumber = matchDetails.split('m')[0];
    return `${formattedEvent} ${types[matchType]} ${setNumber}`;
  }
  return `${formattedEvent} ${types[matchType] || matchType} ${matchDetails}`;
}

function calculateMedian(scores) {
  if (!scores.length) return 0;
  const sorted = scores.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

app.get('/review/:teamNumber', async (req, res) => {
  const teamNumber = req.params.teamNumber;
  const teamKey = `frc${teamNumber}`;
  const selectedYear = req.query.year || new Date().getFullYear();
  const previousYear = selectedYear - 1;
  const currentDate = new Date();

  try {
    const [yearsResponse, matchesCurrentYearResponse, eventsResponse] = await Promise.all([
      axios.get(`${TBA_BASE_URL}/team/${teamKey}/years_participated`, {
        headers: { 'X-TBA-Auth-Key': TBA_API_KEY }
      }),
      axios.get(`${TBA_BASE_URL}/team/${teamKey}/matches/${selectedYear}/simple`, {
        headers: { 'X-TBA-Auth-Key': TBA_API_KEY }
      }),
      axios.get(`${TBA_BASE_URL}/team/${teamKey}/events/${selectedYear}/simple`, {
        headers: { 'X-TBA-Auth-Key': TBA_API_KEY }
      })
    ]);

    const yearsParticipated = yearsResponse.data || [];
    const allMatches = matchesCurrentYearResponse.data || [];

    const eventMap = {};
    eventsResponse.data.forEach(event => {
      eventMap[event.key] = event.name;
    });

    const teamScores = [];
    let wins = 0, losses = 0, ties = 0;
    const matchResults = [];

    for (const match of allMatches) {
      if (match.alliances.red.score === -1 || match.alliances.blue.score === -1) continue;

      const redScore = match.alliances.red.score;
      const blueScore = match.alliances.blue.score;
      const teamInRed = match.alliances.red.team_keys.includes(teamKey);
      const teamInBlue = match.alliances.blue.team_keys.includes(teamKey);

      const allianceScore = teamInRed ? redScore : blueScore;
      teamScores.push(allianceScore);

      let result = '';
      if (teamInRed) {
        if (redScore > blueScore) { wins++; result = 'Win'; }
        else if (redScore < blueScore) { losses++; result = 'Loss'; }
        else { ties++; result = 'Tie'; }
      } else if (teamInBlue) {
        if (blueScore > redScore) { wins++; result = 'Win'; }
        else if (blueScore < redScore) { losses++; result = 'Loss'; }
        else { ties++; result = 'Tie'; }
      }

      matchResults.push({
        event: eventMap[match.event_key] || "Unknown Event",
        matchKey: formatMatchKey(match.key),
        redScore,
        blueScore,
        result,
        alliance: teamInRed ? 'Red' : 'Blue'
      });
    }

    const teamMedianPoints = calculateMedian(teamScores);
    const totalMatches = wins + losses + ties;
    const winPercentage = totalMatches > 0 ? ((wins / totalMatches) * 100).toFixed(2) + '%' : 'N/A';

    matchResults.sort((a, b) => {
      if (a.event === b.event) return a.matchKey.localeCompare(b.matchKey);
      return a.event.localeCompare(b.event);
    });

    const futureMatches = allMatches.filter(match => {
      const matchTime = new Date(match.predicted_time * 1000 || match.time * 1000 || Infinity);
      return matchTime > currentDate && match.alliances.red.score === -1 && match.alliances.blue.score === -1;
    });

    const teamMedianCache = {};

    const getTeamMedian = async (team) => {
      if (teamMedianCache[team]) return teamMedianCache[team];

      const teamMatchesResponse = await axios.get(
        `${TBA_BASE_URL}/team/${team}/matches/${selectedYear}/simple`,
        { headers: { 'X-TBA-Auth-Key': TBA_API_KEY } }
      );

      const scores = teamMatchesResponse.data
        .filter(m => m.alliances.red.score !== -1 && m.alliances.blue.score !== -1)
        .map(m => m.alliances.red.team_keys.includes(team) ? m.alliances.red.score : m.alliances.blue.score);

      const median = calculateMedian(scores);
      teamMedianCache[team] = median;
      return median;
    };

    const predictions = await Promise.all(futureMatches.slice(0, 5).map(async (match) => {
      const redTeams = match.alliances.red.team_keys;
      const blueTeams = match.alliances.blue.team_keys;

      const redMedians = await Promise.all(redTeams.map(getTeamMedian));
      const blueMedians = await Promise.all(blueTeams.map(getTeamMedian));

      const redAllianceMedian = calculateMedian(redMedians);
      const blueAllianceMedian = calculateMedian(blueMedians);
      const predictedWinner = redAllianceMedian > blueAllianceMedian ? 'Red' : 'Blue';

      return {
        matchKey: formatMatchKey(match.key),
        redTeams: redTeams.join(', '),
        blueTeams: blueTeams.join(', '),
        redMedian: redAllianceMedian.toFixed(2),
        blueMedian: blueAllianceMedian.toFixed(2),
        predictedWinner
      };
    }));

    res.render('review', {
      teamNumber,
      year: selectedYear,
      yearsParticipated,
      message: allMatches.length === 0 ? `No matches found for Team ${teamNumber} in ${selectedYear}.` : null,
      teamMedianPoints: teamMedianPoints.toFixed(2),
      wins,
      losses,
      ties,
      winPercentage,
      matches: matchResults,
      predictions
    });
  } catch (error) {
    console.error(error);
    res.render('review', {
      teamNumber,
      year: selectedYear,
      yearsParticipated: [],
      message: 'Error fetching data from The Blue Alliance.',
      teamMedianPoints: null,
      winPercentage: null,
      matches: [],
      predictions: []
    });
  }
});


app.get('/predictor', (req, res) => {
  res.render('predictor', { 
    prediction: null,
    error: null
  });
});

app.post('/predictor', async (req, res) => {
  try {
    const { red1, red2, red3, blue1, blue2, blue3 } = req.body;
    const redTeams = [red1, red2, red3].map(num => `frc${num}`);
    const blueTeams = [blue1, blue2, blue3].map(num => `frc${num}`);
    const year = new Date().getFullYear();

    const getTeamMedian = async (team) => {
      const teamMatches = await axios.get(
        `${TBA_BASE_URL}/team/${team}/matches/${year}/simple`,
        { headers: { 'X-TBA-Auth-Key': TBA_API_KEY } }
      );
      const scores = teamMatches.data
        .filter(m => m.alliances.red.score !== -1 && m.alliances.blue.score !== -1)
        .map(m => m.alliances.red.team_keys.includes(team) ? m.alliances.red.score : m.alliances.blue.score);
      return calculateMedian(scores);
    };

    const redMedians = await Promise.all(redTeams.map(getTeamMedian));
    const blueMedians = await Promise.all(blueTeams.map(getTeamMedian));

    const redAllianceMedian = calculateMedian(redMedians);
    const blueAllianceMedian = calculateMedian(blueMedians);
    const predictedWinner = redAllianceMedian > blueAllianceMedian ? 'Red' : 'Blue';
    const winProbability = Math.round((Math.max(redAllianceMedian, blueAllianceMedian) / 
      (redAllianceMedian + blueAllianceMedian)) * 100);

    const prediction = {
      redTeams: redTeams.map(t => t.replace('frc', '')),
      blueTeams: blueTeams.map(t => t.replace('frc', '')),
      redMedian: redAllianceMedian.toFixed(2),
      blueMedian: blueAllianceMedian.toFixed(2),
      predictedWinner,
      winProbability
    };

    res.render('predictor', { 
      prediction,
      error: null
    });
  } catch (error) {
    console.error(error);
    res.render('predictor', { 
      prediction: null,
      error: 'Error processing prediction. Please check team numbers and try again.'
    });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});